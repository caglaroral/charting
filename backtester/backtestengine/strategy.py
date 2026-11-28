"""
Strategy definition of the Python backtest engine: plain dicts (JSON, picklable, storable in ClickHouse) that turn
into (a) boolean signal arrays here and (b) the Node engine's strategy JSON (to_engine), so a strategy found by the
search can be re-run in the app's own engine.

    operand  {'ind': 'rsi', 'p': [14], 'f': None, 'tf': '4h', 'sh': 0}   candle[sh].rsi_4h(14)
             {'px': 'close', 'sh': 1}                                    candle[1].close
             {'const': 30}                                               30
    cond     {'op': '<' | '>', 'a': operand, 'b': operand}
             {'op': 'xup' | 'xdn', 'a': operand, 'b': operand}           candle.crossover(a, b) / crossunder
    exit     {'k': 'pct', 'v': 0.02}                                     entry.open * (1 -/+ v)
             {'k': 'atr', 'm': 2, 'p': 14}                               entry.open -/+ entry[1].atr(p) * m  (fixed at the signal candle;
                                                                         'tf': '15m' reads entry[1].atr_15m(p), also for lvl)
             {'k': 'cond', 'c': [cond, ...]}                             exit at the next open when all are true
             {'k': 'lvl', 'a': operand, 'm': 3, 'p': 22, 'floor': 0.03}  Math.max(entry.open * 0.97, <a> - candle.atr(p) * m)
                                                                         a trailing level (re-evaluated on every candle);
                                                                         m / floor optional, + and min above the price
    side     {'entry': [cond, ...], 'stop': exit, 'tp': exit}
    strategy {'tf': '15m', 'long': side | None, 'short': side | None}

Frame holds one window [start, end] (end inclusive, like the Node engine's fetchCandlesticks) of one symbol, with two
warm-up modes:
  warmup='full' (default, used by the search): indicators are computed on the whole gap-free history before the
      window (the way TradingView does), once per process, and cached (series_cache below).
  warmup='node': reproduces the Node engine exactly: the strategy timeframe gets 256 candles of warm-up before start,
      a higher timeframe 256 of its own candles before the first loaded candle (rounded down to that timeframe), and
      indicators are computed on these slices only. Long recursive indicators (ema(200), adx, atr(100)) are then not
      converged and depend on the start date (TODO, engine). Used by tests/ppo/parity.
In both modes a higher-timeframe value is seen by the strategy candle that closes together with or after it
(lookahead_off), a window needs 256 candles of the same gap-free segment before start, and a window that contains
a data gap is not run (the Node engine stops with "Data gap").
"""
import os
from collections import OrderedDict

import numpy as np

from . import data, indicators

WARM = 256
_SERIES_MB = int(os.environ.get('LOCKDOWN_PPO_SERIES_MB', 400))


class _SeriesCache:
    """Per-process LRU of full-history indicator series, bounded in MB."""

    def __init__(self, mb):
        self.limit, self.used, self.d = mb * 2**20, 0, OrderedDict()

    def get(self, key, make):
        if key in self.d:
            self.d.move_to_end(key)
            return self.d[key]
        v = make()
        self.d[key] = v
        self.used += v.nbytes
        while self.used > self.limit and len(self.d) > 1:
            _, old = self.d.popitem(last=False)
            self.used -= old.nbytes
        return v


series_cache = _SeriesCache(_SERIES_MB)
_HTF_VALUES = {}    # higher-timeframe indicator values per (symbol, tf, segment, indicator)
_ALIGN = {}         # higher-timeframe -> strategy-timeframe index map per (symbol, tfs, segments)


def reset_caches():
    """Forget cached series: their keys name a symbol and segment, not the candles, so they are only valid for one
    candle provider (data.use calls this)."""
    series_cache.d.clear()
    series_cache.used = 0
    _HTF_VALUES.clear()
    _ALIGN.clear()


def _segment(c, i):
    """[a, b) of the gap-free segment of Candles c that contains index i."""
    for a, b in c.segments():
        if a <= i < b:
            return a, b
    return i, i


def _shift(s, sh):
    return np.r_[np.full(sh, np.nan), s[:-sh]] if sh else s


class Frame:
    def __init__(self, symbol, tf, start_ms, end_ms, warmup='full', warm=WARM):
        """warm: candles of the same gap-free segment required before start. The screener passes 1: in 'full' mode the
        indicators run on the whole segment anyway, and a value without enough history is NaN (false)."""
        base = data.load(symbol, tf)
        i0 = int(np.searchsorted(base.ts, start_ms))
        i1 = int(np.searchsorted(base.ts, end_ms, side='right'))
        self.symbol, self.tf, self.warmup, self._cache, self._htf = base.symbol, tf, warmup, {}, {}
        a, b = _segment(base, i0) if i0 < len(base) else (0, 0)
        self.ok = i1 > i0 and a <= i0 - warm and i1 <= b
        self.c = base.slice(max(i0 - warm, 0), i1)
        self.first = warm if self.ok else None          # index of the first candle inside the window
        self._base, self._lo, self._seg = base, max(i0 - warm, 0), a

    def _htf_candles(self, tf):
        """Node mode: the higher-timeframe candles the Node engine loads for this window."""
        if tf not in self._htf:
            ms = data.TF_MS[tf]
            full = data.load(self.symbol, tf)
            lo = self.c.ts[0] // ms * ms - WARM * ms
            a = int(np.searchsorted(full.ts, lo))
            b = int(np.searchsorted(full.ts, self.c.ts[-1], side='right'))
            self._htf[tf] = full.slice(a, b)
        return self._htf[tf]

    def _full(self, o):
        """Full-history series of an unshifted indicator operand on its own timeframe, aligned to the base candles
        of the whole segment; cached per process."""
        tf = o.get('tf') or self.tf
        key = (self.symbol, self.tf, self._seg, tf, o['ind'], tuple(o['p']), o.get('f'))

        def make():
            base = self._base
            a = self._seg
            b = _segment(base, a)[1]
            seg = base.slice(a, b)
            if tf == self.tf:
                return indicators.compute(o['ind'], o['p'], seg, o.get('f'))
            h = data.load(self.symbol, tf)
            # the higher-timeframe segment that holds the base segment's end; values before it stay NaN
            ha, hb = _segment(h, int(np.searchsorted(h.ts, seg.ts[-1], side='right')) - 1)
            vkey = (self.symbol, tf, ha, o['ind'], tuple(o['p']), o.get('f'))
            if vkey not in _HTF_VALUES:              # small (a 4h series is ~10k values), kept for the process
                _HTF_VALUES[vkey] = indicators.compute(o['ind'], o['p'], h.slice(ha, hb), o.get('f'))
            v = _HTF_VALUES[vkey]
            akey = (self.symbol, self.tf, a, tf, ha)
            if akey not in _ALIGN:                   # depends only on the candles, not on the indicator
                hs_ts = h.ts[ha:hb]
                idx = np.searchsorted(hs_ts + data.TF_MS[tf], seg.ts + data.TF_MS[self.tf], side='right') - 1
                _ALIGN[akey] = (np.clip(idx, 0, None), idx >= 0)
            idx, ok = _ALIGN[akey]
            return np.where(ok, v[idx], np.nan)
        return series_cache.get(key, make)

    def series(self, o):
        if 'const' in o:
            return np.full(len(self.c), float(o['const']))
        k = repr(o)
        if k not in self._cache:
            sh = o.get('sh', 0)
            if 'px' in o:
                s = _shift(getattr(self.c, o['px']).astype(float), sh)
            elif self.warmup == 'full':
                full = _shift(self._full(o), sh)
                s = full[self._lo - self._seg: self._lo - self._seg + len(self.c)]
            elif o.get('tf') and o['tf'] != self.tf:
                h = self._htf_candles(o['tf'])
                v = indicators.compute(o['ind'], o['p'], h, o.get('f'))
                hm, lm = data.TF_MS[o['tf']], data.TF_MS[self.tf]
                idx = np.searchsorted(h.ts + hm, self.c.ts + lm, side='right') - 1
                s = _shift(np.where(idx >= 0, v[np.clip(idx, 0, None)], np.nan), sh)
            else:
                s = _shift(indicators.compute(o['ind'], o['p'], self.c, o.get('f')), sh)
            self._cache[k] = s
        return self._cache[k]

    def cond(self, c):
        a, b = self.series(c['a']), self.series(c['b'])
        with np.errstate(invalid='ignore'):
            if c['op'] == '<':
                return a < b
            if c['op'] == '>':
                return a > b
            up = c['op'] == 'xup'
            x, y = (a, b) if up else (b, a)
            out = np.zeros(len(a), bool)
            out[1:] = (x[:-1] < y[:-1]) & (x[1:] > y[1:])
            return out

    def all_of(self, conds):
        return np.logical_and.reduce([self.cond(c) for c in conds]) if conds else np.zeros(len(self.c), bool)


# ------------------------------------------------------------------ Node engine export
def js_operand(o):
    if 'const' in o:
        return repr(float(o['const'])) if not float(o['const']).is_integer() else str(int(o['const']))
    pre = f"candle[{o['sh']}]" if o.get('sh') else 'candle'
    if 'px' in o:
        return f"{pre}.{o['px']}"
    name = f"{o['ind']}_{o['f']}" if o.get('f') else o['ind']
    if o.get('tf'):
        name += f"_{o['tf']}"
    return f"{pre}.{name}({','.join(indicators.fmt_param(p) for p in o['p'])})"


def js_cond(c):
    a, b = js_operand(c['a']), js_operand(c['b'])
    if c['op'] in ('<', '>'):
        return f'{a} {c["op"]} {b}'
    return f"candle.{'crossover' if c['op'] == 'xup' else 'crossunder'}({a}, {b})"


def _atr(e):
    """atr(p), or atr_<tf>(p) for an exit whose ATR is read on another timeframe ('tf')."""
    return f"atr_{e['tf']}({e['p']})" if e.get('tf') else f"atr({e['p']})"


def js_exit(e, side, kind):
    up = side == 'long'
    if e is None:
        return None
    if e['k'] == 'pct':
        f = 1 - e['v'] if (kind == 'stop') == up else 1 + e['v']
        return f'entry.open * {f!r}'
    if e['k'] == 'atr':
        sign = '-' if (kind == 'stop') == up else '+'
        return f"entry.open {sign} entry[1].{_atr(e)} * {e['m']!r}"
    if e['k'] == 'cond':
        return ' && '.join(js_cond(c) for c in e['c'])
    if e['k'] == 'lvl':
        below = (kind == 'stop') == up
        lvl = js_operand(e['a'])
        if e.get('m'):
            lvl += f" {'-' if below else '+'} candle.{_atr(e)} * {e['m']!r}"
        if e.get('floor'):
            f = 1 - e['floor'] if below else 1 + e['floor']
            lvl = f"Math.{'max' if below else 'min'}(entry.open * {f!r}, {lvl})"
        return lvl
    raise ValueError(e)


def to_engine(s, symbol):
    out = {'coinpair': symbol if symbol.endswith('.P') else symbol + '.P', 'timeframe': s['tf'],
           'useFixedPositionSize': True, 'initialAmount': 1000}
    for side in ('long', 'short'):
        sd = s.get(side)
        if sd:
            out[f'{side}Condition'] = ' && '.join(js_cond(c) for c in sd['entry'])
            for kind, field in (('stop', 'Stop'), ('tp', 'TakeProfit')):
                js = js_exit(sd.get(kind), side, kind)
                if js:
                    out[f'{side}{field}'] = js
    return out


def from_engine(js):
    """Node engine strategy JSON -> Python engine strategy (backtestengine.expr)."""
    from . import expr
    return expr.from_engine(js)

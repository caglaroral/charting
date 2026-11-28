"""
Node engine strategy JSON in the Python engine: from_engine() takes the app's strategy JSON (longCondition,
shortCondition, longStop, longTakeProfit, shortStop, shortTakeProfit, timeframe, coinpair) and runner.run executes
it with the Node engine's rules (backend/strategyEvaluator.js, backend/backtest.js).

The expressions are not run per candle like in Node: each one is parsed once into a tree and evaluated on whole
arrays (numpy), so a condition costs a few array operations over all candles.

Supported expression language (what the strategy files use):
    candle.close / open / high / low / volume, bare close / open / ... (same as candle.close)
    candle.<indicator>[_<field>][_<tf>](params)     candle.rsi(14), candle.macd_histogram_4h(12, 26, 9),
                                                     candle.supertrend_trend(10, 3, "hl2") (a string parameter)
    candle.close_1h, candle.volume_4h                higher-timeframe prices
    candle[n].<...>                                  n candles back (candle[0] is the candle itself)
    candle.crossover(a, b), candle.crossunder(a, b)  a[prev] < b[prev] && a[now] > b[now] (mirrored)
    entry.open (the fill), entry.<...>, entry[n].<...> (entry[1] = the signal candle)   in exits only
    numbers, + - * / %, < <= > >= == != === !==, && || !, ternary ?:, parentheses, Math.abs / min / max / ...
Indicators are those of backtestengine.indicators (parity-checked against Node); any other name raises
UnsupportedExpression with the name, before anything runs.

Exits follow backtest.js:
  - an exit expression that yields a boolean is a condition: true at a candle's close exits at the next open,
    checked from the entry candle's close on; a condition stop comes before a condition take-profit;
  - one that yields a number is a price level, re-evaluated on every candle with `candle` = the last closed candle
    and `entry` = the entry candle (so `candle.sma(50)` trails and `entry.open * 0.98` stays fixed); a level that
    cannot be computed keeps its last value; levels are checked against high/low, the stop wins when one candle
    touches both, a candle opening beyond a level fills at its open;
  - a level is active on the entry candle itself only when it is known at the fill (isKnownAtEntryOpen: it reads
    no entry value other than entry.open);
  - stop exits fill stopSlippageRate worse; a position still open at the end is dropped.
Known difference: while an indicator has no value yet, Node reads it as null, which JavaScript compares as 0
(`null < 50` is true); here it is NaN and every comparison is false. With full warm-up this does not occur.
"""
import re

import numpy as np

from . import indicators, sim
from .strategy import Frame

PRICES = ('open', 'high', 'low', 'close', 'volume')
TFS = ('1m', '5m', '15m', '30m', '1h', '4h', '1d')
MATH = {'abs': np.abs, 'min': np.minimum, 'max': np.maximum, 'sqrt': np.sqrt, 'log': np.log, 'exp': np.exp,
        'floor': np.floor, 'ceil': np.ceil, 'round': lambda x: np.floor(np.asarray(x, float) + 0.5), 'pow': np.power,
        'sign': np.sign}
# backend/strategyEvaluator.js isKnownAtEntryOpen
_NOT_AT_OPEN = re.compile(r'\bentry\s*(\[\s*0\s*\])?\s*\.\s*(?!open\b)[A-Za-z_$]')


class UnsupportedExpression(ValueError):
    pass


# ------------------------------------------------------------------ parsing
_TOKEN = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?|([A-Za-z_$][\w$]*)|('[^']*'|\"[^\"]*\")"
                    r"|(===|!==|==|!=|<=|>=|&&|\|\||[-+*/%<>!?:.,()\[\]]))")


def _tokens(text):
    out, pos = [], 0
    text = text.rstrip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m or m.end() == pos:
            raise UnsupportedExpression(f'cannot read {text[pos:pos + 20]!r} in {text!r}')
        if m.group(1) is not None:
            out.append(('num', float(m.group(1) + (m.group(2) or ''))))
        elif m.group(3) is not None:
            out.append(('id', m.group(3)))
        elif m.group(4) is not None:
            out.append(('str', m.group(4)[1:-1]))
        else:
            out.append(('op', m.group(5)))
        pos = m.end()
    out.append(('end', None))
    return out


_BINARY = {'||': 1, '&&': 2, '==': 3, '!=': 3, '===': 3, '!==': 3, '<': 4, '>': 4, '<=': 4, '>=': 4,
           '+': 5, '-': 5, '*': 6, '/': 6, '%': 6}


class _Parser:
    """Pratt parser for the JavaScript expression subset above. Produces a generic tree that _resolve turns into
    engine nodes."""

    def __init__(self, text):
        self.text, self.t, self.i = text, _tokens(text), 0

    def peek(self):
        return self.t[self.i]

    def take(self, kind=None, value=None):
        tok = self.t[self.i]
        if (kind and tok[0] != kind) or (value is not None and tok[1] != value):
            raise UnsupportedExpression(f'expected {value or kind}, got {tok[1]!r} in {self.text!r}')
        self.i += 1
        return tok

    def parse(self):
        e = self.expr(0)
        self.take('end')
        return e

    def expr(self, min_prec):
        left = self.unary()
        while True:
            kind, v = self.peek()
            if kind == 'op' and v == '?' and min_prec == 0:
                self.take()
                a = self.expr(0)
                self.take('op', ':')
                b = self.expr(0)
                left = ('?', left, a, b)
                continue
            if kind != 'op' or v not in _BINARY or _BINARY[v] < min_prec:
                return left
            self.take()
            right = self.expr(_BINARY[v] + 1)
            left = ('bin', v, left, right)

    def unary(self):
        kind, v = self.peek()
        if kind == 'op' and v in ('!', '-', '+'):
            self.take()
            return ('un', v, self.unary())
        return self.postfix(self.primary())

    def primary(self):
        kind, v = self.take()
        if kind == 'num':
            return ('num', v)
        if kind == 'str':
            return ('str', v)
        if kind == 'id':
            return ('id', v)
        if kind == 'op' and v == '(':
            e = self.expr(0)
            self.take('op', ')')
            return e
        raise UnsupportedExpression(f'unexpected {v!r} in {self.text!r}')

    def postfix(self, e):
        while True:
            kind, v = self.peek()
            if kind == 'op' and v == '.':
                self.take()
                e = ('member', e, self.take('id')[1])
            elif kind == 'op' and v == '[':
                self.take()
                k = self.expr(0)
                self.take('op', ']')
                e = ('index', e, k)
            elif kind == 'op' and v == '(':
                self.take()
                args = []
                if self.peek() != ('op', ')'):
                    args.append(self.expr(0))
                    while self.peek() == ('op', ','):
                        self.take()
                        args.append(self.expr(0))
                self.take('op', ')')
                e = ('call', e, args)
            else:
                return e


# Engine nodes:
#   ('num', v) | ('ser', operand, shift) | ('ent', operand, shift) | ('x', a, b, +1/-1) | ('math', f, [args])
#   ('bin', op, l, r) | ('un', op, x) | ('?', c, a, b)
def _const(node, text):
    if node[0] == 'num':
        return node[1]
    if node[0] == 'un' and node[1] == '-' and node[2][0] == 'num':
        return -node[2][1]
    raise UnsupportedExpression(f'indicator parameters and candle[n] must be numbers in {text!r}')


def _num(v):
    return int(v) if float(v).is_integer() else float(v)


def _operand(name, args, strategy_tf, text):
    """Indicator / price operand from a Node member name and its call arguments (None when not called)."""
    tf = None
    m = re.match(r'^(.*)_(\d+[mhd])$', name)
    if m:
        name, tf = m.group(1), m.group(2)
        if tf not in TFS:
            raise UnsupportedExpression(f'timeframe {tf} in {text!r}: only {TFS}')
        if tf == strategy_tf:
            tf = None
    if args is None:
        if name in PRICES:
            return {'px': name} if tf is None else {'ind': 'price', 'p': [], 'f': name, 'tf': tf}
        raise UnsupportedExpression(f'candle.{name} is not a price; indicators are called: candle.{name}(...) in {text!r}')
    base, _, field = name.partition('_')
    if base not in indicators.DEFAULTS or base == 'price':
        raise UnsupportedExpression(f'indicator {base!r} is not in the Python engine (has: '
                                    f'{", ".join(k for k in indicators.DEFAULTS if k != "price")}) in {text!r}')
    fields = indicators.FIELDS.get(base)
    if fields and field not in fields:
        raise UnsupportedExpression(f'{base} needs a field ({", ".join(fields)}): {name} in {text!r}')
    if not fields and field:
        raise UnsupportedExpression(f'{base} has no field {field!r} in {text!r}')
    p = [a if isinstance(a, str) else _num(a) for a in args] or list(indicators.DEFAULTS[base])
    try:
        indicators.params_of(base, p)
    except ValueError as err:
        raise UnsupportedExpression(f'{err} in {text!r}') from None
    return {'ind': base, 'p': p, 'f': field or None, 'tf': tf}


def _resolve(e, ctx):
    """Generic tree -> engine node. ctx: strategy timeframe, expression text, whether entry.* is allowed."""
    tf, text, allow_entry = ctx
    kind = e[0]
    if kind == 'num':
        return e
    if kind == 'str':
        raise UnsupportedExpression(f'string {e[1]!r} outside crossover / crossunder in {text!r}')
    if kind == 'id':
        if e[1] in PRICES:
            return ('ser', {'px': e[1]}, 0)
        if e[1] in ('true', 'false'):
            return ('num', 1.0 if e[1] == 'true' else 0.0, 'bool')
        raise UnsupportedExpression(f'unknown name {e[1]!r} in {text!r}')
    if kind == 'un':
        return ('un', e[1], _resolve(e[2], ctx))
    if kind == 'bin':
        return ('bin', e[1], _resolve(e[2], ctx), _resolve(e[3], ctx))
    if kind == '?':
        return ('?', _resolve(e[1], ctx), _resolve(e[2], ctx), _resolve(e[3], ctx))
    if kind == 'call':
        f = e[1]
        if f[0] == 'member' and f[1] == ('id', 'Math'):
            if f[2] not in MATH:
                raise UnsupportedExpression(f'Math.{f[2]} in {text!r}')
            return ('math', f[2], [_resolve(a, ctx) for a in e[2]])
        if f[0] == 'member' and f[1] == ('id', 'candle') and f[2] in ('crossover', 'crossunder'):
            if len(e[2]) != 2:
                raise UnsupportedExpression(f'{f[2]} needs exactly two arguments in {text!r}')
            args = []
            for a in e[2]:
                if a[0] == 'str':   # legacy form: candle.crossover('rsi(14)', 50)
                    s = a[1].replace(' ', '')
                    a = _Parser(s if re.fullmatch(r'-?\d+(\.\d+)?', s) else 'candle.' + s).parse()
                args.append(_resolve(a, ctx))
            return ('x', args[0], args[1], 1 if f[2] == 'crossover' else -1)
        if f[0] == 'member':
            return _ref(f[1], f[2], e[2], ctx)
        raise UnsupportedExpression(f'unsupported call in {text!r}')
    if kind == 'member':
        return _ref(e[1], e[2], None, ctx)
    raise UnsupportedExpression(f'unsupported expression in {text!r}')


def _ref(obj, name, args, ctx):
    tf, text, allow_entry = ctx
    shift = 0
    if obj[0] == 'index':
        shift = _const(obj[2], text)
        if not float(shift).is_integer() or shift < 0:
            raise UnsupportedExpression(f'candle[{shift}] in {text!r}')
        shift, obj = int(shift), obj[1]
    if obj not in (('id', 'candle'), ('id', 'entry')):
        raise UnsupportedExpression(f'unsupported reference .{name} in {text!r}')
    a = None if args is None else [x[1] if x[0] == 'str' else _const(_resolve(x, ctx), text) for x in args]
    o = _operand(name, a, tf, text)
    if obj == ('id', 'entry'):
        if not allow_entry:
            raise UnsupportedExpression(f'entry.* is only defined in exits: {text!r}')
        return ('ent', o, shift)
    return ('ser', o, shift)


def _is_bool(n):
    k = n[0]
    if k == 'num':
        return len(n) > 2
    if k == 'x':
        return True
    if k == 'un':
        return n[1] == '!'
    if k == 'bin':
        return n[1] in ('&&', '||', '==', '!=', '===', '!==', '<', '>', '<=', '>=')
    if k == '?':
        return _is_bool(n[2]) and _is_bool(n[3])
    return False


def _walk(n):
    yield n
    for c in n[1:]:
        if isinstance(c, tuple):
            yield from _walk(c)
        elif isinstance(c, list):
            for x in c:
                if isinstance(x, tuple):
                    yield from _walk(x)


class Expr:
    """One parsed expression: tree, whether it is a condition, which candles it reads."""

    def __init__(self, text, tf, allow_entry):
        self.text = text
        self.node = _resolve(_Parser(text).parse(), (tf, text, allow_entry))
        self.is_cond = _is_bool(self.node)
        nodes = list(_walk(self.node))
        self.reads_candle = any(n[0] in ('ser', 'x') for n in nodes)
        self.reads_entry = any(n[0] == 'ent' for n in nodes)
        self.known_at_open = not _NOT_AT_OPEN.search(text)
        self.operands = [n[1] for n in nodes if n[0] in ('ser', 'ent')]


# ------------------------------------------------------------------ evaluation on arrays
def _truthy(x):
    x = np.asarray(x)
    if x.dtype == bool:
        return x
    with np.errstate(invalid='ignore'):
        return (x != 0) & ~np.isnan(x)


class _Eval:
    def __init__(self, frame):
        self.fr = frame
        self.n = len(frame.c)

    def series(self, o):
        return self.fr.series(dict(o, sh=0)) if 'ind' in o else self.fr.series({'px': o['px'], 'sh': 0})

    def at(self, o, pos):
        s = self.series(o)
        ok = (pos >= 0) & (pos < self.n)
        return np.where(ok, s[np.clip(pos, 0, self.n - 1)], np.nan)

    def ev(self, n, idx, extra=0, e=None):
        """Value of node n on the candles idx (array of indices), all candle references shifted `extra` more
        candles back (crossover's previous candle); e = the entry candle index for entry.* (scalar)."""
        k = n[0]
        if k == 'num':
            return np.full(len(idx), n[1]).astype(bool) if len(n) > 2 else np.full(len(idx), n[1])
        if k == 'ser':
            return self.at(n[1], idx - n[2] - extra)
        if k == 'ent':
            v = self.at(n[1], np.array([e - n[2]]))[0]
            return np.full(len(idx), v)
        if k == 'x':
            a1, b1 = self.ev(n[1], idx, extra, e), self.ev(n[2], idx, extra, e)
            a0, b0 = self.ev(n[1], idx, extra + 1, e), self.ev(n[2], idx, extra + 1, e)
            with np.errstate(invalid='ignore'):
                return (a0 < b0) & (a1 > b1) if n[3] > 0 else (a0 > b0) & (a1 < b1)
        if k == 'un':
            x = self.ev(n[2], idx, extra, e)
            return ~_truthy(x) if n[1] == '!' else (-x.astype(float) if n[1] == '-' else x.astype(float))
        if k == '?':
            c = _truthy(self.ev(n[1], idx, extra, e))
            return np.where(c, self.ev(n[2], idx, extra, e), self.ev(n[3], idx, extra, e))
        if k == 'math':
            return MATH[n[1]](*[np.asarray(self.ev(a, idx, extra, e), float) for a in n[2]])
        op, l, r = n[1], self.ev(n[2], idx, extra, e), self.ev(n[3], idx, extra, e)
        if op == '&&':
            return _truthy(l) & _truthy(r)
        if op == '||':
            return _truthy(l) | _truthy(r)
        l, r = l.astype(float), r.astype(float)
        with np.errstate(all='ignore'):
            if op == '+': return l + r
            if op == '-': return l - r
            if op == '*': return l * r
            if op == '/': return l / r
            if op == '%': return np.fmod(l, r)
            if op == '<': return l < r
            if op == '>': return l > r
            if op == '<=': return l <= r
            if op == '>=': return l >= r
            if op in ('==', '==='): return l == r
            return l != r


# ------------------------------------------------------------------ strategy JSON
FIELDS = {'long': ('longCondition', 'longStop', 'longTakeProfit'), 'short': ('shortCondition', 'shortStop', 'shortTakeProfit')}


def from_engine(js):
    """Node engine strategy JSON (dict or JSON text) -> Python engine strategy (a plain dict runner.run accepts).
    Every expression is parsed here, so an unsupported indicator or syntax fails now with a clear message."""
    import json
    if isinstance(js, str):
        js = json.loads(js)
    tf = js.get('timeframe') or js.get('tf')
    if tf not in TFS:
        raise UnsupportedExpression(f'timeframe {tf!r}: only {TFS}')
    out = {'tf': tf, 'expr': {}, 'symbol': (js.get('coinpair') or '').replace('.P', '') or None,
           'stop_slip': float(js['stopSlippageRate']) if js.get('stopSlippageRate') is not None else sim.STOP_SLIP}
    for side, (c, s, t) in FIELDS.items():
        if js.get(c):
            out['expr'][side] = {'entry': js[c], 'stop': js.get(s) or None, 'tp': js.get(t) or None}
    if not out['expr']:
        raise UnsupportedExpression('no longCondition or shortCondition')
    if js.get('useFixedPositionSize') is False:
        out['note'] = 'useFixedPositionSize false: the Python engine always trades a fixed 1000 USDT'
    compile_(out)
    return out


_COMPILED = {}


def compile_(strategy):
    key = (strategy['tf'], repr(sorted((k, sorted(v.items())) for k, v in strategy['expr'].items())))
    if key not in _COMPILED:
        sides = {}
        for side, d in strategy['expr'].items():
            entry = Expr(d['entry'], strategy['tf'], allow_entry=False)
            if not entry.is_cond:
                raise UnsupportedExpression(f'{side} entry is not a condition: {d["entry"]!r}')
            sides[side] = {'entry': entry,
                           'stop': Expr(d['stop'], strategy['tf'], True) if d.get('stop') else None,
                           'tp': Expr(d['tp'], strategy['tf'], True) if d.get('tp') else None}
        _COMPILED[key] = sides
    return _COMPILED[key]


# ------------------------------------------------------------------ simulation
def _exit_window(ev, x, e, lo, hi):
    """Exit expression x of a position entered at candle e, for the candles j in [lo, hi): evaluated with
    candle = j - 1 and entry = e. Returns (values, is_condition)."""
    j = np.arange(lo, hi)
    if not x.reads_candle:      # entry and numbers only: the same on every candle
        v = ev.ev(x.node, j[:1] - 1, e=e)
        return np.repeat(v, len(j)), x.is_cond
    return ev.ev(x.node, j - 1, e=e), x.is_cond


def _ffill(v):
    """Each NaN takes the last finite value before it (a level that cannot be computed keeps its last value)."""
    idx = np.where(np.isfinite(v), np.arange(len(v)), -1)
    np.maximum.accumulate(idx, out=idx)
    return np.where(idx >= 0, v[np.clip(idx, 0, None)], np.nan)


def run(strategy, symbol, start_ms, end_ms, gate=None, warmup='full', signal_shift=0):
    """Same contract as runner.run, for a strategy from from_engine."""
    sides = compile_(strategy)
    fr = Frame(symbol, strategy['tf'], start_ms, end_ms, warmup)
    if not fr.ok:
        return None
    c, n, first = fr.c, len(fr.c), fr.first
    ev = _Eval(fr)
    every = np.arange(n)
    sig = {}
    for side in ('long', 'short'):
        sig[side] = _truthy(ev.ev(sides[side]['entry'].node, every)) if side in sides else np.zeros(n, bool)
    lsig, ssig = sig['long'], sig['short']
    if signal_shift:
        lsig, ssig = np.roll(lsig, signal_shift), np.roll(ssig, signal_shift)
    if gate is not None:
        lok, sok = gate(c.ts)
        lsig, ssig = lsig & lok, ssig & sok
    any_sig = lsig | ssig
    any_sig[:first] = False
    any_sig[n - 1:] = False                       # no entry candle after the last one
    cand = np.flatnonzero(any_sig)
    stop_slip = strategy.get('stop_slip', sim.STOP_SLIP)
    out = {k: [] for k in ('side', 'ei', 'xi', 'ep', 'xp')}
    k_min = first
    while True:
        p = int(np.searchsorted(cand, k_min))
        if p >= len(cand):
            break
        k = int(cand[p])
        e = k + 1
        side = 'long' if lsig[k] else 'short'
        up = side == 'long'
        sd = sides[side]
        px = float(c.open[e])
        exit_ = None
        width = 512
        while exit_ is None:
            hi = min(n, e + width)
            j = np.arange(e, hi)
            later = j > e
            no = np.zeros(len(j), bool)
            cs = ct = no
            ls_hit = lt_hit = no
            ls_lvl = lt_lvl = np.full(len(j), np.nan)
            for kind in ('stop', 'tp'):
                x = sd[kind]
                if x is None:
                    continue
                v, is_cond = _exit_window(ev, x, e, e, hi)
                if is_cond:
                    hit = later & _truthy(v)
                    if kind == 'stop':
                        cs = hit
                    else:
                        ct = hit
                    continue
                lvl = _ffill(np.asarray(v, float))
                active = later | x.known_at_open
                is_stop = kind == 'stop'
                below = up == is_stop                  # long stop / short take-profit sit below the price
                with np.errstate(invalid='ignore'):
                    hit = active & ((c.low[j] <= lvl) if below else (c.high[j] >= lvl))
                if is_stop:
                    ls_hit, ls_lvl = hit, lvl
                else:
                    lt_hit, lt_lvl = hit, lvl
            ct = ct & ~cs
            ls_hit = ls_hit & ~(cs | ct)
            lt_hit = lt_hit & ~(cs | ct | ls_hit)
            anyx = cs | ct | ls_hit | lt_hit
            if anyx.any():
                q = int(np.argmax(anyx))
                jj, o = int(j[q]), float(c.open[j[q]])
                if cs[q] or ct[q]:
                    xp, is_stop = o, bool(cs[q])
                elif ls_hit[q]:
                    xp, is_stop = (min(ls_lvl[q], o) if up else max(ls_lvl[q], o)), True
                else:
                    xp, is_stop = (max(lt_lvl[q], o) if up else min(lt_lvl[q], o)), False
                if is_stop:
                    xp = xp * (1.0 - stop_slip) if up else xp * (1.0 + stop_slip)
                exit_ = (jj, xp)
            elif hi >= n:
                break
            else:
                width *= 4
        if exit_ is None:       # still open at the end: dropped, like the Node engine
            break
        out['side'].append(1 if up else -1); out['ei'].append(e); out['xi'].append(exit_[0])
        out['ep'].append(px); out['xp'].append(exit_[1])
        k_min = exit_[0]        # a signal on the exit candle may enter at the next open
    side_a = np.array(out['side'], np.int8)
    ei, xi = np.array(out['ei'], np.int64), np.array(out['xi'], np.int64)
    ep, xp = np.array(out['ep'], float), np.array(out['xp'], float)
    return {'symbol': fr.symbol, 'side': side_a, 'entry_ts': c.ts[ei], 'exit_ts': c.ts[xi], 'entry_px': ep, 'exit_px': xp,
            'net': sim.trade_net(side_a, ep, xp)}

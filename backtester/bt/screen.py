"""Screener: the engine's entry conditions evaluated on the last closed bar of every symbol.

A row matches when all conditions hold on the last closed bar. `entered` marks a symbol that matches now but did
not on the bar before (what a screener alert reports). Values of the condition operands and of the extra columns
are read on the last closed bar.
"""
import time

import numpy as np

from backtestengine import data, regimes
from backtestengine.strategy import Frame
from . import market

REGIME_NAMES = {0: 'squeeze', 1: 'bull', -1: 'bear', 2: 'transition', regimes.UNKNOWN: None}
_regime_cache = {}   # (source key, symbol) -> (last daily bar ms, label)


def _regime(src, symbol):
    """COIN4 regime of the symbol on its last closed daily bar (squeeze / bull / bear / transition)."""
    d = data.load(symbol, '1d')
    if len(d) < 2:
        return None
    k = (src.key, symbol)
    c = _regime_cache.get(k)
    if c and c[0] == int(d.ts[-1]):
        return c[1]
    try:
        _, lab = regimes.coin4(symbol)
        v = REGIME_NAMES.get(int(lab[-1]))
    except Exception:
        v = None
    _regime_cache[k] = (int(d.ts[-1]), v)
    return v


def _finite(x):
    x = float(x)
    return x if np.isfinite(x) else None


def run(src, tf, conds, columns, symbols=None, regime=True):
    t0 = time.time()
    data.use(market.recent_provider(src))
    universe = market.recent(src, tf)
    if not universe:
        return {'time': None, 'rows': [], 'scanned': 0, 'skipped': 0, 'ms': 0}
    newest = market.reference_time({k: (c.ts,) for k, c in universe.items()})
    names = sorted(universe) if symbols is None else [s for s in symbols if s in universe]
    ops = []
    for o in [c['a'] for c in conds] + [c['b'] for c in conds] + list(columns):
        if 'const' not in o and o not in ops:
            ops.append(o)
    rows, skipped = [], 0
    for s in names:
        c = universe[s]
        i = int(np.searchsorted(c.ts, newest, side='right'))
        if i < 2 or int(c.ts[i - 1]) != newest:
            skipped += 1            # not updated to the reference bar (halted, lagging, delisted)
            continue
        c = c.slice(0, i)           # a symbol ahead of the others is read on the same bar
        fr = Frame(s, tf, int(c.ts[-2]), int(c.ts[-1]), warm=1)
        if not fr.ok:
            skipped += 1            # a gap in the last bars
            continue
        if conds:
            m = fr.all_of(conds)
            match, prev = bool(m[-1]), bool(m[-2])
        else:
            match, prev = True, True
        if not match:
            continue
        rows.append({
            'symbol': s, 'close': float(c.close[-1]),
            'chg': _finite((c.close[-1] / c.close[-2] - 1) * 100) if c.close[-2] else None,
            'entered': match and not prev,
            'values': [_finite(fr.series(o)[-1]) for o in ops],
            'regime': _regime(src, s) if regime else None,
        })
    return {'time': newest // 1000, 'rows': rows, 'operands': ops, 'scanned': len(names), 'skipped': skipped,
            'ms': int((time.time() - t0) * 1000)}

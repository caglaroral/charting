"""
Running strategies: one (strategy, symbol, window) at a time, or many in parallel on all cores.

The number of worker processes follows the free memory (MemAvailable) and is re-checked before every batch, so
freeing RAM on the machine lets the next batch use more cores. Each worker keeps its own kline cache, so a worker
costs about MB_PER_WORKER.
"""
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from . import sim
from .strategy import Frame

MB_PER_WORKER = int(os.environ.get('LOCKDOWN_PPO_MB_PER_WORKER', 700))
RESERVE_MB = int(os.environ.get('LOCKDOWN_PPO_RESERVE_MB', 1500))   # left for the OS and ClickHouse


def _ffill(v):
    """Each NaN takes the last finite value before it (a level that cannot be computed keeps its last value)."""
    idx = np.where(np.isfinite(v), np.arange(len(v)), -1)
    np.maximum.accumulate(idx, out=idx)
    return np.where(idx >= 0, v[np.clip(idx, 0, None)], np.nan)


def level_series(fr, e, below):
    """Trailing level of a 'lvl' exit on every candle: the operand, moved m ATR away from the price (down for a level
    below the price: a long stop or a short take-profit)."""
    v = fr.series(e['a']).astype(float)
    if e.get('m'):
        atr = fr.series({'ind': 'atr', 'p': [e['p']], 'tf': e.get('tf')})
        v = v - e['m'] * atr if below else v + e['m'] * atr
    return _ffill(v)


def _exit_args(fr, sd, kind, n, side):
    e = (sd or {}).get(kind)
    if not e:
        return sim.NONE, 0.0, np.zeros(n), np.zeros(n, bool)
    if e['k'] == 'pct':
        return sim.PCT, float(e['v']), np.zeros(n), np.zeros(n, bool)
    if e['k'] == 'atr':
        return sim.ATR, float(e['m']), fr.series({'ind': 'atr', 'p': [e['p']], 'tf': e.get('tf')}), np.zeros(n, bool)
    if e['k'] == 'cond':
        return sim.COND, 0.0, np.zeros(n), fr.all_of(e['c'])
    if e['k'] == 'lvl':
        below = (side == 'long') == (kind == 'stop')
        return sim.LVL, float(e.get('floor') or 0.0), level_series(fr, e, below), np.zeros(n, bool)
    raise ValueError(e)


def _trade_levels(c, side, ei, xi, ep, args):
    """Per closed trade (for display; the simulation is unchanged): the stop and take-profit levels set at the fill
    (NaN for none or a moving level), the bars held, the best and worst price move while open (run-up and
    drawdown, in price units, from the candles' high / low from the entry to the exit candle)."""
    m = len(side)
    stop, tp = np.full(m, np.nan), np.full(m, np.nan)
    run_up, draw = np.zeros(m), np.zeros(m)
    for j in range(m):
        up = side[j] > 0
        a = args[0:8] if up else args[8:16]
        k = ei[j] - 1
        for off, is_stop, out in ((0, True, stop), (4, False, tp)):
            kind, val, ser = a[off], a[off + 1], a[off + 2]
            if kind in (sim.PCT, sim.ATR):
                out[j] = sim._level(ep[j], up, is_stop, kind, val, ser[k])
        hi, lo = float(c.high[ei[j]:xi[j] + 1].max()), float(c.low[ei[j]:xi[j] + 1].min())
        run_up[j], draw[j] = (hi - ep[j], ep[j] - lo) if up else (ep[j] - lo, hi - ep[j])
    return {'stop_lvl': stop, 'tp_lvl': tp, 'bars': (xi - ei).astype(np.int64), 'run_up': run_up, 'draw': draw}


def run(strategy, symbol, start_ms, end_ms, gate=None, warmup='full', signal_shift=0):
    """Trades of one strategy on one symbol and window. gate: optional function (ts array) -> (long_ok, short_ok)
    boolean arrays, e.g. a regime filter; it is applied to the signal candles. warmup: 'full' (indicators on the whole
    history) or 'node' (the Node engine's 256-candle warm-up, for parity checks). signal_shift > 0 rolls the raw
    entry signals by that many candles before the gate (null reference). Returns None when the window cannot
    be run (not enough warm-up or a data gap: the Node engine would stop with "Data gap" too)."""
    if 'expr' in strategy:      # a Node engine strategy JSON (strategy.from_engine)
        from . import expr
        return expr.run(strategy, symbol, start_ms, end_ms, gate, warmup, signal_shift)
    fr = Frame(symbol, strategy['tf'], start_ms, end_ms, warmup)
    if not fr.ok:
        return None
    c, n = fr.c, len(fr.c)
    L, S = strategy.get('long'), strategy.get('short')
    lsig = fr.all_of(L['entry']) if L else np.zeros(n, bool)
    ssig = fr.all_of(S['entry']) if S else np.zeros(n, bool)
    if signal_shift:   # null reference: the raw signals moved later in time (circularly within the window)
        lsig, ssig = np.roll(lsig, signal_shift), np.roll(ssig, signal_shift)
    if gate is not None:
        lok, sok = gate(c.ts)
        lsig, ssig = lsig & lok, ssig & sok
    args = []
    for sd, side in ((L, 'long'), (S, 'short')):
        for kind in ('stop', 'tp'):
            args += list(_exit_args(fr, sd, kind, n, side))
    side, ei, xi, ep, xp, op = sim.simulate(c.open, c.high, c.low, fr.first, lsig, ssig, np.array([bool(L), bool(S)]),
                                        *args, sim.STOP_SLIP)
    lvl = _trade_levels(c, side, ei, xi, ep, args)
    pos = int(op[0])
    open_ = None if pos == 0 else {'side': pos, 'entry_ts': int(c.ts[int(op[1])]), 'signal_ts': int(c.ts[int(op[1]) - 1]),
                                   'entry_px': float(op[2]), 'stop': float(op[3]), 'tp': float(op[4])}
    return {'symbol': fr.symbol, 'side': side, 'entry_ts': c.ts[ei], 'exit_ts': c.ts[xi], 'entry_px': ep, 'exit_px': xp,
            'net': sim.trade_net(side, ep, xp), 'open': open_, 'last_ts': int(c.ts[-1]), 'last_close': float(c.close[-1]),
            **lvl}


def _job(args):
    strategy, symbol, start_ms, end_ms = args
    r = run(strategy, symbol, start_ms, end_ms)
    if r is None:
        return {'symbol': symbol, 'start': start_ms, 'skipped': True}
    return {'symbol': symbol, 'start': start_ms, 'trades': int(len(r['net'])), 'net': float(r['net'].sum()),
            'nets': r['net'].astype(np.float32)}


def mem_available_mb():
    with open('/proc/meminfo') as f:
        for line in f:
            if line.startswith('MemAvailable:'):
                return int(line.split()[1]) // 1024
    return 0


def workers(oversubscribe=1.0):
    """Worker count from free memory and cores; at least 1. oversubscribe > 1 runs more processes than cores, for
    callers whose workers wait part of the time (PPO steps its environments in lockstep)."""
    by_mem = (mem_available_mb() - RESERVE_MB) // MB_PER_WORKER
    return int(max(1, min(int((os.cpu_count() or 1) * oversubscribe), by_mem)))


def run_many(jobs):
    """jobs: list of (strategy, symbol, start_ms, end_ms). Runs them on as many processes as memory allows and
    returns the results in the same order."""
    n = workers()
    if n == 1 or len(jobs) < 4:
        return [_job(j) for j in jobs]
    with ProcessPoolExecutor(max_workers=n) as ex:
        return list(ex.map(_job, jobs, chunksize=max(1, len(jobs) // (n * 4))))

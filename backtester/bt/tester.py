"""Strategy tester (backtest over a window) and paper trading (the same strategy stepped on new closed bars)."""
import time

import numpy as np

from backtestengine import data, metrics, runner, sim
from . import market

MAX_BARS = 250_000          # per symbol and run


def _trades(r, size):
    net = sim.trade_net(r['side'], r['entry_px'], r['exit_px'], size) if len(r['side']) else np.zeros(0)
    return [{'side': int(s), 'entry_ts': int(a) // 1000, 'exit_ts': int(b) // 1000, 'entry_px': float(p), 'exit_px': float(q),
             'net': float(n)} for s, a, b, p, q, n in zip(r['side'], r['entry_ts'], r['exit_ts'], r['entry_px'], r['exit_px'], net)], net


def _clean(m):
    out = {}
    for k, v in m.items():
        if isinstance(v, (float, np.floating)):
            out[k] = float(v) if np.isfinite(v) else None
        elif isinstance(v, (np.integer,)):
            out[k] = int(v)
        else:
            out[k] = v
    return out


def backtest(src, strategy, symbols, start_s, end_s, size=1000.0, deadline=None):
    t0 = time.time()
    start_ms, end_ms = start_s * 1000, end_s * 1000
    sec = market.TF_SEC[strategy['tf']]
    if (end_s - start_s) / sec > MAX_BARS:
        raise ValueError(f'the window is more than {MAX_BARS:,} bars of {strategy["tf"]}; shorten it or use a higher timeframe')
    out, all_e, all_x, all_n = [], [], [], []
    for s in symbols:
        if deadline and time.time() > deadline:
            out.append({'symbol': s, 'skipped': 'time limit reached'})
            continue
        data.use(market.window_provider(src, start_ms, end_ms))
        c = data.load(s, strategy['tf'])
        if not len(c):
            out.append({'symbol': s, 'skipped': 'no data'})
            continue
        # start at the first bar that has the warm-up behind it, when the symbol was listed later
        st = max(start_ms, int(c.ts[min(len(c) - 1, 256)]))
        r = runner.run(strategy, s, st, end_ms)
        if r is None:
            out.append({'symbol': s, 'skipped': 'not enough history or a data gap in the window'})
            continue
        trades, net = _trades(r, size)
        m = metrics.compute(r['entry_ts'], r['exit_ts'], net, size, st, end_ms) if len(net) else {'net': 0.0, 'trades': 0}
        out.append({'symbol': s, 'start': st // 1000, 'metrics': _clean(m), 'trades': trades})
        all_e.append(r['entry_ts']); all_x.append(r['exit_ts']); all_n.append(net)
    total = None
    if all_n and sum(len(n) for n in all_n):
        e, x, n = np.concatenate(all_e), np.concatenate(all_x), np.concatenate(all_n)
        total = _clean(metrics.compute(e, x, n, size * len(all_n), start_ms, end_ms, symbols=len(all_n)))
    return {'symbols': out, 'total': total, 'ms': int((time.time() - t0) * 1000)}


def paper_step(src, strategy, symbols, state, start_s, size=1000.0):
    """Advance a paper-trading run. state: {symbol: [resume, last]}: resume = the first bar whose signal is not yet
    acted on (the signal bar of the open position, or the last processed bar), last = the last bar processed.
    Returns per symbol the trades closed since, the open position (marked to the last close) and the new resume
    time; 'skip' when no bar closed since the last step."""
    tf = strategy['tf']
    sec = market.TF_SEC[tf]
    data.use(market.recent_provider(src))
    universe = market.recent(src, tf)
    out = {}
    for s in symbols:
        c = universe.get(s)
        if c is None or not len(c):
            out[s] = {'status': 'no data'}
            continue
        last = int(c.ts[-1]) // 1000
        resume, done = (state.get(s) or [None, None])[:2]
        if done is not None and last <= done:
            out[s] = {'status': 'skip'}
            continue
        if resume is None:
            # the first signal bar is the first bar that closes after the run started
            resume = (start_s // sec) * sec
        if resume > last:
            out[s] = {'status': 'waiting', 'resume': resume, 'last_ts': last, 'last_close': float(c.close[-1])}
            continue
        if resume * 1000 < int(c.ts[0]) + 256 * sec * 1000:
            # fell behind the recent cache (the engine was down): read the window from ClickHouse
            data.use(market.window_provider(src, resume * 1000, last * 1000))
        r = runner.run(strategy, s, resume * 1000, last * 1000)
        data.use(market.recent_provider(src))
        if r is None:
            out[s] = {'status': 'gap', 'resume': resume, 'last_ts': last, 'last_close': float(c.close[-1])}
            continue
        trades, _ = _trades(r, size)
        op = r['open']
        if op:
            q = size / op['entry_px']
            upnl = (r['last_close'] - op['entry_px']) * q * op['side'] - (q * op['entry_px'] + q * r['last_close']) * (sim.FEE + sim.SLIP)
            op = {'side': op['side'], 'entry_ts': op['entry_ts'] // 1000, 'entry_px': op['entry_px'],
                  'stop': op['stop'] if np.isfinite(op['stop']) else None, 'tp': op['tp'] if np.isfinite(op['tp']) else None,
                  'upnl': float(upnl)}
            nxt = r['open']['signal_ts'] // 1000
        else:
            nxt = r['last_ts'] // 1000
        out[s] = {'status': 'ok', 'trades': trades, 'open': op, 'resume': nxt, 'last_ts': r['last_ts'] // 1000,
                  'last_close': r['last_close']}
    return out

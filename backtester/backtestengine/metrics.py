"""
Backtest metrics with the formulas of backend/stats.js (the app), so a strategy reads the same here and in the app.

Equity is the closed-trade equity from `initial` (net of costs, fixed position size). Per UTC day the equity after
the last trade closed that day; days without a close carry the previous value (stats.js closeByDay).

    max_dd, max_dd_pct  largest peak-to-trough fall of the trade-by-trade equity; % of the peak at that time
    sharpe, sortino     daily returns between start and end, annualised with sqrt(365); sortino divides by the
                        downside deviation over all days (population); None with fewer than two days / no variation
    ulcer               Ulcer index: sqrt(mean(drawdown_pct^2)) over the daily equity, drawdown from the running peak
                        (starting at `initial`). Depth and duration of the drawdowns: how much it hurts to run it
    martin              Martin ratio (Ulcer performance index): annualised return % (CAGR of the final equity over the
                        days of the period) / ulcer; None when ulcer is 0, the equity is wiped out or the CAGR overflows
    exposure_pct        share of the period with a position open, per symbol (the union of the trade intervals),
                        averaged over `symbols` slots: 17 coins of which one is always in a trade = 1/17
    avg_open, max_open  open positions over time across all symbols (capital in use, in positions)

Profit factor and win rate here are on net trades; stats.js computes them on gross profit (before costs).
"""
import numpy as np

DAY = 86_400_000


def _daily(exit_ts, net, initial, start_ms, end_ms):
    """Daily closing equity, stats.js closeByDay."""
    first, last = start_ms // DAY, end_ms // DAY
    n = last - first + 1
    if n <= 0:
        return np.zeros(0)
    o = np.argsort(exit_ts, kind='stable')
    eq = initial + np.cumsum(net[o])
    day = exit_ts[o] // DAY - first
    close = np.full(n, np.nan)
    ok = (day >= 0) & (day < n)
    close[day[ok]] = eq[ok]                     # the last trade of a day wins (sorted by exit)
    prev = initial
    for d in range(n):
        if np.isnan(close[d]):
            close[d] = prev
        prev = close[d]
    return close


def _union_ms(entry, exit_, lo, hi):
    if not len(entry):
        return 0
    o = np.argsort(entry)
    a, b = np.clip(entry[o], lo, hi), np.clip(exit_[o], lo, hi)
    tot, cur_a, cur_b = 0, a[0], b[0]
    for x, y in zip(a[1:], b[1:]):
        if x > cur_b:
            tot += cur_b - cur_a
            cur_a, cur_b = x, y
        else:
            cur_b = max(cur_b, y)
    return int(tot + cur_b - cur_a)


def compute(entry_ts, exit_ts, net, initial, start_ms, end_ms, symbol=None, symbols=1):
    """entry_ts / exit_ts in ms, net per trade (costs included); symbol: per-trade symbol array for exposure when the
    trades come from several symbols (then `symbols` is the number of slots, e.g. coins present)."""
    entry_ts, exit_ts = np.asarray(entry_ts, np.int64), np.asarray(exit_ts, np.int64)
    net = np.asarray(net, float)
    n = len(net)
    out = {'trades': n, 'net': round(float(net.sum()), 2)}
    if not n:
        return out
    win, loss = net[net > 0], net[net < 0]
    out.update(win_pct=round(100 * len(win) / n, 2), avg_win=round(float(win.mean()), 2) if len(win) else 0.0,
               avg_loss=round(float(-loss.mean()), 2) if len(loss) else 0.0,
               max_win=round(float(net.max()), 2), max_loss=round(float(net.min()), 2),
               profit_factor=round(float(win.sum() / -loss.sum()), 2) if len(loss) else None)
    o = np.argsort(exit_ts, kind='stable')
    eq = initial + np.cumsum(net[o])
    peak = np.maximum.accumulate(np.r_[initial, eq])[1:]
    dd = peak - eq
    k = int(np.argmax(dd))
    out.update(max_dd=round(float(dd[k]), 2), max_dd_pct=round(float(dd[k] / peak[k] * 100) if peak[k] > 0 else 0.0, 2))

    close = _daily(exit_ts, net, initial, start_ms, end_ms)
    sharpe = sortino = ulcer = martin = None
    if len(close) >= 2:
        prev = np.r_[initial, close[:-1]]
        bad = np.where(prev <= 0)[0]
        m = bad[0] if len(bad) else len(close)          # stats.js stops once the equity is wiped out
        r = close[:m] / prev[:m] - 1
        if len(r) >= 2:
            sd = r.std(ddof=1)
            down = np.sqrt(np.mean(np.minimum(r, 0) ** 2))
            sharpe = round(float(r.mean() / sd * np.sqrt(365)), 2) if sd > 0 else None
            sortino = round(float(r.mean() / down * np.sqrt(365)), 2) if down > 0 else None
    if len(close):
        pk = np.maximum.accumulate(np.r_[initial, close])[1:]
        ddp = np.where(pk > 0, (pk - close) / pk * 100, 0.0)
        ulcer = float(np.sqrt(np.mean(ddp ** 2)))
        final = close[-1]
        if ulcer > 0 and final > 0 and initial > 0:
            with np.errstate(over='ignore'):
                cagr = (np.power(final / initial, 365 / len(close)) - 1) * 100
            martin = round(float(cagr / ulcer), 2) if np.isfinite(cagr) else None   # overflow on very short periods
        ulcer = round(ulcer, 2)
    out.update(sharpe=sharpe, sortino=sortino, ulcer=ulcer, martin=martin)

    span = max(end_ms - start_ms, 1)
    if symbol is None:
        held = _union_ms(entry_ts, exit_ts, start_ms, end_ms)
    else:
        symbol = np.asarray(symbol)
        held = sum(_union_ms(entry_ts[symbol == s], exit_ts[symbol == s], start_ms, end_ms) for s in np.unique(symbol))
    out['exposure_pct'] = round(100 * held / (span * max(symbols, 1)), 2)
    ev = np.r_[np.clip(entry_ts, start_ms, end_ms), np.clip(exit_ts, start_ms, end_ms)]
    st = np.r_[np.ones(n, int), -np.ones(n, int)]
    o = np.lexsort((st, ev))                           # a close before an open at the same instant
    out['max_open'] = int(np.cumsum(st[o]).max())
    out['avg_open'] = round(held / span, 2)
    return out

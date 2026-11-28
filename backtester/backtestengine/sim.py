"""
Trade simulation of the Python backtest engine, following the Node engine (backend/backtest.js, guide §4) rule for
rule; tests/ppo/parity/parity.py checks that both give the same trades.

- A signal at candle k's close enters at candle k+1's open; one position at a time; a signal while a position is
  open is ignored, so there is no re-entry on the candle a position exits on. Long wins when both sides signal.
- Exit kinds per side: 0 none, 1 pct of the fill, 2 ATR of the signal candle, 3 condition, 4 a trailing level (a
  price series: the value at candle i-1's close applies to candle i, from the entry candle on, like backtest.js
  re-evaluates a level that reads candle.*; optionally bounded by a fixed floor at pct of the fill).
- Price levels (1, 2) are known at the fill and are checked from the entry candle on against high/low; the stop
  wins when one candle touches both; a candle opening beyond a level fills at its open.
- A condition true at a candle's close exits at the next open (checked from the entry candle's close on), before
  any level; a condition stop comes before a condition take-profit.
- Stop exits (level or condition) fill stopSlippageRate worse. A position still open at the end is not a trade; it
  is returned as the open state (side, entry index, fill price, stop, take-profit) for paper trading.
"""
import numpy as np
from numba import njit

FEE, SLIP, STOP_SLIP = 0.0005, 0.0002, 0.0008   # backend/costDefaults.js
NONE, PCT, ATR, COND, LVL = 0, 1, 2, 3, 4


@njit(cache=True)
def _level(px, up, is_stop, kind, val, atr_sig):
    # long stop / short take-profit sit below the fill, the other two above
    below = up == is_stop
    if kind == PCT:
        return px * (1.0 - val) if below else px * (1.0 + val)
    if kind == ATR:
        return px - atr_sig * val if below else px + atr_sig * val
    return np.nan


@njit(cache=True)
def _trail(v, px, up, is_stop, floor):
    # Math.max(entry.open * (1 - floor), level) for a long stop, Math.min(...) above the fill; NaN stays NaN like in JS
    if floor > 0.0 and not np.isnan(v):
        if up == is_stop:
            return max(px * (1.0 - floor), v)
        return min(px * (1.0 + floor), v)
    return v


@njit(cache=True)
def simulate(o, h, l, first, lsig, ssig, sides_on,
             lsk, lsv, lsatr, lsc, ltk, ltv, ltatr, ltc,
             ssk, ssv, ssatr, ssc, stk, stv, statr, stc, stop_slip):
    """sides_on: (long_enabled, short_enabled). *k kind, *v pct or ATR multiple (kind 4: the floor pct, 0 = none),
    *atr the ATR series for that exit (kind 4: the level series), *c the condition series (kind 3). Returns side (1 long, -1 short), entry index, exit index, entry and exit price
    of the closed trades, and the position still open at the end: [side (0 = none), entry index, fill, stop, tp]."""
    n = len(o)
    side_o = np.empty(n, np.int8); ei_o = np.empty(n, np.int64); xi_o = np.empty(n, np.int64)
    ep_o = np.empty(n); xp_o = np.empty(n)
    m = 0
    pos = 0; e = -1; px = 0.0; stop = np.nan; tp = np.nan
    # the first signal candle is the window's first candle, so the first possible entry is the open after it
    # (checked against the Node engine by tests/ppo/parity: no entry from a warm-up candle's signal)
    for i in range(first + 1, n):
        just_entered = False
        if pos == 0:
            k = i - 1
            if sides_on[0] and lsig[k]:
                pos = 1
            elif sides_on[1] and ssig[k]:
                pos = -1
            if pos != 0:
                e = i; px = o[i]; just_entered = True
                if pos == 1:
                    stop = _level(px, True, True, lsk, lsv, lsatr[k]); tp = _level(px, True, False, ltk, ltv, ltatr[k])
                else:
                    stop = _level(px, False, True, ssk, ssv, ssatr[k]); tp = _level(px, False, False, stk, stv, statr[k])
        if pos == 0:
            continue
        up = pos == 1
        if up:
            sk, tk, sc, tc, sv, tv, sa, ta = lsk, ltk, lsc, ltc, lsv, ltv, lsatr, ltatr
        else:
            sk, tk, sc, tc, sv, tv, sa, ta = ssk, stk, ssc, stc, ssv, stv, ssatr, statr
        if sk == LVL:
            stop = _trail(sa[i - 1], px, up, True, sv)
        if tk == LVL:
            tp = _trail(ta[i - 1], px, up, False, tv)
        hit_stop = False; hit_tp = False; xp = 0.0
        if not just_entered:
            if sk == COND and sc[i - 1]:
                hit_stop = True; xp = o[i]
            elif tk == COND and tc[i - 1]:
                hit_tp = True; xp = o[i]
        if not hit_stop and not hit_tp and (sk == PCT or sk == ATR or sk == LVL):
            if (up and l[i] <= stop) or ((not up) and h[i] >= stop):
                hit_stop = True; xp = min(stop, o[i]) if up else max(stop, o[i])
        if not hit_stop and not hit_tp and (tk == PCT or tk == ATR or tk == LVL):
            if (up and h[i] >= tp) or ((not up) and l[i] <= tp):
                hit_tp = True; xp = max(tp, o[i]) if up else min(tp, o[i])
        if hit_stop:
            xp = xp * (1.0 - stop_slip) if up else xp * (1.0 + stop_slip)
        if hit_stop or hit_tp:
            side_o[m] = pos; ei_o[m] = e; xi_o[m] = i; ep_o[m] = px; xp_o[m] = xp
            m += 1
            pos = 0
    open_ = np.array([float(pos), float(e if pos != 0 else -1), px if pos != 0 else np.nan,
                      stop if pos != 0 else np.nan, tp if pos != 0 else np.nan])
    return side_o[:m], ei_o[:m], xi_o[:m], ep_o[:m], xp_o[:m], open_


def trade_net(side, ep, xp, size_usdt=1000.0, fee=FEE, slip=SLIP):
    """Net profit per trade after fee and slippage on both legs, as backend/stats.js computes it."""
    qty = size_usdt / ep
    gross = (xp - ep) * qty * side
    return gross - (qty * ep + qty * xp) * (fee + slip)

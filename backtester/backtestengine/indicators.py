"""
Indicators of the Python backtest engine, named and parameterised like the Node engine
(backend/strategyTimeframe.js, backend/indicators/*.js, docs/BACKTEST_ENGINE_GUIDE.md §5):
key = '<name>[_<field>](<params>)', e.g. 'rsi(14)', 'macd_histogram(12,26,9)', 'supertrend_trend(10,3)'.

Every indicator here is checked against the Node engine by tests/ppo/parity (indicator_check.py compares the series,
parity.py / expr_check.py the trades). Add an indicator only together with such a check.

Every indicator equals the Node engine (exactly, or to float rounding of the same formula):
  - sma, ema, rsi, atr, cci, macd, bb, adx (TA-Lib), and psar, ao, obv, donchian, keltner, dpo, hma, tema, tvwema
    (ports of the Node code / the technicalindicators 3.1.0 algorithms, with the same order of float operations).
    The Node engine rounds RSI (also inside stochrsi) and MFI to 2 decimals (toFixed(2)), so this module does too.
  - where technicalindicators deviated from the standard definition, both engines use the standard one since
    2026-10-28 (Node: backend/indicators/supertrend.js, wavetrend.js, standard.js):
      supertrend  TradingView ta.supertrend: strict flips (close < lower / close > upper), the first direction is
                  down, trend is NaN until the ATR exists. Source hlc3 by default, "hl2" (TradingView) as a third
                  parameter: supertrend_trend(10, 3, "hl2").
      wavetrend   LazyBear (hlc3, esa = ema(ap, n1), d = ema(|ap - esa|, n1), ci = (ap - esa) / (0.015 d),
                  wt1 = ema(ci, n2), wt2 = sma(wt1, 4)), EMAs seeded with an SMA; a candle with d = 0 has no ci and
                  the EMA re-seeds after n values (Pine).
      mfi         a candle whose typical price equals the previous one is no flow (TA-Lib, TradingView). Rounded to
                  2 decimals.
      vwap        anchored to the UTC day (resets at 00:00 UTC, source hlc3).
      stochrsi    the true high / low of the RSI window (technicalindicators' scan stopped at an RSI of 0).
OBV is cumulative from the first candle like Node (and TradingView), so its level depends on where the series starts:
equal to Node only with warmup='node'; with full warm-up it starts at the gap-free segment and is offset by a
constant. Use it relative to itself (e.g. obv vs candle[n].obv), not against fixed levels.

Fields and units follow Node: psar trend and supertrend trend are 1 (up) / -1 (down); stochrsi fields are stochRSI
(the raw stochastic of RSI), k (its sma) and d (sma of k). Donchian includes the current candle like Node
(candle[1].donchian_upper(20) is the channel without it, which is what a breakout compares against).
Before an indicator has a value it is NaN (Node: undefined / null).
"""
from decimal import ROUND_HALF_UP, Decimal

import numpy as np
import talib
from numba import njit

DEFAULTS = {
    'sma': (20,), 'ema': (20,), 'rsi': (14,), 'atr': (14,), 'cci': (20,),
    'macd': (12, 26, 9), 'bb': (20, 2), 'adx': (14,),
    'psar': (0.02, 0.2), 'stochrsi': (14, 14, 3, 3), 'ao': (5, 34), 'mfi': (14,), 'obv': (), 'vwap': (),
    'donchian': (20,), 'keltner': (20, 2, 10), 'supertrend': (10, 3, 'hlc3'), 'wavetrend': (10, 21, 4),
    'dpo': (21, 5, 14), 'hma': (9,), 'tema': (9,), 'tvwema': (9,),
    'price': (),          # a price field on a higher timeframe (Node: candle.close_1h); field = open/high/low/close/volume
}
FIELDS = {
    'macd': ('MACD', 'signal', 'histogram'),
    'bb': ('upper', 'middle', 'lower'),
    'adx': ('adx', 'pdi', 'mdi'),
    'psar': ('value', 'trend'),
    'stochrsi': ('stochRSI', 'k', 'd'),
    'donchian': ('upper', 'middle', 'lower'),
    'keltner': ('upper', 'middle', 'lower'),
    'supertrend': ('value', 'trend', 'upper', 'lower'),
    'wavetrend': ('wt1', 'wt2'),
}
SOURCES = ('hlc3', 'hl2')   # supertrend source parameter


def fmt_param(p):
    """A parameter as the Node engine spells it: 14, 0.02, "hl2"."""
    return f'"{p}"' if isinstance(p, str) else str(p)


def key(name, params, field=None):
    """Engine spelling: key('macd', (12,26,9), 'histogram') -> 'macd_histogram(12,26,9)'."""
    base = f'{name}_{field}' if field else name
    return f"{base}({','.join(fmt_param(p) for p in params)})"


def params_of(name, params):
    """Parameters with Node's defaults for the missing trailing ones (Node: `params[0] || 14`, `[a = 21, b = 5] =
    params`); a string is only allowed as supertrend's source."""
    p = tuple(params)
    d = DEFAULTS[name]
    if len(p) > len(d):
        raise ValueError(f'{name}: at most {len(d)} parameters, got {p}')
    for k, v in enumerate(p):
        if isinstance(v, str) and not (name == 'supertrend' and k == 2 and v in SOURCES):
            raise ValueError(f'{name}: parameter {v!r} is not a number' +
                             (f' (supertrend source: {", ".join(SOURCES)})' if name == 'supertrend' else ''))
        if name == 'supertrend' and k == 2 and not isinstance(v, str):
            raise ValueError(f'supertrend source must be one of {SOURCES}, got {v!r}')
    return p + d[len(p):]


def compute(name, params, c, field=None):
    """One indicator series on Candles c (arrays aligned with c.ts)."""
    h, l, cl = c.high, c.low, c.close
    if name == 'price':
        return getattr(c, field).astype(float)
    p = params_of(name, params)
    if name == 'sma':
        return talib.SMA(cl, p[0])
    if name == 'ema':
        return talib.EMA(cl, p[0])
    if name == 'rsi':
        return np.round(talib.RSI(cl, p[0]), 2)
    if name == 'atr':
        return talib.ATR(h, l, cl, p[0])
    if name == 'cci':
        return talib.CCI(h, l, cl, p[0])
    if name == 'macd':
        out = dict(zip(FIELDS['macd'], talib.MACD(cl, *p)))
        return out[field]
    if name == 'bb':
        out = dict(zip(FIELDS['bb'], talib.BBANDS(cl, p[0], p[1], p[1], 0)))
        return out[field]
    if name == 'adx':
        return {'adx': talib.ADX, 'pdi': talib.PLUS_DI, 'mdi': talib.MINUS_DI}[field](h, l, cl, p[0])
    v = c.volume.astype(float)
    if name == 'psar':
        sar = _psar(h, l, float(p[0]), float(p[1]))
        return sar if field == 'value' else np.where(sar < cl, 1.0, -1.0)
    if name == 'stochrsi':
        return dict(zip(FIELDS['stochrsi'], _stochrsi(cl, *(int(x) for x in p))))[field]
    if name == 'ao':
        mid = (h + l) / 2
        return _node_sma(mid, int(p[0])) - _node_sma(mid, int(p[1]))
    if name == 'mfi':
        return tofixed2(_mfi(h, l, cl, v, int(p[0])))
    if name == 'obv':
        return _obv(cl, v)
    if name == 'vwap':
        return _vwap_daily(c.ts, h, l, cl, v)
    if name == 'donchian':
        n = int(p[0])
        up, lo = talib.MAX(h, n), talib.MIN(l, n)
        return {'upper': up, 'lower': lo, 'middle': (up + lo) / 2}[field]
    if name == 'keltner':
        mid = talib.EMA(cl, int(p[0]))
        atr = talib.ATR(h, l, cl, int(p[2]))
        return {'middle': mid, 'upper': mid + p[1] * atr, 'lower': mid - p[1] * atr}[field]
    if name == 'supertrend':
        src = (h + l + cl) / 3 if p[2] == 'hlc3' else (h + l) / 2
        value, trend, upper, lower = _supertrend(h, l, cl, src, int(p[0]), float(p[1]))
        return {'value': value, 'trend': trend, 'upper': upper, 'lower': lower}[field]
    if name == 'wavetrend':
        wt1, wt2 = _wavetrend(h, l, cl, int(p[0]), int(p[1]), int(p[2]))
        return wt1 if field == 'wt1' else wt2
    if name == 'dpo':
        return _dpo(h, l, cl, int(p[0]), int(p[1]), int(p[2]))
    if name == 'hma':
        return _hma(cl, int(p[0]))
    if name == 'tema':
        return _tema(cl, int(p[0]))
    if name == 'tvwema':
        return _tvwema(cl, v, int(p[0]))
    raise ValueError(f'unknown indicator {name}')


# ------------------------------------------------------------------ helpers
def tofixed2(x):
    """parseFloat(x.toFixed(2)) of JavaScript: round to 2 decimals on the exact binary value, ties away from zero
    (numpy rounds ties to even and from x * 100, so values within 1e-6 of a tie are redone exactly)."""
    x = np.asarray(x, float)
    r = np.round(x, 2)
    with np.errstate(invalid='ignore'):
        y = np.abs(x) * 100
        near = np.isfinite(x) & (np.abs(y - np.floor(y) - 0.5) < 1e-6)
    for i in np.flatnonzero(near):
        r[i] = float(Decimal(float(x[i])).quantize(Decimal('0.01'), ROUND_HALF_UP))
    return r


@njit(cache=True, error_model='numpy')
def _node_sma(x, p):
    """technicalindicators SMA: a running sum (sum - oldest + newest), NaN before p values."""
    n = len(x)
    out = np.full(n, np.nan)
    if p < 1:
        return out
    s = 0.0
    for i in range(n):
        if i < p - 1:
            s = s + x[i]
        else:
            s = s - (x[i - p] if i >= p else 0.0) + x[i]
            out[i] = s / p
    return out


@njit(cache=True, error_model='numpy')
def _psar(high, low, step, mx):
    """technicalindicators PSAR (the Node engine's psar): the first value is the first low; `furthest` is the candle
    two back, `prev` the one before."""
    n = len(high)
    out = np.full(n, np.nan)
    if n == 0:
        return out
    sar = low[0]
    extreme = high[0]
    up = True
    accel = step
    out[0] = sar
    furthest, prev = 0, 0
    for i in range(1, n):
        sar = sar + accel * (extreme - sar)
        if up:
            sar = min(sar, low[furthest], low[prev])
            if high[i] > extreme:
                extreme = high[i]
                accel = min(accel + step, mx)
        else:
            sar = max(sar, high[furthest], high[prev])
            if low[i] < extreme:
                extreme = low[i]
                accel = min(accel + step, mx)
        if (up and low[i] < sar) or ((not up) and high[i] > sar):
            accel = step
            sar = extreme
            up = not up
            extreme = high[i] if up else low[i]
        furthest = prev
        prev = i
        out[i] = sar
    return out


@njit(cache=True, error_model='numpy')
def _node_rsi_raw(close, p):
    """technicalindicators RSI before rounding: Wilder averages of gains / losses, the first at index p; 100 when
    the average loss is 0, 0 when the average gain is 0. Returns (value, needs_rounding)."""
    n = len(close)
    out = np.full(n, np.nan)
    rnd = np.zeros(n, np.bool_)
    gsum = 0.0
    lsum = 0.0
    ag = 0.0
    al = 0.0
    for i in range(1, n):
        ch = close[i] - close[i - 1]
        g = ch if ch > 0 else 0.0
        lo = (close[i - 1] - close[i]) if (close[i - 1] - close[i]) > 0 else 0.0
        if g > 0:
            gsum = gsum + g
        if lo > 0:
            lsum = lsum + lo
        if i < p:
            continue
        if i == p:
            ag = gsum / p
            al = lsum / p
        else:
            ag = ((ag * (p - 1)) + g) / p
            al = ((al * (p - 1)) + lo) / p
        if al == 0:
            out[i] = 100.0
        elif ag == 0:
            out[i] = 0.0
        else:
            out[i] = 100 - (100 / (1 + ag / al))
            rnd[i] = True
    return out, rnd


@njit(cache=True, error_model='numpy')
def _stoch_of(x, valid, period):
    """Stochastic %K with high = low = close = x (stochRSI) over the valid values only: the true high / low of the
    last `period` values (backend/indicators/standard.js stochRsi; technicalindicators' window scan stopped at a 0
    value, Node no longer uses it). 0 when the range is 0 (NaN)."""
    n = len(x)
    out = np.full(n, np.nan)
    buf = np.zeros(period)
    pushed = 0
    for i in range(n):
        if not valid[i]:
            continue
        d = x[i]
        buf[pushed % period] = d
        pushed += 1
        if pushed < period:
            continue
        phigh = -np.inf
        plow = np.inf
        for m in range(period):
            if buf[m] > phigh:
                phigh = buf[m]
            if buf[m] < plow:
                plow = buf[m]
        k = (d - plow) / (phigh - plow) * 100
        out[i] = 0.0 if np.isnan(k) else k
    return out


@njit(cache=True, error_model='numpy')
def _sma_valid(x, valid, p):
    """_node_sma over the valid values of x only, written back at their positions."""
    idx = np.flatnonzero(valid)
    out = np.full(len(x), np.nan)
    v = _node_sma(x[idx], p)
    for j in range(len(idx)):
        out[idx[j]] = v[j]
    return out


def _stochrsi(close, rsi_p, stoch_p, k_p, d_p):
    """Node's stochrsi (backend/indicators/standard.js): RSI rounded to 2 decimals, its stochastic over stoch_p
    values (stochRSI), k = sma(stochRSI, k_p), d = sma(k, d_p); all three only from the first d on."""
    raw, rnd = _node_rsi_raw(close.astype(float), rsi_p)
    rsi = np.where(rnd, tofixed2(raw), raw)
    ok = np.isfinite(rsi)
    st = _stoch_of(rsi, ok, stoch_p)
    ok_st = np.isfinite(st)
    k = _sma_valid(st, ok_st, k_p)
    ok_k = np.isfinite(k)
    d = _sma_valid(k, ok_k, d_p)
    has = np.isfinite(d)
    return np.where(has, st, np.nan), np.where(has, k, np.nan), d


@njit(cache=True, error_model='numpy')
def _mfi(high, low, close, volume, p):
    """Money flow index (standard: a candle whose typical price equals the previous one adds no flow), with running
    sums and 100 - 100 / (1 + pos / neg) as backend/indicators/standard.js mfi; first value at index p."""
    n = len(close)
    out = np.full(n, np.nan)
    pos_buf = np.zeros(p)
    neg_buf = np.zeros(p)
    psum = 0.0
    nsum = 0.0
    pushed = 0
    for i in range(1, n):
        tp = (high[i] + low[i] + close[i]) / 3
        tp0 = (high[i - 1] + low[i - 1] + close[i - 1]) / 3
        raw = tp * volume[i]
        pm = raw if tp > tp0 else 0.0
        nm = raw if tp < tp0 else 0.0
        if pushed >= p:
            psum = psum - pos_buf[pushed % p]
            nsum = nsum - neg_buf[pushed % p]
        pos_buf[pushed % p] = pm
        neg_buf[pushed % p] = nm
        psum = psum + pm
        nsum = nsum + nm
        pushed += 1
        if pushed >= p:
            out[i] = 100 - 100 / (1 + psum / nsum) if nsum != 0 else (100.0 if psum != 0 else np.nan)
    return out


def _obv(close, volume):
    """technicalindicators OBV (Node's obv): cumulative +volume on an up close, -volume on a down close, from the
    second candle on (the first is NaN)."""
    out = np.full(len(close), np.nan)
    if len(close) > 1:
        d = np.diff(close)
        step = np.where(d > 0, volume[1:], np.where(d < 0, -volume[1:], 0.0))
        out[1:] = np.cumsum(step)
    return out


@njit(cache=True, error_model='numpy')
def _vwap_daily(ts, high, low, close, volume):
    """VWAP of hlc3 anchored to the UTC day (resets on the first candle of each day)."""
    n = len(close)
    out = np.full(n, np.nan)
    day = -1
    tot = 0.0
    vol = 0.0
    for i in range(n):
        d = ts[i] // 86_400_000
        if d != day:
            day = d
            tot = 0.0
            vol = 0.0
        tp = (high[i] + low[i] + close[i]) / 3
        tot = tot + volume[i] * tp
        vol = vol + volume[i]
        out[i] = tot / vol if vol != 0 else np.nan
    return out


@njit(cache=True, error_model='numpy')
def _wilder_atr_node(high, low, close, p):
    """ATR as in backend/indicators/supertrend.js (and TradingView ta.atr): first true range high - low, the first
    ATR the mean of the first p true ranges (index p - 1), then Wilder smoothing."""
    n = len(close)
    tr = np.empty(n)
    atr = np.full(n, np.nan)
    for i in range(n):
        if i == 0:
            tr[i] = high[i] - low[i]
        else:
            tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        if i == p - 1:
            s = 0.0
            for j in range(i + 1):
                s += tr[j]
            atr[i] = s / p
        elif i >= p:
            atr[i] = ((atr[i - 1] * (p - 1)) + tr[i]) / p
    return atr


@njit(cache=True, error_model='numpy')
def _supertrend(high, low, close, src, p, factor):
    """TradingView ta.supertrend with the Node engine's ATR and band rules; trend 1 = up (value = lower band),
    -1 = down (value = upper band). Starts down; flips up when close > upper, down when close < lower."""
    n = len(close)
    value = np.full(n, np.nan)
    trend = np.full(n, np.nan)
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    if p < 1 or n < p:
        return value, trend, upper, lower
    atr = _wilder_atr_node(high, low, close, p)
    for i in range(p - 1, n):
        bu = src[i] + (factor * atr[i])
        bl = src[i] - (factor * atr[i])
        if i == p - 1:
            fu, fl, t = bu, bl, -1.0
        else:
            pu, pl = upper[i - 1], lower[i - 1]
            fu = bu if (bu < pu or close[i - 1] > pu) else pu
            fl = bl if (bl > pl or close[i - 1] < pl) else pl
            if trend[i - 1] == -1.0:
                t = 1.0 if close[i] > fu else -1.0
            else:
                t = -1.0 if close[i] < fl else 1.0
        upper[i], lower[i], trend[i] = fu, fl, t
        value[i] = fl if t == 1.0 else fu
    return value, trend, upper, lower


@njit(cache=True, error_model='numpy')
def _ema_pine(x, length):
    """EMA seeded with the SMA of the first `length` values, (x - prev) * alpha + prev after that (the Node
    wavetrend helper's arithmetic). A NaN input makes that candle NaN and the EMA re-seeds once `length`
    consecutive values exist again (Pine ta.ema)."""
    n = len(x)
    out = np.full(n, np.nan)
    alpha = 2 / (length + 1)
    run = 0               # consecutive finite inputs ending at i
    for i in range(n):
        if np.isnan(x[i]):
            run = 0
            continue
        run += 1
        if i > 0 and not np.isnan(out[i - 1]):
            out[i] = (x[i] - out[i - 1]) * alpha + out[i - 1]
        elif run >= length:
            s = 0.0
            for j in range(i - length + 1, i + 1):
                s += x[j]
            out[i] = s / length
    return out


@njit(cache=True, error_model='numpy')
def _wavetrend(high, low, close, n1, n2, ma):
    n = len(close)
    ap = np.empty(n)
    for i in range(n):
        ap[i] = (high[i] + low[i] + close[i]) / 3
    esa = _ema_pine(ap, n1)
    dev = np.abs(ap - esa)
    d = _ema_pine(dev, n1)
    ci = np.full(n, np.nan)
    for i in range(n):
        if not np.isnan(esa[i]) and not np.isnan(d[i]) and d[i] != 0:
            ci[i] = (ap[i] - esa[i]) / (0.015 * d[i])
    wt1 = _ema_pine(ci, n2)
    wt2 = np.full(n, np.nan)
    for i in range(ma - 1, n):
        s = 0.0
        ok = True
        for j in range(i - ma + 1, i + 1):
            if np.isnan(wt1[j]):
                ok = False
                break
            s += wt1[j]
        if ok:
            wt2[i] = s / ma
    return wt1, wt2


@njit(cache=True, error_model='numpy')
def _dpo(high, low, close, period, smooth, atr_p):
    """backend/indicators/dpo.js: (close - sma(close, period) barsback ago), smoothed by a mean over `smooth`
    candles, divided by an ATR (Wilder, seeded with the true range at index atr_p)."""
    n = len(close)
    barsback = period // 2 + 1
    sma = np.full(n, np.nan)
    for i in range(period - 1, n):
        s = 0.0
        for j in range(period):
            s += close[i - j]
        sma[i] = s / period
    raw = np.full(n, np.nan)
    for i in range(barsback, n):
        if not np.isnan(sma[i - barsback]):
            raw[i] = close[i] - sma[i - barsback]
    sm = np.full(n, np.nan)
    for i in range(smooth - 1, n):
        s = 0.0
        cnt = 0
        for j in range(smooth):
            if not np.isnan(raw[i - j]):
                s += raw[i - j]
                cnt += 1
        if cnt > 0:
            sm[i] = s / cnt
    atr = np.full(n, np.nan)
    for i in range(n):
        if i == 0:
            tr = high[i] - low[i]
        else:
            tr = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
        if i < atr_p:
            continue
        prev = tr if i == atr_p else atr[i - 1]
        atr[i] = ((prev * (atr_p - 1)) + tr) / atr_p
    out = np.full(n, np.nan)
    for i in range(n):
        if not np.isnan(sm[i]) and not np.isnan(atr[i]) and atr[i] != 0:
            out[i] = sm[i] / atr[i]
    return out


@njit(cache=True, error_model='numpy')
def _wma(x, p):
    """technicalindicators WMA: sum of x * weight / denominator (weights 1..p, oldest first), from index p - 1."""
    n = len(x)
    out = np.full(n, np.nan)
    den = p * (p + 1) / 2
    for i in range(p - 1, n):
        r = 0.0
        for k in range(1, p + 1):
            r = r + (x[i - p + k] * k / den)
        out[i] = r
    return out


@njit(cache=True, error_model='numpy')
def _hma(close, p):
    """backend/indicators/hma.js: wma(2 * wma(n/2) - wma(n), floor(sqrt(n)))."""
    n = len(close)
    out = np.full(n, np.nan)
    half = p // 2
    sq = int(np.floor(np.sqrt(p)))
    if half < 1 or sq < 1 or n < p:
        return out
    wh, wf = _wma(close, half), _wma(close, p)
    diff = np.full(n, np.nan)
    for i in range(p - 1, n):
        diff[i] = 2 * wh[i] - wf[i]
    v = _wma(diff[p - 1:], sq)
    out[p - 1:] = v
    return out


@njit(cache=True, error_model='numpy')
def _ema_k(x, p):
    """backend/indicators/tema.js calculateEMA: SMA seed at p - 1, then x * k + prev * (1 - k)."""
    n = len(x)
    out = np.full(n, np.nan)
    if n < p:
        return out
    k = 2 / (p + 1)
    s = 0.0
    for i in range(p):
        s += x[i]
    out[p - 1] = s / p
    for i in range(p, n):
        out[i] = x[i] * k + out[i - 1] * (1 - k)
    return out


@njit(cache=True, error_model='numpy')
def _tema(close, p):
    n = len(close)
    out = np.full(n, np.nan)
    if n < p * 3:
        return out
    e1 = _ema_k(close, p)
    e2 = np.full(n, np.nan)
    e2[p - 1:] = _ema_k(e1[p - 1:], p)
    e3 = np.full(n, np.nan)
    e3[2 * p - 2:] = _ema_k(e2[2 * p - 2:], p)
    for i in range(n):
        if not np.isnan(e1[i]) and not np.isnan(e2[i]) and not np.isnan(e3[i]):
            out[i] = 3 * e1[i] - 3 * e2[i] + e3[i]
    return out


@njit(cache=True, error_model='numpy')
def _vwema(x, vol, p):
    """backend/indicators/tvwema.js calculateVWEMA: k scaled by volume[i] / max(volume[i-1], 1), clamped to
    [0.5, 2]; `vol` is aligned with x."""
    n = len(x)
    out = np.full(n, np.nan)
    if n < p:
        return out
    k = 2 / (p + 1)
    s = 0.0
    for i in range(p):
        s += x[i]
    out[p - 1] = s / p
    for i in range(p, n):
        ratio = vol[i] / max(vol[i - 1], 1.0)
        ak = k * min(2.0, max(0.5, ratio))
        out[i] = x[i] * ak + out[i - 1] * (1 - ak)
    return out


@njit(cache=True, error_model='numpy')
def _tvwema(close, volume, p):
    n = len(close)
    out = np.full(n, np.nan)
    if n < p * 3:
        return out
    e1 = _vwema(close, volume, p)
    e2 = np.full(n, np.nan)
    e2[p - 1:] = _vwema(e1[p - 1:], volume[p - 1:], p)
    e3 = np.full(n, np.nan)
    e3[2 * p - 2:] = _vwema(e2[2 * p - 2:], volume[2 * p - 2:], p)
    for i in range(n):
        if not np.isnan(e1[i]) and not np.isnan(e2[i]) and not np.isnan(e3[i]):
            out[i] = 3 * e1[i] - 3 * e2[i] + e3[i]
    return out

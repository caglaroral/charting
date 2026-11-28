"""
Market regime labels (1 bull, -1 bear, 0 sideways) for the regime study and as a gate in the search.

Every definition produces labels on its own bars (BTC weekly, BTC daily, or a daily breadth series) and is mapped to
strategy candles with the same no-look-ahead rule as higher-timeframe values: a strategy candle sees the label of
the last bar that has closed by its own close (lookahead_off). Weekly bars start on Monday 00:00 UTC, like
Binance's weekly candles; they are built here from the ClickHouse 1d table.
"""
import numpy as np
import talib

from . import data

DAY = 86_400_000
WEEK = 7 * DAY
UNKNOWN = 9   # not enough history for the definition yet: the candle belongs to no regime (never 0 = sideways)
SYMBOLS_17 = ['XLMUSDT', 'GRTUSDT', 'C98USDT', 'ALGOUSDT', 'SANDUSDT', 'FILUSDT', 'TRXUSDT', 'AXSUSDT', 'CRVUSDT',
              'DOGEUSDT', 'ADAUSDT', 'DOTUSDT', 'MANAUSDT', 'VETUSDT', 'HBARUSDT', 'SUIUSDT', 'APTUSDT']


def weekly(symbol='BTCUSDT'):
    """Weekly OHLC from daily candles, Monday 00:00 UTC open; only complete weeks (7 days)."""
    d = data.load(symbol, '1d')
    day = d.ts // DAY
    wk = ((day - 4) // 7 * 7 + 4) * DAY          # 1970-01-05 (day 4) was a Monday
    starts, idx, counts = np.unique(wk, return_index=True, return_counts=True)
    ends = idx + counts
    full = counts == 7
    o = d.open[idx]; c = d.close[ends - 1]
    h = np.maximum.reduceat(d.high, idx); l = np.minimum.reduceat(d.low, idx)
    return {'ts': starts[full], 'open': o[full], 'high': h[full], 'low': l[full], 'close': c[full], 'bar': WEEK}


def daily(symbol='BTCUSDT'):
    d = data.load(symbol, '1d')
    return {'ts': d.ts, 'open': d.open, 'high': d.high, 'low': d.low, 'close': d.close, 'bar': DAY}


# ------------------------------------------------------------------ definitions: bars -> labels on those bars
def r1_btc_weekly_sma():
    """BTC weekly SMA7/25/99 (lab rule): bull if SMA7 > SMA25 and close > SMA99, bear if SMA7 < SMA25 and
    close < SMA99, else sideways."""
    w = weekly()
    c = w['close']
    s7, s25, s99 = talib.SMA(c, 7), talib.SMA(c, 25), talib.SMA(c, 99)
    lab = np.where((s7 > s25) & (c > s99), 1, np.where((s7 < s25) & (c < s99), -1, 0))
    return w, np.where(np.isnan(s99), 0, lab).astype(np.int8)


def r2_btc_daily_sma():
    """BTC daily: bull if close > SMA50 > SMA200 and SMA200 rising over 20 days, bear the mirror, else sideways."""
    d = daily()
    c = d['close']
    s50, s200 = talib.SMA(c, 50), talib.SMA(c, 200)
    up = s200 > np.r_[np.full(20, np.nan), s200[:-20]]
    dn = s200 < np.r_[np.full(20, np.nan), s200[:-20]]
    lab = np.where((c > s50) & (s50 > s200) & up, 1, np.where((c < s50) & (s50 < s200) & dn, -1, 0))
    return d, np.where(np.isnan(s200), 0, lab).astype(np.int8)


def r3_btc_weekly_adx(threshold=20):
    """BTC weekly ADX(14): sideways below the threshold, else the side of +DI vs -DI."""
    w = weekly()
    adx = talib.ADX(w['high'], w['low'], w['close'], 14)
    pdi = talib.PLUS_DI(w['high'], w['low'], w['close'], 14)
    mdi = talib.MINUS_DI(w['high'], w['low'], w['close'], 14)
    lab = np.where(adx < threshold, 0, np.where(pdi > mdi, 1, -1))
    return w, np.where(np.isnan(adx), 0, lab).astype(np.int8)


def r4_breadth(symbols=SYMBOLS_17, hi=0.6, lo=0.4):
    """Share of the coins whose daily close is above their own SMA200: bull above hi, bear below lo. A coin counts
    from the day its SMA200 exists; days with fewer than 5 such coins are sideways."""
    d = daily()
    above = np.zeros(len(d['ts'])); valid = np.zeros(len(d['ts']))
    for s in symbols:
        x = data.load(s, '1d')
        sma = talib.SMA(x.close, 200)
        pos = np.searchsorted(d['ts'], x.ts)
        ok = (pos < len(d['ts'])) & ~np.isnan(sma)
        ok[ok] &= d['ts'][pos[ok]] == x.ts[ok]
        np.add.at(valid, pos[ok], 1)
        np.add.at(above, pos[ok], (x.close[ok] > sma[ok]).astype(float))
    share = np.divide(above, valid, out=np.full(len(valid), np.nan), where=valid >= 5)
    lab = np.where(share > hi, 1, np.where(share < lo, -1, 0))
    return d, np.where(np.isnan(share), 0, lab).astype(np.int8)


DEFINITIONS = {'R1_btc_weekly_sma': r1_btc_weekly_sma, 'R2_btc_daily_sma': r2_btc_daily_sma,
               'R3_btc_weekly_adx': r3_btc_weekly_adx, 'R4_breadth17': r4_breadth}


def align(bars, labels, ts_ms, tf_ms, before=0):
    """Label seen by strategy candles opening at ts_ms (lookahead_off: the last bar closed by the candle's close);
    `before` before the first bar (0 for the BTC definitions, which start in 2020; UNKNOWN for the coin ones)."""
    idx = np.searchsorted(bars['ts'] + bars['bar'], ts_ms + tf_ms, side='right') - 1
    return np.where(idx >= 0, labels[np.clip(idx, 0, None)], before).astype(np.int8)


# ------------------------------------------------------------------ per-coin definitions (labels depend on the symbol)
def c1_coin_weekly_sma(symbol):
    """R1's rule on the coin's own weekly candles."""
    w = weekly(symbol)
    c = w['close']
    s7, s25, s99 = talib.SMA(c, 7), talib.SMA(c, 25), talib.SMA(c, 99)
    lab = np.where((s7 > s25) & (c > s99), 1, np.where((s7 < s25) & (c < s99), -1, 0))
    return w, np.where(np.isnan(s99), UNKNOWN, lab).astype(np.int8)


def c2_coin_daily_sma(symbol):
    """R2's rule on the coin's own daily candles; UNKNOWN until SMA(200) and its 20-day slope exist."""
    d = daily(symbol)
    c = d['close']
    s50, s200 = talib.SMA(c, 50), talib.SMA(c, 200)
    prev = np.r_[np.full(20, np.nan), s200[:-20]]
    lab = np.where((c > s50) & (s50 > s200) & (s200 > prev), 1, np.where((c < s50) & (s50 < s200) & (s200 < prev), -1, 0))
    return d, np.where(np.isnan(s200) | np.isnan(prev), UNKNOWN, lab).astype(np.int8)


def c3_coin_consolidation(symbol, adx_max=20, width_q=0.25, lookback=180):
    """Consolidation (0) when the coin's daily ADX(14) is below adx_max and its Bollinger(20,2) width is in the lowest
    width_q of the past `lookback` days (a squeeze); otherwise the side of the close vs SMA(50). UNKNOWN until the
    lookback is filled (before 2026-10-27 this was labelled 0, which made all of 2022 a 'squeeze' for coins listed in
    2022-01; the lookback was 365 days)."""
    d = daily(symbol)
    h, l, c = d['high'], d['low'], d['close']
    adx = talib.ADX(h, l, c, 14)
    up, mid, lo = talib.BBANDS(c, 20, 2, 2, 0)
    width = (up - lo) / mid
    q = np.full(len(c), np.nan)
    for i in range(lookback, len(c)):                      # quantile of the past only (no look-ahead)
        q[i] = np.nanquantile(width[i - lookback:i], width_q)
    s50 = talib.SMA(c, 50)
    squeeze = (adx < adx_max) & (width <= q)
    lab = np.where(squeeze, 0, np.where(c > s50, 1, -1))
    return d, np.where(np.isnan(q) | np.isnan(adx) | np.isnan(s50), UNKNOWN, lab).astype(np.int8)


def rs_vs_btc(symbol, band=0.03):
    """Relative strength: the coin/BTC daily close ratio vs its SMA(50): above by more than `band` = 1 (stronger than
    BTC), below by more = -1, otherwise 0."""
    d, b = daily(symbol), daily()
    pos = np.searchsorted(b['ts'], d['ts'])
    ok = (pos < len(b['ts'])) & (b['ts'][np.clip(pos, 0, len(b['ts']) - 1)] == d['ts'])
    ratio = np.where(ok, d['close'] / b['close'][np.clip(pos, 0, len(b['ts']) - 1)], np.nan)
    sma = talib.SMA(ratio, 50)
    x = ratio / sma - 1
    lab = np.where(x > band, 1, np.where(x < -band, -1, 0))
    return d, np.where(np.isnan(x), UNKNOWN, lab).astype(np.int8)


def btc_x_coin(symbol):
    """BTC weekly regime (R1) combined with the coin's own state (C3): 0 when the coin consolidates, 1 / -1 when the
    coin trends the same way as a bull / bear BTC (aligned), 2 when the coin trends against BTC's regime or BTC is
    sideways (divergent). Labelled on the coin's daily bars."""
    d, k = c3_coin_consolidation(symbol)
    wb, wl = r1_btc_weekly_sma()
    b = align(wb, wl, d['ts'], DAY)
    lab = np.where(k == 0, 0, np.where((b != 0) & (k == b), k, 2))
    return d, np.where(k == UNKNOWN, UNKNOWN, lab).astype(np.int8)


def coin3(symbol):
    """The coin's own regime for the search (user's choice, 2026-10-27): consolidation (0) when C3 sees a squeeze or
    the daily trend (C2) is mixed; otherwise C2's bull (1) / bear (-1). Independent of BTC."""
    d, k3 = c3_coin_consolidation(symbol)
    d2, k2 = c2_coin_daily_sma(symbol)
    squeeze = (k3 == 0)
    lab = np.where(squeeze | (k2 == 0), 0, k2)
    return d, np.where((k3 == UNKNOWN) | (k2 == UNKNOWN), UNKNOWN, lab).astype(np.int8)


def coin4(symbol):
    """The coin's own regime, four states, independent of BTC: squeeze (0, C3), bull (1) / bear (-1) from the coin's
    daily trend (C2), and transition (2) for the rest (mixed trend without a squeeze)."""
    d, k3 = c3_coin_consolidation(symbol)
    d2, k2 = c2_coin_daily_sma(symbol)
    lab = np.where(k3 == 0, 0, np.where(k2 == 0, 2, k2))
    return d, np.where((k3 == UNKNOWN) | (k2 == UNKNOWN), UNKNOWN, lab).astype(np.int8)


COIN_DEFINITIONS = {'C1_coin_weekly_sma': c1_coin_weekly_sma, 'C2_coin_daily_sma': c2_coin_daily_sma,
                    'C3_coin_consolidation': c3_coin_consolidation, 'RS_vs_btc': rs_vs_btc,
                    'BTCxCOIN_aligned_divergent': btc_x_coin, 'COIN3_own_bull_bear_consolidation': coin3,
                    'COIN4_own_bull_bear_squeeze_transition': coin4}

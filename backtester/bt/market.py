"""Candles from a ClickHouse data source, the way the app's chart reads them.

A source is passed by the backend with every request: {prefix, url, user, password, db, tables: {app tf: table},
cols: {symbol, time, open, ...}, recent: table | ''}. `recent` is an optional table of the latest 1m bars (same
columns), merged after the history tables' last bar so screens run on today's data.

Timeframes without a table are aggregated from the coarsest native table that divides them (like the chart).
Only closed bars are returned: a bucket is closed when its data reaches the bucket's end.

Two ways to read:
  recent(src, tf)          the latest bars of every symbol, kept in memory and refreshed incrementally
  window(src, sym, tf, a, b) one symbol, [a, b] (seconds), for a backtest
"""
import base64
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

from backtestengine import data
from . import live
from .spec import ENGINE_TO_APP

TF_SEC = {k: v // 1000 for k, v in data.TF_MS.items()}
RECENT_BARS = {'1w': 400}           # bars kept per symbol in the recent cache (default below)
DEFAULT_RECENT_BARS = 1000
REFRESH_SEC = 30                    # the recent cache is refreshed at most this often
STALE_SEC = 2 * 86400               # a symbol whose last bar is older than the newest symbol's by this is not listed


class CHError(Exception):
    pass


def _q(name):
    return '`' + str(name).replace('\\', '\\\\').replace('`', '\\`') + '`'


class Source:
    def __init__(self, cfg):
        self.prefix = cfg['prefix']
        self.url = cfg['url'].rstrip('/')
        self.db = cfg['db']
        self.cols = cfg['cols']
        self.recent = cfg.get('recent') or ''
        self.live = cfg.get('live') if cfg.get('live') in live.PROVIDERS else ''
        self._auth = 'Basic ' + base64.b64encode(f"{cfg['user']}:{cfg.get('password', '')}".encode()).decode()
        # engine tf -> table of the native timeframes
        self.native = {}
        for app_tf, table in (cfg.get('tables') or {}).items():
            etf = {'1D': '1d', '1W': '1w'}.get(app_tf, app_tf)
            if etf in TF_SEC:
                self.native[etf] = table
        self.key = json.dumps([self.prefix, self.url, cfg['user'], self.db, cfg.get('tables'), self.recent, self.cols, self.live],
                              sort_keys=True)

    def query(self, sql, params=None, timeout=120):
        qs = {f'param_{k}': str(v) for k, v in (params or {}).items()}
        req = urllib.request.Request(self.url + '/?' + urllib.parse.urlencode(qs), data=(sql + '\nFORMAT JSONCompact').encode(),
                                     headers={'Authorization': self._auth})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())['data']
        except urllib.error.HTTPError as e:
            raise CHError(e.read().decode(errors='replace').strip()[:500]) from None
        except (urllib.error.URLError, OSError) as e:
            raise CHError(f'ClickHouse connection error: {getattr(e, "reason", e)}') from None

    def table(self, name):
        return f'{_q(self.db)}.{_q(name)}'

    def col(self, k):
        return _q(self.cols[k])

    def native_for(self, tf):
        """(native engine tf, table) to build tf from: the coarsest native timeframe that divides it."""
        sec = TF_SEC[tf]
        if tf in self.native:
            return tf, self.native[tf]
        cands = [(TF_SEC[n], n) for n in self.native if TF_SEC[n] < sec and sec % TF_SEC[n] == 0]
        if tf == '1w':
            cands = [(s, n) for s, n in cands if 86400 % s == 0]
        if not cands:
            raise CHError(f'{ENGINE_TO_APP.get(tf, tf)}: no table to build this timeframe from')
        _, n = max(cands)
        return n, self.native[n]


def _bucket(tf, col):
    if tf == '1d':
        return f'toStartOfDay({col})'
    if tf == '1w':
        return f'toDateTime(toMonday({col}))'
    return f'toStartOfInterval({col}, INTERVAL {TF_SEC[tf]} SECOND)'


_hist_end = {}   # (source key, table) -> (checked_at, last bar time + its length)


def _history_end(src, ntf, table):
    """End (seconds) of the history table's data: recent rows are taken from here on."""
    k = (src.key, table)
    c = _hist_end.get(k)
    if c and time.time() - c[0] < 300:
        return c[1]
    T = src.col('time')
    r = src.query(f'SELECT toUInt32(max({T})) FROM {src.table(table)} WHERE {T} >= now() - INTERVAL 60 DAY')
    end = int(r[0][0]) + TF_SEC[ntf] if r and r[0][0] else 0
    _hist_end[k] = (time.time(), end)
    return end


def _fetch(src, tf, frm, to=None, symbol=None):
    """{symbol: (ts_ms, o, h, l, c, v)} of closed bars with open time in [frm, to) seconds."""
    ntf, table = src.native_for(tf)
    S, T = src.col('symbol'), src.col('time')
    O, H, L, C, V = (src.col(k) for k in ('open', 'high', 'low', 'close', 'volume'))
    where = f'{T} >= toDateTime({{frm:UInt32}})'
    params = {'frm': int(frm)}
    if to is not None:
        where += f' AND {T} < toDateTime({{to:UInt32}})'
        params['to'] = int(to)
    if symbol is not None:
        where += f' AND {S} = {{sym:String}}'
        params['sym'] = symbol
    sel = f'SELECT toString({S}) AS s, {T} AS ts, {O} AS o, {H} AS h, {L} AS l, {C} AS c, {V} AS v'
    parts = [f'{sel}, toUInt32({T}) + {TF_SEC[ntf]} AS te FROM {src.table(table)} WHERE {where}']
    if src.recent:
        params['he'] = _history_end(src, ntf, table)
        parts.append(f'{sel}, toUInt32({T}) + 60 AS te FROM {src.table(src.recent)} WHERE {where} '
                     f'AND {T} >= toDateTime({{he:UInt32}})')
    B = _bucket(tf, 'ts')
    sql = (f'SELECT s, toUInt32({B}) AS b, argMin(o, ts), max(h), min(l), argMax(c, ts), sum(v), max(te) '
           f'FROM ({" UNION ALL ".join(parts)}) GROUP BY s, b ORDER BY s, b')
    rows = src.query(sql, params)
    out = {}
    sec = TF_SEC[tf]
    i = 0
    while i < len(rows):
        j = i
        s = rows[i][0]
        while j < len(rows) and rows[j][0] == s:
            j += 1
        a = np.array([r[1:] for r in rows[i:j]], dtype=np.float64)
        closed = a[:, 6] >= a[:, 0] + sec
        a = a[closed]
        if len(a):
            out[s] = (a[:, 0].astype(np.int64) * 1000, a[:, 1], a[:, 2], a[:, 3], a[:, 4], a[:, 5])
        i = j
    return out


# --------------------------------------------------------------------------- recent cache (all symbols)

class _Recent:
    def __init__(self, n):
        self.n = n
        self.bars = {}        # symbol -> tuple of arrays
        self.at = 0.0
        self.lock = threading.Lock()
        self.topped = {}      # symbol -> newest bar time of the last exchange top-up attempt


_recent = {}
_recent_lock = threading.Lock()


def recent(src, tf):
    """{symbol: Candles} of the latest closed bars of every symbol that is still updated."""
    with _recent_lock:
        r = _recent.setdefault((src.key, tf), _Recent(RECENT_BARS.get(tf, DEFAULT_RECENT_BARS)))
    with r.lock:
        if time.time() - r.at >= REFRESH_SEC:
            sec = TF_SEC[tf]
            if not r.bars:
                new = _fetch(src, tf, time.time() - r.n * sec * 1.05 - 2 * 86400)
            else:
                last = max(int(b[0][-1]) for b in r.bars.values()) // 1000
                new = _fetch(src, tf, last - 2 * sec)
            for s, b in new.items():
                old = r.bars.get(s)
                if old is not None:
                    cut = int(np.searchsorted(old[0], b[0][0]))
                    b = tuple(np.concatenate([x[:cut], y]) for x, y in zip(old, b))
                r.bars[s] = tuple(x[-r.n:] for x in b)
            if src.live:
                _topup(src, tf, r)
            r.at = time.time()
        bars = dict(r.bars)
    if not bars:
        return {}
    newest = max(int(b[0][-1]) for b in bars.values())
    return {s: data.Candles(s, tf, *b) for s, b in bars.items() if newest - int(b[0][-1]) <= STALE_SEC * 1000}


def reference_time(bars):
    """The last bar time most symbols have (ms): the bar a screen is evaluated on. Robust to a few symbols that
    are ahead (exchange top-up) or behind (halted, lagging)."""
    vals, counts = np.unique([int(b[0][-1]) for b in bars.values()], return_counts=True)
    return int(vals[np.argmax(counts)])


def _topup(src, tf, r):
    """Symbols behind the newest bar but not stale (missing from the recent table): fetch the missing closed bars
    from the exchange, once per newest bar."""
    if not r.bars:
        return
    sec = TF_SEC[tf]
    newest = reference_time(r.bars)
    for s, b in list(r.bars.items()):
        last = int(b[0][-1])
        if last >= newest or newest - last > STALE_SEC * 1000 or r.topped.get(s) == newest:
            continue
        r.topped[s] = newest
        try:
            rows = live.klines(src.live, s, tf, (newest - last) // (sec * 1000) + 3)
        except live.RateLimited:
            r.topped.pop(s, None)
            return
        except Exception as e:
            print(f'top-up {s} {tf}: {e}', flush=True)
            continue
        rows = [x for x in rows if last < x[0] <= newest]
        if not rows:
            continue
        a = np.array(rows, dtype=np.float64)
        add = (a[:, 0].astype(np.int64), a[:, 1], a[:, 2], a[:, 3], a[:, 4], a[:, 5])
        r.bars[s] = tuple(np.concatenate([x, y])[-r.n:] for x, y in zip(b, add))


def recent_provider(src):
    """A data.load provider over the recent caches (the timeframes are fetched on first use)."""
    memo = {}

    def load(symbol, tf):
        if tf not in memo:
            memo[tf] = recent(src, tf)
        return memo[tf].get(symbol) or data.empty(symbol, tf)
    return load


# --------------------------------------------------------------------------- one symbol, a window

WARM_BARS = 1000   # loaded before a backtest window: indicators run on these first (the engine needs 256)


def window_provider(src, start_ms, end_ms):
    """A data.load provider for a backtest window: [start - WARM_BARS bars, end], per timeframe, cached per run."""
    memo = {}

    def load(symbol, tf):
        k = (symbol, tf)
        if k not in memo:
            sec = TF_SEC[tf]
            frm = start_ms // 1000 - WARM_BARS * sec
            b = _fetch(src, tf, max(0, frm), end_ms // 1000 + sec, symbol).get(symbol)
            memo[k] = data.Candles(symbol, tf, *b) if b else data.empty(symbol, tf)
        return memo[k]
    return load

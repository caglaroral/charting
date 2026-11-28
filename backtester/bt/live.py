"""Exchange REST top-up for symbols the ClickHouse tables have not reached yet (e.g. a symbol missing from the
recent 1m table). Only closed bars, only for symbols that are behind, at most once per bar and symbol.

The exchange's rate limit is per IP and shared with the backend and other machines: like backend/live.py this
reads the used weight the exchange reports and stops above a share of the limit, and backs off on 429 / 418.
"""
import json
import threading
import time
import urllib.error
import urllib.request

PROVIDERS = {
    'binance-futures': {'rest': 'https://fapi.binance.com/fapi/v1', 'weight_limit': 2400, 'max_limit': 1500},
    'binance-spot': {'rest': 'https://api.binance.com/api/v3', 'weight_limit': 6000, 'max_limit': 1000},
}
INTERVAL = {'1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h',
            '12h': '12h', '1d': '1d', '1w': '1w'}
WEIGHT_BUDGET = 0.3

_lock = threading.Lock()
_state = {}   # provider -> {'used', 'at', 'until'}


class RateLimited(Exception):
    pass


def _guard(p):
    with _lock:
        st = _state.get(p)
        if not st:
            return
        now = time.time()
        if now < st['until']:
            raise RateLimited(p)
        if now - st['at'] < 60 and st['used'] >= PROVIDERS[p]['weight_limit'] * WEIGHT_BUDGET:
            raise RateLimited(p)


def _note(p, headers, status=None):
    with _lock:
        st = _state.setdefault(p, {'used': 0, 'at': 0.0, 'until': 0.0})
        used = headers.get('X-MBX-USED-WEIGHT-1M') if headers else None
        if used is not None:
            st['used'], st['at'] = int(used), time.time()
        if status in (418, 429):
            st['until'] = time.time() + max(int((headers or {}).get('Retry-After') or 60), 60)


def klines(provider, symbol, tf, limit):
    """Closed bars [[open ms, o, h, l, c, v], ...], oldest first."""
    p = PROVIDERS[provider]
    _guard(provider)
    url = f"{p['rest']}/klines?symbol={symbol}&interval={INTERVAL[tf]}&limit={max(2, min(limit, p['max_limit']))}"
    req = urllib.request.Request(url, headers={'User-Agent': 'charting-backtester/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            _note(provider, r.headers)
            rows = json.loads(r.read())
    except urllib.error.HTTPError as e:
        _note(provider, e.headers, e.code)
        if e.code == 400:
            return []      # unknown / delisted symbol
        raise
    now = time.time() * 1000
    return [[int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in rows if int(k[6]) < now]

"""Server-side access to the live exchange REST API (alerts engine, symbol list).

Rate limits are per IP and shared with every other client behind the same address, so this module:
  - tracks the exchange-reported used weight (X-MBX-USED-WEIGHT-1M) and refuses new requests above
    WEIGHT_BUDGET (a fraction of the exchange limit), leaving headroom for other machines;
  - honours 429/418 responses by backing off for Retry-After seconds;
  - keeps a per (symbol, timeframe) bar cache so repeated polls fetch only the last few bars.
"""
import json
import threading
import time
import urllib.error
import urllib.request

PROVIDERS = {
    "binance-futures": {"name": "Binance USDT-M Futures", "rest": "https://fapi.binance.com/fapi/v1",
                        "max_limit": 1500, "weight_limit": 2400},
    "binance-spot": {"name": "Binance Spot", "rest": "https://api.binance.com/api/v3", "max_limit": 1000,
                     "weight_limit": 6000},
}
INTERVAL = {"1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "2h": "2h", "4h": "4h",
            "12h": "12h", "1D": "1d", "1W": "1w", "1M": "1M"}
TF_SEC = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400,
          "12h": 43200, "1D": 86400, "1W": 604800, "1M": 2592000}

# Use at most this share of the per-IP weight limit (other machines share the IP).
WEIGHT_BUDGET = 0.4


class LiveError(Exception):
    pass


class RateLimited(LiveError):
    pass


_rl_lock = threading.Lock()
_rl = {}  # provider -> {"used": int, "at": float, "until": float}


def _guard(provider: str) -> None:
    with _rl_lock:
        st = _rl.get(provider)
        if not st:
            return
        now = time.time()
        if now < st.get("until", 0):
            raise RateLimited(f"{provider}: backing off for {int(st['until'] - now)}s")
        # weight counter resets every minute on the exchange side
        if now - st["at"] < 60 and st["used"] >= PROVIDERS[provider]["weight_limit"] * WEIGHT_BUDGET:
            raise RateLimited(f"{provider}: used weight {st['used']} over budget, waiting")


def _note(provider: str, headers, status: int | None = None) -> None:
    with _rl_lock:
        st = _rl.setdefault(provider, {"used": 0, "at": 0.0, "until": 0.0})
        used = headers.get("X-MBX-USED-WEIGHT-1M") if headers else None
        if used is not None:
            st["used"], st["at"] = int(used), time.time()
        if status in (418, 429):
            retry = int((headers or {}).get("Retry-After") or 60)
            st["until"] = time.time() + max(retry, 60)


def usage() -> dict:
    with _rl_lock:
        return {k: dict(v) for k, v in _rl.items()}


def _get(provider: str, path: str, timeout: float = 15):
    _guard(provider)
    url = PROVIDERS[provider]["rest"] + path
    req = urllib.request.Request(url, headers={"User-Agent": "charting/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            _note(provider, r.headers)
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        _note(provider, e.headers, e.code)
        raise LiveError(f"{path.split('?')[0]}: HTTP {e.code}") from None
    except Exception as e:
        raise LiveError(f"{path.split('?')[0]}: {e}") from None


def _klines(provider: str, symbol: str, tf: str, limit: int) -> list[list]:
    p = PROVIDERS[provider]
    rows = _get(provider, f"/klines?symbol={symbol}&interval={INTERVAL[tf]}&limit={min(limit, p['max_limit'])}")
    return [[int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in rows]


_cache_lock = threading.Lock()
_cache: dict = {}  # (provider, symbol, tf) -> {"rows": [...], "at": float}
CACHE_MAX = 3000


def klines(provider: str, symbol: str, tf: str, limit: int) -> list[list]:
    """Latest `limit` bars [t, o, h, l, c, v] ascending. After the first call only the newest bars are
    fetched (limit ≈ bars elapsed since the last poll, weight 1) and merged into the cache."""
    key = (provider, symbol, tf)
    with _cache_lock:
        c = _cache.get(key)
    if c and len(c["rows"]) >= min(limit, PROVIDERS[provider]["max_limit"]):
        elapsed = int((time.time() - c["at"]) / TF_SEC[tf]) + 2
        fresh = _klines(provider, symbol, tf, min(max(2, elapsed), 99))
        rows = c["rows"]
        if fresh and rows and fresh[0][0] > rows[-1][0]:
            rows = []  # gap larger than the incremental window: refetch below
        if rows:
            idx = {r[0]: i for i, r in enumerate(rows[-len(fresh) - 2:], start=max(0, len(rows) - len(fresh) - 2))}
            for f in fresh:
                if f[0] in idx:
                    rows[idx[f[0]]] = f
                elif f[0] > rows[-1][0]:
                    rows.append(f)
            rows = rows[-CACHE_MAX:]
            with _cache_lock:
                _cache[key] = {"rows": rows, "at": time.time()}
            return rows[-limit:]
    rows = _klines(provider, symbol, tf, limit)
    with _cache_lock:
        _cache[key] = {"rows": rows, "at": time.time()}
    return rows


_sym_lock = threading.Lock()
_sym_cache: dict = {}


def symbols(provider: str) -> list[str]:
    """Tradable symbols on the exchange (cached 1h)."""
    with _sym_lock:
        c = _sym_cache.get(provider)
        if c and time.time() - c[0] < 3600:
            return c[1]
    try:
        info = _get(provider, "/exchangeInfo", timeout=20)
        syms = sorted(s["symbol"] for s in info.get("symbols", []) if s.get("status") == "TRADING")
    except LiveError as e:
        print(f"exchangeInfo {provider}: {e}")
        syms = c[1] if c else []
    with _sym_lock:
        _sym_cache[provider] = (time.time(), syms)
    return syms


_tick_lock = threading.Lock()
_tick_cache: dict = {}
TICKER_TTL = 60


def tickers(provider: str) -> dict:
    """24h statistics of every symbol in one request ({symbol: {last, chgp, qvol}}), cached TICKER_TTL seconds.
    Weight 40 (futures) / 80 (spot) per request, so at most one request per minute per provider."""
    with _tick_lock:
        c = _tick_cache.get(provider)
        if c and time.time() - c[0] < TICKER_TTL:
            return c[1]
    try:
        rows = _get(provider, "/ticker/24hr", timeout=20)
        out = {r["symbol"]: {"last": float(r["lastPrice"]), "chgp": float(r["priceChangePercent"]),
                             "qvol": float(r["quoteVolume"])} for r in rows}
    except LiveError as e:
        print(f"ticker {provider}: {e}")
        out = c[1] if c else {}
    with _tick_lock:
        _tick_cache[provider] = (time.time(), out)
    return out

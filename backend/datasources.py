"""Market data sources configured from the UI (admin only).

A source is a ClickHouse server + database + one OHLCV table per native timeframe + column mapping.
Symbols are exposed as PREFIX:SYMBOL (e.g. BINANCE:BTCUSDT) so several sources can coexist.
Passwords are stored encrypted with SECRET_KEY from .env (SHA-256 CTR keystream + HMAC tag, stdlib only).
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid

from . import ch, config

DB = config.CH_APP_DB

# App timeframes: id -> seconds (1M is nominal)
APP_TFS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
    "4h": 14400, "12h": 43200, "1D": 86400, "1W": 604800, "1M": 2592000,
}
DEFAULT_COLUMNS = {"symbol": "symbol", "time": "timestamp", "open": "open", "high": "high",
                   "low": "low", "close": "close", "volume": "volume"}

# --------------------------------------------------------------------------- secret handling


def _secret_key() -> bytes:
    key = os.environ.get("SECRET_KEY")
    if not key:
        key = secrets.token_hex(32)
        env = config.ROOT / ".env"
        with open(env, "a") as f:
            f.write(f"\n# Encrypts data source passwords. Do not change once sources exist.\nSECRET_KEY={key}\n")
        os.environ["SECRET_KEY"] = key
    return hashlib.sha256(key.encode()).digest()


def _keystream(key: bytes, nonce: bytes, n: int) -> bytes:
    out, ctr = b"", 0
    while len(out) < n:
        out += hashlib.sha256(key + nonce + ctr.to_bytes(8, "big")).digest()
        ctr += 1
    return out[:n]


def encrypt(plain: str) -> str:
    if not plain:
        return ""
    key, nonce = _secret_key(), secrets.token_bytes(16)
    data = plain.encode()
    ct = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]
    return base64.b64encode(nonce + tag + ct).decode()


def decrypt(token: str) -> str:
    if not token:
        return ""
    raw = base64.b64decode(token)
    nonce, tag, ct = raw[:16], raw[16:32], raw[32:]
    key = _secret_key()
    if not hmac.compare_digest(tag, hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]):
        raise ValueError("Cannot decrypt password (SECRET_KEY may have changed)")
    return bytes(a ^ b for a, b in zip(ct, _keystream(key, nonce, len(ct)))).decode()


# --------------------------------------------------------------------------- source object


class Source:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.id = cfg["id"]
        self.prefix = cfg["prefix"]
        self.db = cfg["database"]
        self.tables: dict = cfg["tables"]
        self.cols = {**DEFAULT_COLUMNS, **(cfg.get("columns") or {})}
        self.client = ch.Client(cfg["url"], cfg["user"], cfg.get("password", ""))
        self.live = cfg.get("live") or ""
        self.plan = self._plan()

    def table(self, tf: str) -> str:
        return f"{ch.quote_ident(self.db)}.{ch.quote_ident(self.tables[tf])}"

    def col(self, k: str) -> str:
        return ch.quote_ident(self.cols[k])

    def _plan(self) -> dict:
        """app tf -> (native tf, bucket SQL or None, seconds)"""
        native = {tf: APP_TFS[tf] for tf in self.tables if tf in APP_TFS}
        t = self.col("time")
        plan = {}
        for tf, sec in APP_TFS.items():
            if tf in native:
                plan[tf] = (tf, None, sec)
                continue
            base_sec = 86400 if tf == "1M" else sec
            cands = [(s, n) for n, s in native.items() if s < base_sec and base_sec % s == 0]
            if not cands:
                continue
            s, ntf = max(cands)
            if tf == "1W":
                bucket = f"toDateTime(toMonday({t}))"
            elif tf == "1M":
                bucket = f"toDateTime(toStartOfMonth({t}))"
            else:
                unit = "MINUTE" if sec < 3600 else "HOUR" if sec < 86400 else "DAY"
                k = sec // {"MINUTE": 60, "HOUR": 3600, "DAY": 86400}[unit]
                bucket = f"toStartOfInterval({t}, INTERVAL {k} {unit})"
            plan[tf] = (ntf, bucket, sec)
        return plan

    def public(self) -> dict:
        c = {k: v for k, v in self.cfg.items() if k != "password"}
        c["has_password"] = bool(self.cfg.get("password"))
        c["timeframes"] = list(self.plan.keys())
        return c


# --------------------------------------------------------------------------- persistence + cache

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "sources": None}


def _load_rows() -> list[dict]:
    rows = ch.query(
        f"SELECT id, name, prefix, url, user, password_enc, database, tables, columns, live, enabled, sort "
        f"FROM {DB}.datasources FINAL WHERE deleted = 0 ORDER BY sort, name")
    out = []
    for r in rows:
        try:
            pw = decrypt(r["password_enc"])
        except ValueError:
            pw = ""
        out.append({
            "id": r["id"], "name": r["name"], "prefix": r["prefix"], "url": r["url"], "user": r["user"],
            "password": pw, "database": r["database"], "tables": json.loads(r["tables"] or "{}"),
            "columns": json.loads(r["columns"] or "{}"), "live": r["live"],
            "enabled": bool(int(r["enabled"])), "sort": int(r["sort"]),
        })
    return out


def bootstrap_default() -> None:
    """First run: register the existing kline tables from .env as the BINANCE source."""
    if ch.query(f"SELECT count() c FROM {DB}.datasources FINAL WHERE deleted = 0")[0]["c"] not in (0, "0"):
        return
    tables = {}
    try:
        names = {r["name"] for r in ch.query(
            "SELECT name FROM system.tables WHERE database = {d:String}", {"d": config.CH_MARKET_DB})}
        for tf, t in (("1m", "backtest_1m_klines"), ("5m", "backtest_5m_klines"), ("15m", "backtest_15m_klines"),
                      ("1h", "backtest_1h_klines"), ("4h", "backtest_4h_klines"), ("1D", "backtest_1d_klines")):
            if t in names:
                tables[tf] = t
    except ch.CHError:
        return
    if tables:
        save({"name": "Binance (ClickHouse)", "prefix": "BINANCE", "url": config.CH_URL, "user": config.CH_USER,
              "password": config.CH_PASSWORD, "database": config.CH_MARKET_DB, "tables": tables,
              "columns": DEFAULT_COLUMNS, "live": "binance-futures", "enabled": True})


def sources(enabled_only: bool = True) -> list[Source]:
    with _lock:
        if _cache["sources"] is None or time.time() - _cache["at"] > 30:
            built = []
            for cfg in _load_rows():
                try:
                    built.append(Source(cfg))
                except Exception as e:  # bad config must not break the app
                    print(f"datasource {cfg.get('prefix')}: {e}")
            _cache["sources"], _cache["at"] = built, time.time()
        return [s for s in _cache["sources"] if s.cfg["enabled"] or not enabled_only]


def invalidate() -> None:
    with _lock:
        _cache["sources"] = None


def by_prefix(prefix: str) -> Source | None:
    return next((s for s in sources() if s.prefix == prefix), None)


def resolve(key: str) -> tuple[Source, str] | None:
    """'BINANCE:BTCUSDT' -> (source, 'BTCUSDT'). A bare symbol resolves against the first source."""
    if ":" in key:
        p, sym = key.split(":", 1)
        s = by_prefix(p)
    else:
        all_ = sources()
        s, sym = (all_[0] if all_ else None), key
    return (s, sym) if s else None


_PREFIX_RE = re.compile(r"^[A-Z0-9_]{1,20}$")


def save(cfg: dict) -> dict:
    prefix = str(cfg.get("prefix", "")).strip().upper()
    if not _PREFIX_RE.match(prefix):
        raise ValueError("Prefix must be 1-20 chars of A-Z 0-9 _")
    if not cfg.get("url") or not cfg.get("database"):
        raise ValueError("URL and database are required")
    tables = {tf: str(t) for tf, t in (cfg.get("tables") or {}).items() if tf in APP_TFS and t}
    if not tables and not cfg.get("live"):
        raise ValueError("Select a table for at least one timeframe (or a live provider)")
    sid = cfg.get("id") or uuid.uuid4().hex
    others = [s for s in sources(enabled_only=False) if s.id != sid]
    if any(s.prefix == prefix for s in others):
        raise ValueError("This prefix is used by another source")
    password = cfg.get("password")
    if password is None:  # keep existing
        prev = next((s for s in sources(enabled_only=False) if s.id == sid), None)
        password = prev.cfg.get("password", "") if prev else ""
    url = str(cfg["url"]).strip()
    if not re.match(r"^https?://", url):
        url = "http://" + url
    if not re.search(r":\d+/?$", url.split("//", 1)[1]):
        url = url.rstrip("/") + ":8123"
    ch.insert(f"{DB}.datasources", [{
        "id": sid, "name": str(cfg.get("name") or prefix)[:100], "prefix": prefix, "url": url,
        "user": str(cfg.get("user") or "default"), "password_enc": encrypt(password),
        "database": str(cfg["database"]), "tables": json.dumps(tables),
        "columns": json.dumps({**DEFAULT_COLUMNS, **(cfg.get("columns") or {})}),
        "live": cfg.get("live") if cfg.get("live") in ("binance-futures", "binance-spot") else "",
        "enabled": int(cfg.get("enabled", True)), "sort": int(cfg.get("sort") or 0),
        "updated_at": f"{time.time():.3f}",
    }])
    invalidate()
    return next(s.public() for s in sources(enabled_only=False) if s.id == sid)


def delete(sid: str) -> None:
    ch.insert(f"{DB}.datasources", [{"id": sid, "name": "", "prefix": "", "url": "", "user": "", "password_enc": "",
                                     "database": "", "tables": "{}", "columns": "{}", "deleted": 1,
                                     "updated_at": f"{time.time():.3f}"}])
    invalidate()


# --------------------------------------------------------------------------- discovery (setup wizard)

_TF_PATTERNS = [
    ("1m", r"(^|[_\-])1m(in)?([_\-]|$)"), ("3m", r"(^|[_\-])3m(in)?([_\-]|$)"), ("5m", r"(^|[_\-])5m(in)?([_\-]|$)"),
    ("15m", r"(^|[_\-])15m(in)?([_\-]|$)"), ("30m", r"(^|[_\-])30m(in)?([_\-]|$)"),
    ("1h", r"(^|[_\-])(1h|60m|hour|hourly)([_\-]|$)"), ("2h", r"(^|[_\-])2h([_\-]|$)"),
    ("4h", r"(^|[_\-])4h([_\-]|$)"), ("12h", r"(^|[_\-])12h([_\-]|$)"),
    ("1D", r"(^|[_\-])(1d|d1|day|daily)([_\-]|$)"), ("1W", r"(^|[_\-])(1w|week|weekly)([_\-]|$)"),
]
_COL_GUESS = {
    "symbol": ["symbol", "ticker", "pair", "instrument", "sym"],
    "time": ["timestamp", "time", "ts", "open_time", "datetime", "date", "t"],
    "open": ["open", "o"], "high": ["high", "h"], "low": ["low", "l"], "close": ["close", "c"],
    "volume": ["volume", "vol", "v", "base_volume", "quote_volume"],
}


def _client(cfg: dict) -> ch.Client:
    url = str(cfg.get("url", "")).strip()
    if not re.match(r"^https?://", url):
        url = "http://" + url
    if not re.search(r":\d+/?$", url.split("//", 1)[1]):
        url = url.rstrip("/") + ":8123"
    pw = cfg.get("password")
    if pw is None and cfg.get("id"):
        prev = next((s for s in sources(enabled_only=False) if s.id == cfg["id"]), None)
        pw = prev.cfg.get("password", "") if prev else ""
    return ch.Client(url, cfg.get("user") or "default", pw or "", timeout=15)


def test_connection(cfg: dict) -> dict:
    c = _client(cfg)
    ver = c.query("SELECT version() AS v")[0]["v"]
    dbs = [r["name"] for r in c.query(
        "SELECT name FROM system.databases WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name")]
    return {"version": ver, "databases": dbs}


def discover(cfg: dict) -> dict:
    """List tables in the database with OHLCV-like columns, guessing timeframe + column mapping."""
    c = _client(cfg)
    rows = c.query(
        "SELECT table, name, type FROM system.columns WHERE database = {d:String} ORDER BY table, position",
        {"d": cfg["database"]})
    tables: dict = {}
    for r in rows:
        tables.setdefault(r["table"], []).append({"name": r["name"], "type": r["type"]})
    out = []
    for t, cols in tables.items():
        names = {x["name"].lower(): x["name"] for x in cols}
        mapping = {}
        for k, cands in _COL_GUESS.items():
            mapping[k] = next((names[c_] for c_ in cands if c_ in names), None)
        ohlc = all(mapping[k] for k in ("time", "open", "high", "low", "close"))
        tf = next((tf for tf, pat in _TF_PATTERNS if re.search(pat, t, re.I)), None)
        out.append({"table": t, "columns": cols, "mapping": mapping, "ohlc": ohlc, "tf_guess": tf})
    out.sort(key=lambda x: (not x["ohlc"], x["table"]))
    return {"tables": out, "timeframes": list(APP_TFS.keys())}

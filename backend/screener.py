"""Screener, strategy tester and the client of the backtester service.

The backtester (backtester/, its own container) runs the backtest engine: screens, backtests and paper-trading
steps. This module keeps the user-facing parts: saved screens (charting.screens), the universe of a screen
(all symbols of a data source, a watchlist, or a list), plan limits, and the exchange's 24h statistics added to
screener rows.

Screen spec (stored and sent by the UI):
    {source: 'BINANCE', tf: '1h', conds: [{a, op, b}], columns: [operand], universe: {type: 'all'} |
     {type: 'watchlist', id} | {type: 'symbols', symbols: [...]}, sort: {key, dir}}
    operand = {ind, p, f, tf, sh} | {px, tf, sh} | {const}; op = '<' | '>' | 'xup' | 'xdn' (crosses up / down)
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid

from . import ch, config, datasources, live, plans, store

DB = config.CH_APP_DB
BT_URL = os.environ.get("BACKTESTER_URL", "http://127.0.0.1:8090").rstrip("/")
MAX_NAME = 80


class BTError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def bt(path: str, body: dict | None = None, timeout: float = 120) -> dict:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request(BT_URL + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error") or e.reason
        except Exception:
            msg = str(e.reason)
        raise BTError(400 if e.code == 400 else 502, msg) from None
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise BTError(503, f"The backtester is not reachable ({getattr(e, 'reason', e)})") from None


def source_cfg(src) -> dict:
    """What the backtester needs to read a data source (sent with each request; nothing is stored there)."""
    return {"prefix": src.prefix, "url": src.cfg["url"], "user": src.cfg["user"], "password": src.cfg.get("password", ""),
            "db": src.db, "tables": src.tables, "cols": src.cols, "recent": src.cfg.get("recent") or "",
            "live": src.live}


def _source(prefix: str | None):
    srcs = [s for s in datasources.sources() if s.tables]
    if not srcs:
        raise ValueError("No data source with ClickHouse tables")
    if not prefix:
        return srcs[0]
    s = next((x for x in srcs if x.prefix == prefix), None)
    if not s:
        raise ValueError(f"Unknown data source {prefix}")
    return s


_meta = {"at": 0.0, "v": None}


def meta() -> dict:
    if not _meta["v"] or time.time() - _meta["at"] > 600:
        _meta["v"], _meta["at"] = bt("/meta", timeout=10), time.time()
    srcs = [{"prefix": s.prefix, "name": s.cfg["name"], "recent": bool(s.cfg.get("recent"))}
            for s in datasources.sources() if s.tables]
    return {**_meta["v"], "sources": srcs}


# --------------------------------------------------------------------------- saved screens

def list_screens(uid: str) -> list[dict]:
    rows = ch.query(f"SELECT id, name, spec, toUnixTimestamp64Milli(updated_at) AS updated_ms FROM {DB}.screens FINAL "
                    f"WHERE user_id = {{u:String}} AND deleted = 0 ORDER BY name", {"u": uid})
    return [{"id": r["id"], "name": r["name"], "spec": json.loads(r["spec"] or "{}"), "updated_ms": int(r["updated_ms"])}
            for r in rows]


def get_screen(uid: str, sid: str) -> dict | None:
    return next((s for s in list_screens(uid) if s["id"] == sid), None)


def normalize_spec(spec: dict) -> dict:
    """Validated screen spec (the backtester checks conditions and columns)."""
    if not isinstance(spec, dict):
        raise ValueError("Invalid screen")
    src = _source(spec.get("source"))
    tf = spec.get("tf") or "1h"
    conds = spec.get("conds") or []
    cols = spec.get("columns") or []
    bt("/validate", {"tf": tf, "conds": conds, "columns": cols}, timeout=10)
    u = spec.get("universe") or {"type": "all"}
    if u.get("type") == "watchlist":
        u = {"type": "watchlist", "id": str(u.get("id") or "")}
    elif u.get("type") == "symbols":
        u = {"type": "symbols", "symbols": [str(x) for x in (u.get("symbols") or [])][:2000]}
    else:
        u = {"type": "all"}
    sort = spec.get("sort") if isinstance(spec.get("sort"), dict) else None
    return {"source": src.prefix, "tf": tf, "conds": conds, "columns": cols, "universe": u,
            "sort": {"key": str(sort.get("key", ""))[:40], "dir": 1 if sort.get("dir", 1) >= 0 else -1} if sort else None}


def save_screen(user, s: dict) -> dict:
    uid = user.id
    name = str(s.get("name") or "").strip()[:MAX_NAME]
    if not name:
        raise ValueError("Name the screen")
    existing = get_screen(uid, s["id"]) if s.get("id") else None
    if not existing:
        plans.check_count(user, "saved_screens", len(list_screens(uid)), "saved screens")
    row = {"user_id": uid, "id": existing["id"] if existing else uuid.uuid4().hex, "name": name,
           "spec": json.dumps(normalize_spec(s.get("spec") or {}), separators=(",", ":")),
           "updated_at": store._ts(store._now_ms())}
    ch.insert(f"{DB}.screens", [row])
    return get_screen(uid, row["id"])


def delete_screen(uid: str, sid: str) -> None:
    ch.insert(f"{DB}.screens", [{"user_id": uid, "id": sid, "name": "", "spec": "{}", "deleted": 1,
                                 "updated_at": store._ts(store._now_ms())}])


# --------------------------------------------------------------------------- saved strategies

def list_strategies(uid: str) -> list[dict]:
    rows = ch.query(f"SELECT id, name, spec, toUnixTimestamp64Milli(updated_at) AS updated_ms FROM {DB}.strategies FINAL "
                    f"WHERE user_id = {{u:String}} AND deleted = 0 ORDER BY name", {"u": uid})
    return [{"id": r["id"], "name": r["name"], "spec": json.loads(r["spec"] or "{}"), "updated_ms": int(r["updated_ms"])}
            for r in rows]


def get_strategy(uid: str, sid: str) -> dict | None:
    return next((s for s in list_strategies(uid) if s["id"] == sid), None)


def normalize_strategy_spec(spec: dict) -> dict:
    """{strategy, symbols: {mode, list}, size, days}: the strategy is validated by the backtester."""
    if not isinstance(spec, dict):
        raise ValueError("Invalid strategy")
    bt("/validate", {"strategy": spec.get("strategy")}, timeout=10)
    st = spec.get("strategy")
    sy = spec.get("symbols") if isinstance(spec.get("symbols"), dict) else {}
    mode = str(sy.get("mode") or "current")[:80]
    lst = [str(x)[:60] for x in (sy.get("list") or []) if isinstance(x, str)][:2000]
    try:
        size = min(max(float(spec.get("size") or 1000), 1.0), 1e9)
        days = min(max(int(spec.get("days") or 365), 1), 36500)
    except (TypeError, ValueError):
        raise ValueError("Invalid size or period") from None
    return {"strategy": st, "symbols": {"mode": mode, "list": lst}, "size": size, "days": days}


def save_strategy(user, s: dict) -> dict:
    uid = user.id
    name = str(s.get("name") or "").strip()[:MAX_NAME]
    if not name:
        raise ValueError("Name the strategy")
    existing = get_strategy(uid, s["id"]) if s.get("id") else None
    if not existing:
        plans.check_count(user, "saved_strategies", len(list_strategies(uid)), "saved strategies")
    row = {"user_id": uid, "id": existing["id"] if existing else uuid.uuid4().hex, "name": name,
           "spec": json.dumps(normalize_strategy_spec(s.get("spec") or {}), separators=(",", ":")),
           "updated_at": store._ts(store._now_ms())}
    ch.insert(f"{DB}.strategies", [row])
    return get_strategy(uid, row["id"])


def delete_strategy(uid: str, sid: str) -> None:
    ch.insert(f"{DB}.strategies", [{"user_id": uid, "id": sid, "name": "", "spec": "{}", "deleted": 1,
                                    "updated_at": store._ts(store._now_ms())}])


# --------------------------------------------------------------------------- running a screen

def universe_symbols(uid: str, src, u: dict) -> list[str] | None:
    """Engine symbol names of a universe (None = every symbol of the source)."""
    if not u or u.get("type") == "all":
        return None
    if u.get("type") == "watchlist":
        wl = next((w for w in store.list_watchlists(uid) if w["id"] == u.get("id")), None)
        if not wl:
            raise ValueError("The screen's watchlist no longer exists")
        syms = wl["symbols"]
    else:
        syms = u.get("symbols") or []
    out = []
    for k in syms:
        p, _, name = k.rpartition(":")
        if not p or p == src.prefix:
            out.append(name)
    return out


def run(uid: str, spec: dict, timeout: float = 120) -> dict:
    spec = normalize_spec(spec)
    src = _source(spec["source"])
    res = bt("/screen", {"source": source_cfg(src), "tf": spec["tf"], "conds": spec["conds"], "columns": spec["columns"],
                         "symbols": universe_symbols(uid, src, spec["universe"])}, timeout=timeout)
    tick = {}
    if src.live:
        try:
            tick = live.tickers(src.live)
        except Exception as e:  # the screen works without the exchange's 24h numbers
            print(f"screener tickers: {e}")
    for r in res["rows"]:
        t = tick.get(r["symbol"])
        r["symbol"] = f"{src.prefix}:{r['symbol']}"
        if t:
            r["last"], r["chg24"], r["qvol24"] = t["last"], t["chgp"], t["qvol"]
    res["spec"] = spec
    return res


# --------------------------------------------------------------------------- strategy tester

def backtest(user, body: dict) -> dict:
    src = _source(body.get("source"))
    syms = [str(x).rpartition(":")[2] for x in (body.get("symbols") or [])]
    lim = plans.limits_of(user).get("backtest_symbols")
    if lim is not None and len(syms) > lim:
        raise plans.PlanLimit(f"Your {plans.plan_of(user)['name']} plan allows {lim} symbols per backtest run.")
    res = bt("/backtest", {"source": source_cfg(src), "strategy": body.get("strategy"), "symbols": syms,
                           "start": body.get("start"), "end": body.get("end"), "size": body.get("size") or 1000,
                           "max_symbols": max(len(syms), 1)}, timeout=300)
    for s in res["symbols"]:
        s["symbol"] = f"{src.prefix}:{s['symbol']}"
    return res


# --------------------------------------------------------------------------- warm-up

def warm_up() -> None:
    """Fill the backtester's caches in the background after a start (the first screen reads every symbol)."""
    def go():
        time.sleep(20)
        try:
            src = _source(None)
            bt("/screen", {"source": source_cfg(src), "tf": "1h", "conds": [], "columns": []}, timeout=600)
        except Exception as e:
            print(f"screener warm-up: {e}")
    threading.Thread(target=go, name="screener-warmup", daemon=True).start()

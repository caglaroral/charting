"""Per-user persisted state: watchlists, drawings, settings. Every query is scoped by user_id."""
import json
import time
import uuid

from . import ch, config

DB = config.CH_APP_DB

DEFAULT_WATCHLIST = [f"BINANCE:{s}" for s in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT")]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _ts(ms: int) -> str:
    # DateTime64(3) accepts fractional unix seconds as a string
    return f"{ms // 1000}.{ms % 1000:03d}"


# --------------------------------------------------------------------------- watchlists

def list_watchlists(uid: str) -> list[dict]:
    rows = ch.query(
        f"SELECT id, name, symbols, sort FROM {DB}.watchlists FINAL "
        f"WHERE user_id = {{u:String}} AND deleted = 0 ORDER BY sort, name",
        {"u": uid},
    )
    if not rows:
        wl = save_watchlist(uid, {"name": "Watchlist", "symbols": DEFAULT_WATCHLIST, "sort": 0})
        return [wl]
    return rows


def save_watchlist(uid: str, wl: dict) -> dict:
    row = {
        "user_id": uid,
        "id": wl.get("id") or uuid.uuid4().hex,
        "name": str(wl.get("name") or "List")[:100],
        "symbols": [str(s)[:40] for s in (wl.get("symbols") or [])][:1000],
        "sort": int(wl.get("sort") or 0),
        "updated_at": _ts(_now_ms()),
    }
    ch.insert(f"{DB}.watchlists", [row])
    return {k: row[k] for k in ("id", "name", "symbols", "sort")}


def delete_watchlist(uid: str, wid: str) -> None:
    ch.insert(f"{DB}.watchlists", [{
        "user_id": uid, "id": wid, "name": "", "symbols": [], "deleted": 1, "updated_at": _ts(_now_ms()),
    }])


# --------------------------------------------------------------------------- drawings

def list_drawings(uid: str, symbol: str) -> list[dict]:
    rows = ch.query(
        f"SELECT id, tool, data FROM {DB}.drawings FINAL "
        f"WHERE user_id = {{u:String}} AND symbol = {{s:String}} AND deleted = 0",
        {"u": uid, "s": symbol},
    )
    out = []
    for r in rows:
        try:
            d = json.loads(r["data"])
        except ValueError:
            continue
        d["id"], d["tool"] = r["id"], r["tool"]
        out.append(d)
    out.sort(key=lambda d: d.get("z", 0))
    return out


def save_drawings(uid: str, symbol: str, drawings: list[dict]) -> None:
    ms = _now_ms()
    rows = []
    for d in drawings:
        d = dict(d)
        did = str(d.pop("id", "") or uuid.uuid4().hex)
        tool = str(d.pop("tool", ""))
        rows.append({
            "user_id": uid, "symbol": symbol, "id": did, "tool": tool,
            "data": json.dumps(d, separators=(",", ":")), "updated_at": _ts(ms),
        })
    ch.insert(f"{DB}.drawings", rows)


def delete_drawings(uid: str, symbol: str, ids: list[str]) -> None:
    ms = _now_ms()
    ch.insert(f"{DB}.drawings", [
        {"user_id": uid, "symbol": symbol, "id": i, "tool": "", "data": "{}", "deleted": 1, "updated_at": _ts(ms)}
        for i in ids
    ])


# --------------------------------------------------------------------------- settings

def get_setting(uid: str, key: str):
    rows = ch.query(
        f"SELECT value FROM {DB}.settings FINAL WHERE user_id = {{u:String}} AND key = {{k:String}}",
        {"u": uid, "k": key},
    )
    if not rows:
        return None
    try:
        return json.loads(rows[0]["value"])
    except ValueError:
        return None


def set_setting(uid: str, key: str, value) -> None:
    ch.insert(f"{DB}.settings", [{
        "user_id": uid, "key": key, "value": json.dumps(value, separators=(",", ":")), "updated_at": _ts(_now_ms()),
    }])


# --------------------------------------------------------------------------- custom indicator scripts

def list_scripts(uid: str) -> list[dict]:
    return ch.query(
        f"SELECT id, name, code, toUnixTimestamp64Milli(updated_at) AS updated_ms FROM {DB}.scripts FINAL "
        f"WHERE user_id = {{u:String}} AND deleted = 0 ORDER BY name",
        {"u": uid},
    )


def get_script(uid: str, sid: str) -> dict | None:
    rows = ch.query(
        f"SELECT id, name, code FROM {DB}.scripts FINAL WHERE user_id = {{u:String}} AND id = {{i:String}} AND deleted = 0",
        {"u": uid, "i": sid},
    )
    return rows[0] if rows else None


def save_script(uid: str, sc: dict) -> dict:
    row = {
        "user_id": uid, "id": sc.get("id") or uuid.uuid4().hex,
        "name": str(sc.get("name") or "Custom")[:100], "code": str(sc.get("code") or "")[:200_000],
        "updated_at": _ts(_now_ms()),
    }
    ch.insert(f"{DB}.scripts", [row])
    return {"id": row["id"], "name": row["name"], "code": row["code"]}


def delete_script(uid: str, sid: str) -> None:
    ch.insert(f"{DB}.scripts", [{"user_id": uid, "id": sid, "name": "", "code": "", "deleted": 1, "updated_at": _ts(_now_ms())}])

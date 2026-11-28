"""Paper trading: strategies of the backtest engine run forward on new closed bars, without orders.

Each paper strategy trades a list of symbols with the engine's rules (signal at a bar's close, fill at the next
open, one position per symbol, stop / take-profit, fees and slippage) and a fixed position size. The engine loop
asks the backtester to advance every active strategy (POST /paper) with its state per symbol:
    {symbol: {resume, last, open, last_close, status}}
`resume` is the first bar whose signal is not yet acted on (the signal bar of the open position, or the last
processed bar). Closed trades are written to charting.paper_trades; the open position is kept in the state and
marked to the last close. Changing the strategy or the symbols starts a new run; earlier runs' trades are kept.
"""
import json
import sys
import threading
import time
import traceback
import uuid

from . import ch, config, datasources, notify, plans, screener, store

DB = config.CH_APP_DB
POLL_SECONDS = 30
MAX_NAME = 80

_COLS = ("id, name, source, strategy, symbols, size, channels, active, run, started_at, state, "
         "toUnixTimestamp64Milli(created_at) AS created_ms, toUnixTimestamp64Milli(updated_at) AS updated_ms")


def _out(r: dict) -> dict:
    return {"id": r["id"], "name": r["name"], "source": r["source"], "strategy": json.loads(r["strategy"] or "{}"),
            "symbols": list(r["symbols"]), "size": float(r["size"]), "channels": json.loads(r["channels"] or "[]"),
            "active": bool(int(r["active"])), "run": int(r["run"]), "started_at": int(r["started_at"]),
            "state": json.loads(r["state"] or "{}"), "created_ms": int(r["created_ms"]), "updated_ms": int(r["updated_ms"])}


def _rows(where: str, params: dict) -> list[dict]:
    return [_out(r) for r in ch.query(
        f"SELECT user_id, {_COLS} FROM {DB}.papers FINAL WHERE deleted = 0 AND {where} ORDER BY created_at", params)]


def list_papers(uid: str) -> list[dict]:
    out = _rows("user_id = {u:String}", {"u": uid})
    stats = {(r["paper_id"], int(r["run"])): r for r in ch.query(
        f"SELECT paper_id, run, count() AS n, sum(net) AS total, countIf(net > 0) AS wins, sumIf(net, net > 0) AS gp, "
        f"-sumIf(net, net < 0) AS gl FROM {DB}.paper_trades FINAL WHERE user_id = {{u:String}} GROUP BY paper_id, run",
        {"u": uid})}
    for p in out:
        s = stats.get((p["id"], p["run"]))
        opens = [v["open"] for v in p["state"].values() if v.get("open")]
        n = int(s["n"]) if s else 0
        p["summary"] = {
            "trades": n, "net": float(s["total"]) if s else 0.0,
            "win_pct": (int(s["wins"]) / n * 100) if n else None,
            "profit_factor": (float(s["gp"]) / float(s["gl"])) if s and float(s["gl"]) > 0 else None,
            "open": len(opens), "upnl": sum(o.get("upnl") or 0 for o in opens),
        }
    return out


def get_paper(uid: str, pid: str) -> dict | None:
    r = _rows("user_id = {u:String} AND id = {i:String}", {"u": uid, "i": pid})
    return r[0] if r else None


def _write(uid: str, p: dict, updated_ms: int | None = None) -> None:
    row = {"user_id": uid, "id": p["id"], "name": p["name"], "source": p["source"],
           "strategy": json.dumps(p["strategy"], separators=(",", ":")), "symbols": p["symbols"], "size": p["size"],
           "channels": json.dumps(p["channels"]), "active": int(p["active"]), "run": p["run"],
           "started_at": p["started_at"], "state": json.dumps(p["state"], separators=(",", ":")),
           "updated_at": store._ts(updated_ms or store._now_ms())}
    if p.get("created_ms"):
        row["created_at"] = f"{p['created_ms'] // 1000}.{p['created_ms'] % 1000:03d}"
    ch.insert(f"{DB}.papers", [row])


def save_paper(user, body: dict) -> dict:
    uid = user.id
    name = str(body.get("name") or "").strip()[:MAX_NAME]
    if not name:
        raise ValueError("Name the paper-trading strategy")
    src = screener._source(body.get("source"))
    strategy = body.get("strategy")
    screener.bt("/validate", {"strategy": strategy}, timeout=10)
    syms = list(dict.fromkeys(f"{src.prefix}:{str(x).rpartition(':')[2].strip().upper()}"
                              for x in (body.get("symbols") or []) if str(x).strip()))
    if not syms:
        raise ValueError("Choose at least one symbol")
    lim = plans.limits_of(user)
    if lim.get("paper_symbols") is not None and len(syms) > lim["paper_symbols"]:
        raise plans.PlanLimit(f"Your {plans.plan_of(user)['name']} plan allows {lim['paper_symbols']} symbols per paper-trading strategy.")
    size = float(body.get("size") or 1000)
    if not 1 <= size <= 1e9:
        raise ValueError("Position size must be a positive amount")
    allowed = lim.get("alert_channels") or list(notify.CHANNELS)
    channels = [c for c in (body.get("channels") or []) if c in notify.CHANNELS]
    bad = [c for c in channels if c not in allowed]
    if bad:
        raise plans.PlanLimit(f"Channel(s) {', '.join(bad)} are not available on the {plans.plan_of(user)['name']} plan.")
    active = bool(body.get("active", True))
    existing = get_paper(uid, body["id"]) if body.get("id") else None
    if active and (not existing or not existing["active"]):
        n = sum(1 for x in _rows("user_id = {u:String}", {"u": uid}) if x["active"])
        plans.check_count(user, "paper_trades", n, "active paper-trading strategies")
    now = int(time.time())
    if existing:
        p = dict(existing)
        restart = (p["strategy"] != strategy or p["symbols"] != syms or p["source"] != src.prefix or p["size"] != size)
        if restart:
            p.update(run=p["run"] + 1, started_at=now, state={})
        elif active and not p["active"]:
            # resuming: bars missed while paused are not traded
            p.update(run=p["run"] + 1, started_at=now, state={})
    else:
        p = {"id": uuid.uuid4().hex, "run": 1, "started_at": now, "state": {}, "created_ms": 0}
    p.update(name=name, source=src.prefix, strategy=strategy, symbols=syms, size=size, channels=channels, active=active)
    _write(uid, p)
    return get_paper(uid, p["id"])


def reset_paper(uid: str, pid: str) -> dict:
    p = get_paper(uid, pid)
    if not p:
        raise ValueError("Not found")
    p.update(run=p["run"] + 1, started_at=int(time.time()), state={})
    _write(uid, p)
    return get_paper(uid, pid)


def delete_paper(uid: str, pid: str) -> None:
    p = get_paper(uid, pid)
    if not p:
        return
    p.update(active=False)
    ch.insert(f"{DB}.papers", [{"user_id": uid, "id": pid, "name": "", "source": "", "strategy": "{}", "symbols": [],
                                "started_at": 0, "deleted": 1, "updated_at": store._ts(store._now_ms())}])


def trades(uid: str, pid: str, run: int | None = None, limit: int = 1000) -> list[dict]:
    q = (f"SELECT run, symbol, side, entry_time, exit_time, entry_price, exit_price, net FROM {DB}.paper_trades FINAL "
         f"WHERE user_id = {{u:String}} AND paper_id = {{p:String}}")
    params = {"u": uid, "p": pid, "n": limit}
    if run is not None:
        q += " AND run = {r:UInt32}"
        params["r"] = run
    return ch.query(q + " ORDER BY exit_time DESC LIMIT {n:UInt32}", params)


# --------------------------------------------------------------------------- engine

def _fmt(x: float) -> str:
    return f"{x:.6g}"


def step(p: dict, uid: str) -> None:
    src = datasources.by_prefix(p["source"])
    if not src:
        return
    names = [s.rpartition(":")[2] for s in p["symbols"]]
    state = {s.rpartition(":")[2]: v for s, v in p["state"].items()}
    res = screener.bt("/paper", {"source": screener.source_cfg(src), "strategy": p["strategy"], "symbols": names,
                                 "state": {k: [v.get("resume"), v.get("last")] for k, v in state.items() if v.get("resume")},
                                 "start": p["started_at"], "size": p["size"]}, timeout=120)["symbols"]
    new_state, new_trades, events = {}, [], []
    tf = p["strategy"].get("tf")
    for name, r in res.items():
        key = f"{src.prefix}:{name}"
        old = state.get(name, {})
        st = r.get("status")
        if st in ("skip", None):
            new_state[key] = old
            continue
        if st == "ok":
            for t in r["trades"]:
                new_trades.append({"user_id": uid, "paper_id": p["id"], "run": p["run"], "symbol": key, "side": t["side"],
                                   "entry_time": t["entry_ts"], "exit_time": t["exit_ts"], "entry_price": t["entry_px"],
                                   "exit_price": t["exit_px"], "net": t["net"]})
                events.append(f"Closed {'long' if t['side'] > 0 else 'short'} {key} at {_fmt(t['exit_px'])}: "
                              f"{t['net']:+.2f}")
            op = r.get("open")
            prev_open = old.get("open")
            if op and (not prev_open or prev_open.get("entry_ts") != op["entry_ts"]):
                events.append(f"Opened {'long' if op['side'] > 0 else 'short'} {key} at {_fmt(op['entry_px'])}")
            new_state[key] = {"resume": r["resume"], "last": r["last_ts"], "open": op, "last_close": r["last_close"],
                              "status": "ok"}
        elif st == "gap" and not old.get("open"):
            # a gap in the data: skip past it rather than stall (no position is affected)
            new_state[key] = {**old, "resume": r["last_ts"], "last": r["last_ts"], "status": "gap"}
        else:
            new_state[key] = {**old, **{k: r[k] for k in ("last_close",) if k in r}, "status": st}
    if new_state == p["state"] and not new_trades:
        return
    # skip the write if the user changed the strategy meanwhile
    cur = get_paper(uid, p["id"])
    if not cur or cur["updated_ms"] != p["updated_ms"] or not cur["active"]:
        return
    if new_trades:
        ch.insert(f"{DB}.paper_trades", new_trades)
    p = dict(p, state=new_state)
    _write(uid, p, max(store._now_ms(), p["updated_ms"] + 1))
    if events and p["channels"]:
        msg = "\n".join(events[:20]) + (f"\n… and {len(events) - 20} more" if len(events) > 20 else "")
        notify.dispatch(uid, p["channels"], f"📈 Paper: {p['name']} ({tf})", msg,
                        {"paper_id": p["id"], "message": msg})


def run_once() -> None:
    rows = ch.query(f"SELECT user_id, {_COLS} FROM {DB}.papers FINAL WHERE deleted = 0 AND active = 1")
    for r in rows:
        try:
            step(_out(r), r["user_id"])
        except screener.BTError as e:
            print(f"paper {r['id']}: {e}", file=sys.stderr)
        except Exception:
            traceback.print_exc()


def start_engine() -> None:
    def loop():
        time.sleep(15)
        while True:
            try:
                run_once()
            except Exception as e:
                print(f"paper engine error: {e}", file=sys.stderr)
            time.sleep(POLL_SECONDS)
    threading.Thread(target=loop, name="paper-engine", daemon=True).start()

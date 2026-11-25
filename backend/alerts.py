"""Alerts: storage + a background evaluation engine.

Alert kinds
  price      spec = {"price": float}
  drawing    spec = {"drawing_id": str}            (geometry is read live from charting.drawings)
  indicator  spec = {"type" (builtin name or "custom"), "script_id"?, "params", "plot",
                    "target": {"type": "value", "value": x} | {"type": "plot", "plot": k}, "tz"}
             Indicators are computed by the same JS as the browser (jsrunner -> Node worker).

Conditions: crossing, crossing_up, crossing_down, greater, less, entering, exiting (two-level targets),
            signal (a custom plotshape() condition is true on the bar)
Frequency : once (deactivates after firing) | once_per_bar

The engine re-evaluates every bar whose time >= alert.last_bar, so the newest (possibly still forming)
bar is checked on every pass; an alert fires at most once per bar (last_fired).
"""
import json
import sys
import threading
import time
import traceback
import uuid

from . import ch, config, jsrunner, market, notify, plans, store

DB = config.CH_APP_DB
POLL_SECONDS = 20
WARMUP_BARS = 600

CONDS = {"crossing", "crossing_up", "crossing_down", "greater", "less", "entering", "exiting", "signal"}
LINE_TOOLS = {"trend", "ray", "extended", "hline", "hray"}
ZONE_TOOLS = {"rect", "channel"}

COND_TEXT = {
    "crossing": "crossing", "crossing_up": "crossing up", "crossing_down": "crossing down",
    "greater": "greater than", "less": "less than", "entering": "entering channel", "exiting": "exiting channel",
    "signal": "signal",
}

_COLS = ("id, symbol, tf, kind, cond, spec, frequency, message, channels, active, last_bar, last_fired, fired_count, "
         "toUnixTimestamp64Milli(created_at) AS created_ms, toUnixTimestamp64Milli(updated_at) AS updated_ms")


def _row_out(r: dict) -> dict:
    r = dict(r)
    try:
        r["spec"] = json.loads(r["spec"])
    except ValueError:
        r["spec"] = {}
    try:
        r["channels"] = json.loads(r.get("channels") or '["app"]')
    except ValueError:
        r["channels"] = ["app"]
    for k in ("active", "last_bar", "last_fired", "fired_count", "created_ms", "updated_ms"):
        r[k] = int(r[k])
    return r


# --------------------------------------------------------------------------- CRUD

# --------------------------------------------------------------------------- history
LOG_EVENTS = ("created", "updated", "paused", "resumed", "deleted", "triggered", "delivered", "failed", "deactivated")


def log(uid: str, alert: dict, event: str, **kw) -> None:
    """Append one history row; never raises into the caller (history must not break alerts)."""
    try:
        log_many([dict(user_id=uid, alert_id=alert.get("id", ""), event=event, symbol=alert.get("symbol", ""),
                       tf=alert.get("tf", ""), summary=_summary(alert), **kw)])
    except Exception:
        traceback.print_exc()


def log_many(rows: list[dict]) -> None:
    for r in rows:
        r["detail"] = str(r.get("detail", ""))[:500]
    if rows:
        ch.insert(f"{DB}.alert_log", rows)


def _summary(alert: dict) -> str:
    try:
        return alert.get("message") or _default_message(alert)
    except Exception:
        return alert.get("symbol", "")


def list_log(uid: str, alert_id: str = "", before_ms: int = 0, limit: int = 100, event: str = "") -> list[dict]:
    where = ["user_id = {u:String}"]
    params = {"u": uid, "n": max(1, min(int(limit), 500))}
    if alert_id:
        where.append("alert_id = {a:String}"); params["a"] = alert_id
    if before_ms:
        where.append("created_at < fromUnixTimestamp64Milli(toInt64({b:UInt64}))"); params["b"] = int(before_ms)
    if event:
        evs = [e for e in event.split(",") if e in LOG_EVENTS]
        if evs:
            where.append("event IN {e:Array(String)}"); params["e"] = evs
    return ch.query(
        f"SELECT alert_id, event, symbol, tf, channel, ok, price, bar_time, summary, detail, "
        f"toUnixTimestamp64Milli(created_at) AS created_ms FROM {DB}.alert_log WHERE {' AND '.join(where)} "
        f"ORDER BY created_at DESC LIMIT {{n:UInt32}}", params)


def list_alerts(uid: str) -> list[dict]:
    rows = ch.query(f"SELECT {_COLS} FROM {DB}.alerts FINAL WHERE user_id = {{u:String}} AND deleted = 0 "
                    f"ORDER BY created_at DESC", {"u": uid})
    return [_row_out(r) for r in rows]


def get_alert(uid: str, aid: str) -> dict | None:
    rows = ch.query(f"SELECT {_COLS} FROM {DB}.alerts FINAL WHERE user_id = {{u:String}} AND id = {{i:String}} "
                    f"AND deleted = 0", {"u": uid, "i": aid})
    return _row_out(rows[0]) if rows else None


def _latest_bar_time(symbol: str, tf: str) -> int:
    b = market.recent_bars(symbol, tf, 2)
    return int(b[-1][0]) if b else 0


def save_alert(user, a: dict) -> dict:
    """user: auth.User (plan limits are enforced here and in the engine)."""
    uid = user.id
    symbol = str(a.get("symbol", "")).strip()
    if not market.known_symbol(symbol):
        raise ValueError("Unknown symbol")
    kind = a.get("kind")
    cond = a.get("cond")
    if kind not in ("price", "drawing", "indicator") or cond not in CONDS:
        raise ValueError("Invalid alert")
    spec = a.get("spec") or {}
    tf = a.get("tf") if kind == "indicator" else "1m"
    if tf not in market.TIMEFRAMES:
        raise ValueError("Invalid timeframe")
    if kind == "price":
        spec = {"price": float(spec["price"])}
    elif kind == "drawing":
        if not spec.get("drawing_id"):
            raise ValueError("drawing_id is required")
        spec = {"drawing_id": str(spec["drawing_id"]), "tool": str(spec.get("tool", ""))}
    else:
        if spec.get("type") == "custom":
            if not store.get_script(uid, str(spec.get("script_id", ""))):
                raise ValueError("Custom indicator not found")
        elif spec.get("type") not in _indicator_types():
            raise ValueError("Unknown indicator")
        if not spec.get("plot"):
            raise ValueError("plot is required")

    existing = get_alert(uid, a["id"]) if a.get("id") else None
    active = int(bool(a.get("active", 1)))
    # ---- plan limits
    lim = plans.limits_of(user)
    if kind == "indicator":
        plans.check_flag(user, "indicator_alerts", "Indicator alerts")
        if spec.get("type") == "custom":
            plans.check_flag(user, "custom_indicator_alerts", "Alerts on custom indicators")
    if active and (not existing or not existing["active"]):
        n_active = sum(1 for x in list_alerts(uid) if x["active"])
        plans.check_count(user, "active_alerts", n_active, "active alerts")
    allowed = lim.get("alert_channels") or list(notify.CHANNELS)
    bad = [c for c in (a.get("channels") or []) if c not in allowed]
    if bad:
        raise plans.PlanLimit(f"Channel(s) {', '.join(bad)} are not available on the {plans.plan_of(user)['name']} plan.")
    # (Re)arming starts evaluation from the current bar so history never fires.
    rearm = not existing or (active and not existing["active"]) or existing["tf"] != tf
    row = {
        "user_id": uid,
        "id": existing["id"] if existing else uuid.uuid4().hex,
        "symbol": symbol, "tf": tf, "kind": kind, "cond": cond,
        "spec": json.dumps(spec, separators=(",", ":")),
        "frequency": a.get("frequency") if a.get("frequency") in ("once", "once_per_bar") else "once",
        "message": str(a.get("message") or "")[:500],
        "channels": json.dumps(sorted({"app", *[c for c in (a.get("channels") or []) if c in notify.CHANNELS]})),
        "active": active,
        "last_bar": _latest_bar_time(symbol, tf) if rearm else existing["last_bar"],
        "last_fired": 0 if rearm else existing["last_fired"],
        "fired_count": existing["fired_count"] if existing else 0,
        "updated_at": store._ts(store._now_ms()),
    }
    if existing:
        row["created_at"] = f"{existing['created_ms'] // 1000}.{existing['created_ms'] % 1000:03d}"
    ch.insert(f"{DB}.alerts", [row])
    saved = get_alert(uid, row["id"])
    if not existing:
        ev = "created"
    elif existing["active"] and not active:
        ev = "paused"
    elif active and not existing["active"]:
        ev = "resumed"
    else:
        ev = "updated"
    log(uid, saved, ev, detail="channels: " + ", ".join(saved["channels"]))
    return saved


def delete_alert(uid: str, aid: str) -> None:
    old = get_alert(uid, aid)
    if old:
        log(uid, old, "deleted")
    ch.insert(f"{DB}.alerts", [{"user_id": uid, "id": aid, "symbol": "", "tf": "", "kind": "", "cond": "",
                                "spec": "{}", "channels": "[]", "active": 0, "deleted": 1, "updated_at": store._ts(store._now_ms())}])


def list_events(uid: str, since_ms: int = 0, limit: int = 100) -> list[dict]:
    return ch.query(
        f"SELECT alert_id, symbol, tf, toUInt32(bar_time) AS bar_time, price, message, "
        f"toUnixTimestamp64Milli(created_at) AS created_ms FROM {DB}.alert_events "
        f"WHERE user_id = {{u:String}} AND created_at > fromUnixTimestamp64Milli(toInt64({{s:UInt64}})) "
        f"ORDER BY created_at DESC LIMIT {{n:UInt32}}",
        {"u": uid, "s": since_ms, "n": limit},
    )


def _indicator_types():
    return {"sma", "ema", "wma", "mas", "bb", "donchian", "keltner", "vwap", "supertrend", "psar", "volume",
            "rsi", "macd", "stoch", "stochrsi", "atr", "cci", "adx", "obv", "mfi", "willr", "roc"}


# --------------------------------------------------------------------------- geometry

def _interp(p0, p1, t):
    if p1["t"] == p0["t"]:
        return None
    return p0["p"] + (p1["p"] - p0["p"]) * (t - p0["t"]) / (p1["t"] - p0["t"])


def drawing_levels(d: dict, t: int):
    """Return (lo, hi) for zone tools, (v, v) for line tools, or None if not defined at time t."""
    tool, pts = d.get("tool"), d.get("points") or []
    if tool in ("hline", "crossline") and pts:
        v = pts[0]["p"]; return (v, v)
    if tool == "hray" and pts:
        return (pts[0]["p"],) * 2 if t >= pts[0]["t"] else None
    if len(pts) < 2:
        return None
    p0, p1 = pts[0], pts[1]
    if tool == "trend":
        if not (min(p0["t"], p1["t"]) <= t <= max(p0["t"], p1["t"])):
            return None
    elif tool == "ray":
        if (t - p0["t"]) * (p1["t"] - p0["t"]) < 0:
            return None
    elif tool == "rect":
        return (min(p0["p"], p1["p"]), max(p0["p"], p1["p"]))
    elif tool == "channel":
        if len(pts) < 3 or t < min(p0["t"], p1["t"]):
            return None
        base = _interp(p0, p1, t)
        off = pts[2]["p"] - (_interp(p0, p1, pts[2]["t"]) or 0)
        if base is None:
            return None
        return (min(base, base + off), max(base, base + off))
    elif tool != "extended":
        return None
    v = _interp(p0, p1, t)
    return None if v is None else (v, v)


# --------------------------------------------------------------------------- evaluation

def _check(cond, prev_x, x, x_hi, x_lo, prev_lv, lv):
    """prev_x/x: value at previous/current bar (close or indicator); x_hi/x_lo: intrabar extremes.
    prev_lv/lv: (lo, hi) target levels."""
    if lv is None:
        return False
    lo, hi = lv
    if cond == "greater":
        return x > hi
    if cond == "less":
        return x < lo
    if prev_lv is None or prev_x is None:
        return False
    plo, phi = prev_lv
    if cond in ("crossing", "crossing_up") and prev_x < phi and x_hi >= hi:
        return True
    if cond in ("crossing", "crossing_down") and prev_x > plo and x_lo <= lo:
        return True
    inside_prev, inside = plo <= prev_x <= phi, lo <= x <= hi
    if cond == "entering":
        return not inside_prev and inside
    if cond == "exiting":
        return inside_prev and not inside
    return False


def _bars_dicts(rows):
    return [{"time": int(r[0]), "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]} for r in rows]


def _indicator_plots(alert: dict, raw_bars: list[list]) -> dict | None:
    spec = alert["spec"]
    req = {"params": spec.get("params") or {}, "tz": int(spec.get("tz", 0))}
    if spec.get("type") == "custom":
        sc = store.get_script(alert["user_id"], str(spec.get("script_id", "")))
        if not sc:
            return None
        tf = alert["tf"]
        env = {"tf": tf, "tfSec": market.TIMEFRAMES[tf], "tfSecs": market.TIMEFRAMES, "htf": {}}
        req.update(kind="custom", code=sc["code"], env=env)
        for _ in range(4):
            res = jsrunner.compute(req, raw_bars)
            if not res.get("requests"):
                return res["plots"]
            for htf in res["requests"]:
                if htf not in market.TIMEFRAMES:
                    raise ValueError(f"security(): unknown timeframe {htf}")
                env["htf"][htf] = market.recent_bars(alert["symbol"], htf, 1500)
        raise ValueError("security() data unavailable")
    req.update(kind="builtin", type=spec["type"])
    return jsrunner.compute(req, raw_bars)["plots"]


def _evaluate(alert: dict, bars: list[dict], drawings: dict, raw_bars=None):
    """Return ([(bar_time, price)], new_last_bar)."""
    if len(bars) < 2:
        return [], alert["last_bar"]
    start = next((i for i, b in enumerate(bars) if b["time"] >= alert["last_bar"]), len(bars))
    start = max(start, 1)
    spec, kind, cond = alert["spec"], alert["kind"], alert["cond"]

    if kind == "indicator":
        out = _indicator_plots(alert, raw_bars)
        if out is None:
            return None, bars[-1]["time"]  # script deleted -> caller deactivates
        series = out.get(spec.get("plot"))
        if series is None:
            return [], bars[-1]["time"]
        if cond == "signal":
            fired = []
            for i in range(start, len(bars)):
                if series[i] and bars[i]["time"] != alert["last_fired"]:
                    fired.append((bars[i]["time"], bars[i]["close"]))
                    if alert["frequency"] == "once":
                        break
            return fired, bars[-1]["time"]
        tgt = spec.get("target") or {}
        if tgt.get("type") == "plot":
            other = out.get(tgt.get("plot")) or [None] * len(bars)
            level = lambda i: None if other[i] is None else (other[i], other[i])
        else:
            v = float(tgt.get("value", 0))
            level = lambda i: (v, v)
        xs = series
        his = los = series
    else:
        xs = [b["close"] for b in bars]
        his = [b["high"] for b in bars]
        los = [b["low"] for b in bars]
        if kind == "price":
            v = float(spec["price"])
            level = lambda i: (v, v)
        else:
            d = drawings.get(spec.get("drawing_id"))
            if d is None:
                return None, bars[-1]["time"]  # drawing deleted -> caller deactivates
            level = lambda i: drawing_levels(d, bars[i]["time"])

    fired = []
    for i in range(start, len(bars)):
        x = xs[i]
        if x is None or bars[i]["time"] == alert["last_fired"]:
            continue
        if _check(cond, xs[i - 1], x, his[i], los[i], level(i - 1), level(i)):
            fired.append((bars[i]["time"], bars[i]["close"]))
            if alert["frequency"] == "once":
                break
    return fired, bars[-1]["time"]


def _default_message(alert):
    spec = alert["spec"]
    c = COND_TEXT.get(alert["cond"], alert["cond"])
    if alert["kind"] == "price":
        return f"{alert['symbol']} price {c} {spec['price']}"
    if alert["kind"] == "drawing":
        return f"{alert['symbol']} drawing ({spec.get('tool', '')}) {c}"
    tgt = spec.get("target") or {}
    rhs = "" if alert["cond"] == "signal" else tgt.get("plot") if tgt.get("type") == "plot" else tgt.get("value")
    name = spec.get("name") or spec.get("type", "").upper()
    return f"{alert['symbol']} {alert['tf']} {name}.{spec.get('plot')} {c} {rhs}".strip()


_last_eval: dict = {}  # alert id -> last evaluation time (plan-based evaluation interval)


def _due_alerts(alerts_: list[dict]) -> list[dict]:
    """Apply plan limits in the engine: evaluation interval and max active alerts per user
    (oldest alerts win if a user was downgraded below their current alert count)."""
    users = {r["id"]: r for r in ch.query(f"SELECT id, plan, is_admin FROM {DB}.users FINAL WHERE deleted = 0")}
    by_user: dict = {}
    for a in sorted(alerts_, key=lambda x: x["created_ms"]):
        by_user.setdefault(a["user_id"], []).append(a)
    now = time.time()
    due = []
    for uid, lst in by_user.items():
        u = users.get(uid)
        if not u:
            continue
        lim = plans.limits_of({"plan": u["plan"], "is_admin": bool(int(u["is_admin"]))})
        cap = lim.get("active_alerts")
        interval = lim.get("alert_interval_sec") or POLL_SECONDS
        for a in lst[:cap] if cap is not None else lst:
            if now - _last_eval.get(a["id"], 0) >= interval - 1:
                _last_eval[a["id"]] = now
                due.append(a)
    return due


def run_once() -> int:
    rows = ch.query(f"SELECT user_id, {_COLS} FROM {DB}.alerts FINAL WHERE deleted = 0 AND active = 1")
    if not rows:
        return 0
    alerts_ = _due_alerts([dict(_row_out(r), user_id=r["user_id"]) for r in rows])
    groups: dict[tuple, list] = {}
    for a in alerts_:
        groups.setdefault((a["symbol"], a["tf"]), []).append(a)

    fired_total = 0
    for (symbol, tf), group in groups.items():
        sec = market.TIMEFRAMES[tf]
        oldest = min(a["last_bar"] for a in group)
        # One request per (symbol, tf) group: bars since the oldest evaluated bar, plus indicator warmup.
        # The live provider keeps a bar cache, so after the first pass only the newest bars are fetched.
        has_ind = any(a["kind"] == "indicator" for a in group)
        need = int((time.time() - oldest) / sec) + 2 if oldest else 2
        limit = max(10, min(1500, need + (WARMUP_BARS if has_ind else 2)))
        try:
            raw = market.recent_bars(symbol, tf, limit)
        except Exception as e:
            print(f"alert bars {symbol} {tf}: {e}")
            continue
        if not raw:
            continue
        bars = _bars_dicts(raw)

        drawings = {}
        for a in group:
            if a["kind"] == "drawing" and a["user_id"] not in drawings:
                drawings[a["user_id"]] = {d["id"]: d for d in store.list_drawings(a["user_id"], symbol)}

        for a in group:
            try:
                fired, new_last = _evaluate(a, bars, drawings.get(a["user_id"], {}), raw)
            except Exception:
                traceback.print_exc()
                continue
            deactivate = fired is None
            fired = fired or []
            if not fired and new_last == a["last_bar"] and not deactivate:
                continue
            # Skip the write if the user changed/deleted the alert while we were evaluating.
            cur = ch.query(f"SELECT toUnixTimestamp64Milli(updated_at) AS u FROM {DB}.alerts FINAL "
                           f"WHERE user_id = {{u:String}} AND id = {{i:String}} AND deleted = 0 AND active = 1",
                           {"u": a["user_id"], "i": a["id"]})
            if not cur or int(cur[0]["u"]) != a["updated_ms"]:
                continue
            msg = a["message"] or _default_message(a)
            base = dict(user_id=a["user_id"], alert_id=a["id"], symbol=symbol, tf=tf, summary=msg)
            if fired:
                ch.insert(f"{DB}.alert_events", [{
                    "user_id": a["user_id"], "alert_id": a["id"], "symbol": symbol, "tf": tf,
                    "bar_time": t, "price": p, "message": msg} for t, p in fired])
                fired_total += len(fired)
                t, p = fired[-1]
                try:
                    log_many([dict(base, event="triggered", price=fp, bar_time=int(ft)) for ft, fp in fired]
                             + [dict(base, event="delivered", channel="app", price=p, bar_time=int(t), detail="in-app notification")])
                except Exception:
                    traceback.print_exc()

                def delivered(result, base=base, t=t, p=p):
                    log_many([dict(base, event="delivered" if r == "ok" else "failed", channel=c, ok=int(r == "ok"),
                                   price=p, bar_time=int(t), detail="" if r == "ok" else r) for c, r in result.items()])
                notify.dispatch(a["user_id"], a["channels"], f"🔔 {symbol} alert", msg, {
                    "alert_id": a["id"], "symbol": symbol, "tf": tf, "kind": a["kind"], "cond": a["cond"],
                    "bar_time": t, "price": p, "message": msg, "count": len(fired)}, on_result=delivered)
            if deactivate or (fired and a["frequency"] == "once"):
                reason = ("triggered (frequency: once)" if fired and not deactivate else
                          "the drawing was deleted" if a["kind"] == "drawing" else "the custom indicator was deleted")
                try:
                    log_many([dict(base, event="deactivated", detail=reason)])
                except Exception:
                    traceback.print_exc()
            row = {
                "user_id": a["user_id"], "id": a["id"], "symbol": symbol, "tf": tf, "kind": a["kind"],
                "cond": a["cond"], "spec": json.dumps(a["spec"], separators=(",", ":")),
                "frequency": a["frequency"], "message": a["message"], "channels": json.dumps(a["channels"]),
                "active": 0 if deactivate or (fired and a["frequency"] == "once") else 1,
                "last_bar": new_last,
                "last_fired": fired[-1][0] if fired else a["last_fired"],
                "fired_count": a["fired_count"] + len(fired),
                "created_at": f"{a['created_ms'] // 1000}.{a['created_ms'] % 1000:03d}",
                "updated_at": store._ts(max(store._now_ms(), a["updated_ms"] + 1)),
            }
            ch.insert(f"{DB}.alerts", [row])
    return fired_total


def start_engine() -> None:
    def loop():
        while True:
            try:
                run_once()
            except Exception as e:  # keep the engine alive on transient DB errors
                print(f"alert engine error: {e}", file=sys.stderr)
            time.sleep(POLL_SECONDS)
    threading.Thread(target=loop, name="alert-engine", daemon=True).start()

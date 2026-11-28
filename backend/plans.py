"""Subscription plans and per-user limits.

A plan is a named set of limits (JSON). A limit value of None means unlimited.
Users reference a plan by id (charting.users.plan). Admins default to the 'unlimited' plan.
"""
import json
import threading
import time

from . import ch, config

DB = config.CH_APP_DB

# limit key -> (description, type)
LIMITS = {
    "active_alerts": ("Active alerts", "int"),
    "indicator_alerts": ("Indicator alerts allowed", "bool"),
    "custom_indicator_alerts": ("Custom indicator alerts allowed", "bool"),
    "alert_channels": ("Notification channels", "channels"),
    "alert_interval_sec": ("Alert evaluation interval (seconds)", "int"),
    "custom_scripts": ("Custom indicators (scripts)", "int"),
    "watchlists": ("Watchlists", "int"),
    "watchlist_symbols": ("Symbols per watchlist", "int"),
    "indicators_per_chart": ("Indicators per chart", "int"),
    "saved_screens": ("Saved screens", "int"),
    "saved_strategies": ("Saved strategies", "int"),
    "screener_alerts": ("Screener alerts allowed", "bool"),
    "backtest_symbols": ("Symbols per backtest run", "int"),
    "paper_trades": ("Paper-trading strategies", "int"),
    "paper_symbols": ("Symbols per paper-trading strategy", "int"),
}

DEFAULT_PLANS = [
    {"id": "free", "name": "Free", "sort": 0, "limits": {
        "active_alerts": 5, "indicator_alerts": True, "custom_indicator_alerts": False,
        "alert_channels": ["app", "telegram"], "alert_interval_sec": 60, "custom_scripts": 3,
        "watchlists": 2, "watchlist_symbols": 30, "indicators_per_chart": 5,
        "saved_screens": 5, "saved_strategies": 5, "screener_alerts": False, "backtest_symbols": 5, "paper_trades": 1, "paper_symbols": 10}},
    {"id": "pro", "name": "Pro", "sort": 1, "limits": {
        "active_alerts": 50, "indicator_alerts": True, "custom_indicator_alerts": True,
        "alert_channels": ["app", "telegram", "email", "webhook"], "alert_interval_sec": 20, "custom_scripts": 25,
        "watchlists": 10, "watchlist_symbols": 200, "indicators_per_chart": 15,
        "saved_screens": 50, "saved_strategies": 50, "screener_alerts": True, "backtest_symbols": 30, "paper_trades": 10, "paper_symbols": 100}},
    {"id": "premium", "name": "Premium", "sort": 2, "limits": {
        "active_alerts": 400, "indicator_alerts": True, "custom_indicator_alerts": True,
        "alert_channels": ["app", "telegram", "email", "webhook"], "alert_interval_sec": 20, "custom_scripts": 100,
        "watchlists": 50, "watchlist_symbols": 1000, "indicators_per_chart": 30,
        "saved_screens": 200, "saved_strategies": 200, "screener_alerts": True, "backtest_symbols": 100, "paper_trades": 50, "paper_symbols": 500}},
    {"id": "unlimited", "name": "Unlimited", "sort": 3, "limits": {
        "active_alerts": None, "indicator_alerts": True, "custom_indicator_alerts": True,
        "alert_channels": ["app", "telegram", "email", "webhook"], "alert_interval_sec": 20, "custom_scripts": None,
        "watchlists": None, "watchlist_symbols": None, "indicators_per_chart": None,
        "saved_screens": None, "saved_strategies": None, "screener_alerts": True, "backtest_symbols": None, "paper_trades": None, "paper_symbols": None}},
]


class PlanLimit(Exception):
    """Raised when an action exceeds the user's plan. Message is shown to the user."""


_lock = threading.Lock()
_cache = {"at": 0.0, "plans": None}


def _load() -> dict:
    rows = ch.query(f"SELECT id, name, limits, sort FROM {DB}.plans FINAL WHERE deleted = 0 ORDER BY sort, id")
    return {r["id"]: {"id": r["id"], "name": r["name"], "sort": int(r["sort"]), "limits": json.loads(r["limits"] or "{}")}
            for r in rows}


def all_plans() -> dict:
    with _lock:
        if _cache["plans"] is None or time.time() - _cache["at"] > 30:
            _cache["plans"], _cache["at"] = _load(), time.time()
        return _cache["plans"]


def bootstrap() -> None:
    if all_plans():
        return
    for p in DEFAULT_PLANS:
        save(p)


def save(p: dict) -> dict:
    pid = str(p.get("id") or "").strip().lower()
    if not pid or not pid.replace("_", "").replace("-", "").isalnum():
        raise ValueError("Plan id must be alphanumeric")
    limits = {}
    for k, (_, typ) in LIMITS.items():
        v = (p.get("limits") or {}).get(k)
        if v is None or v == "":
            limits[k] = None
        elif typ == "int":
            limits[k] = int(v)
        elif typ == "bool":
            limits[k] = bool(v)
        else:
            limits[k] = [c for c in v if c in ("app", "telegram", "email", "webhook")]
    ch.insert(f"{DB}.plans", [{"id": pid, "name": str(p.get("name") or pid)[:60], "limits": json.dumps(limits),
                                "sort": int(p.get("sort") or 0), "updated_at": f"{time.time():.3f}"}])
    with _lock:
        _cache["plans"] = None
    return all_plans()[pid]


def delete(pid: str) -> None:
    ch.insert(f"{DB}.plans", [{"id": pid, "name": "", "limits": "{}", "deleted": 1, "updated_at": f"{time.time():.3f}"}])
    with _lock:
        _cache["plans"] = None


def plan_of(user) -> dict:
    """user: auth.User or dict with plan / is_admin."""
    plans = all_plans()
    pid = getattr(user, "plan", None) if not isinstance(user, dict) else user.get("plan")
    is_admin = getattr(user, "is_admin", False) if not isinstance(user, dict) else user.get("is_admin")
    if not pid:
        pid = "unlimited" if is_admin else "free"
    return plans.get(pid) or plans.get("free") or {"id": "free", "name": "Free", "limits": {}}


_DEFAULTS = {p["id"]: p["limits"] for p in DEFAULT_PLANS}


def limits_of(user) -> dict:
    """The plan's limits; a limit the stored plan predates takes the default plan's value of the same id
    (none for a custom plan = unlimited)."""
    p = plan_of(user)
    return {**_DEFAULTS.get(p["id"], {}), **p["limits"]}


def check_count(user, key: str, current: int, what: str) -> None:
    lim = limits_of(user).get(key)
    if lim is not None and current >= lim:
        raise PlanLimit(f"Your {plan_of(user)['name']} plan allows {lim} {what}. Upgrade the plan for more.")


def check_flag(user, key: str, what: str) -> None:
    if limits_of(user).get(key) is False:
        raise PlanLimit(f"{what} are not available on the {plan_of(user)['name']} plan.")

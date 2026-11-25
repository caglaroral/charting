"""Alert notification channels: in-app (always), Telegram, e-mail (SMTP) and webhook.

Global settings (admin): SMTP server and Telegram bot token, stored encrypted in charting.settings
under user_id '__global__'. Per-user settings: e-mail address, Telegram chat id, webhook URL.
Delivery runs on a small thread pool so a slow channel never blocks the alert engine.
"""
import json
import smtplib
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage

from . import datasources, store

GLOBAL_UID = "__global__"
CHANNELS = ("app", "telegram", "email", "webhook")
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="notify")


# --------------------------------------------------------------------------- settings

def get_global(reveal: bool = False) -> dict:
    g = store.get_setting(GLOBAL_UID, "notify") or {}
    smtp = dict(g.get("smtp") or {})
    tg = dict(g.get("telegram") or {})
    if reveal:
        smtp["password"] = _dec(smtp.pop("password_enc", ""))
        tg["bot_token"] = _dec(tg.pop("bot_token_enc", ""))
    else:
        smtp["has_password"] = bool(smtp.pop("password_enc", ""))
        tg["has_bot_token"] = bool(tg.pop("bot_token_enc", ""))
    return {"smtp": smtp, "telegram": tg}


def server_status() -> dict:
    """Which server-side channels an admin has set up (no secrets)."""
    g = get_global()
    return {"smtp": bool(g["smtp"].get("host")), "telegram": bool(g["telegram"].get("has_bot_token"))}


def set_global(cfg: dict) -> None:
    cur = store.get_setting(GLOBAL_UID, "notify") or {}
    smtp_in, tg_in = cfg.get("smtp") or {}, cfg.get("telegram") or {}
    smtp = {k: smtp_in.get(k) for k in ("host", "port", "user", "from", "security")}
    smtp["port"] = int(smtp.get("port") or 587)
    smtp["password_enc"] = (datasources.encrypt(smtp_in["password"]) if smtp_in.get("password")
                            else (cur.get("smtp") or {}).get("password_enc", ""))
    tg = {"bot_token_enc": (datasources.encrypt(tg_in["bot_token"]) if tg_in.get("bot_token")
                            else (cur.get("telegram") or {}).get("bot_token_enc", ""))}
    store.set_setting(GLOBAL_UID, "notify", {"smtp": smtp, "telegram": tg})


def _dec(v: str) -> str:
    try:
        return datasources.decrypt(v) if v else ""
    except ValueError:
        return ""


def get_user(uid: str) -> dict:
    u = store.get_setting(uid, "notify") or {}
    return {"email": u.get("email", ""), "telegram_chat_id": u.get("telegram_chat_id", ""),
            "webhook_url": u.get("webhook_url", ""), "default_channels": u.get("default_channels", ["app"])}


def set_user(uid: str, cfg: dict) -> None:
    url = str(cfg.get("webhook_url") or "").strip()
    if url and not url.startswith(("http://", "https://")):
        raise ValueError("Webhook URL must start with http:// or https://")
    store.set_setting(uid, "notify", {
        "email": str(cfg.get("email") or "").strip()[:200],
        "telegram_chat_id": str(cfg.get("telegram_chat_id") or "").strip()[:64],
        "webhook_url": url[:500],
        "default_channels": [c for c in cfg.get("default_channels") or ["app"] if c in CHANNELS],
    })


# --------------------------------------------------------------------------- senders

def _telegram(token: str, chat_id: str, text: str) -> None:
    body = json.dumps({"chat_id": chat_id, "text": text, "disable_web_page_preview": True}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def _email(smtp: dict, to: str, subject: str, text: str) -> None:
    msg = EmailMessage()
    msg["From"] = smtp.get("from") or smtp.get("user")
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    host, port, sec = smtp["host"], int(smtp.get("port") or 587), smtp.get("security") or "starttls"
    ctx = ssl.create_default_context()
    if sec == "ssl":
        s = smtplib.SMTP_SSL(host, port, context=ctx, timeout=20)
    else:
        s = smtplib.SMTP(host, port, timeout=20)
        if sec == "starttls":
            s.starttls(context=ctx)
    try:
        if smtp.get("user"):
            s.login(smtp["user"], smtp.get("password", ""))
        s.send_message(msg)
    finally:
        s.quit()


def _webhook(url: str, payload: dict) -> None:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "charting-alerts/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()


def send(uid: str, channels: list[str], title: str, text: str, payload: dict) -> dict:
    """Deliver synchronously; returns {channel: 'ok' | error}. 'app' is handled by alert_events."""
    g = get_global(reveal=True)
    u = get_user(uid)
    result = {}
    for ch in channels:
        try:
            if ch == "telegram":
                if not g["telegram"].get("bot_token") or not u["telegram_chat_id"]:
                    raise ValueError("Telegram bot token (admin) or chat id (user) not configured")
                _telegram(g["telegram"]["bot_token"], u["telegram_chat_id"], f"{title}\n{text}")
            elif ch == "email":
                if not g["smtp"].get("host") or not u["email"]:
                    raise ValueError("SMTP server (admin) or e-mail address (user) not configured")
                _email(g["smtp"], u["email"], title, text)
            elif ch == "webhook":
                if not u["webhook_url"]:
                    raise ValueError("Webhook URL not configured")
                _webhook(u["webhook_url"], payload)
            else:
                continue
            result[ch] = "ok"
        except Exception as e:  # report, never raise into the alert engine
            result[ch] = str(e)[:300]
    return result


def dispatch(uid: str, channels: list[str], title: str, text: str, payload: dict, on_result=None) -> None:
    """Deliver in the background; on_result({channel: 'ok' | error}) records the outcome (alert history)."""
    chans = [c for c in channels if c != "app"]
    if not chans:
        return

    def run():
        res = send(uid, chans, title, text, payload)
        bad = {k: v for k, v in res.items() if v != "ok"}
        if bad:
            print(f"notify {uid}: {bad}")
        if on_result:
            try:
                on_result(res)
            except Exception as e:  # history must never break delivery
                print(f"notify history {uid}: {e}")
    _pool.submit(run)

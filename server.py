#!/usr/bin/env python3
"""Charting app server (stdlib only).

  python3 server.py                       # run the web server
  python3 server.py adduser NAME [--admin] # create a local user (prompts for password)
  python3 server.py passwd NAME            # reset a local user's password
  python3 server.py users                  # list users
"""
import getpass
import gzip
import json
import mimetypes
import sys
import traceback
from http import cookies as http_cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from backend import alerts, auth, ch, config, datasources, live, market, notify, paper, plans, screener, store

PROVIDER = auth.make_provider()


class HttpError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status, self.msg = status, msg


def _symbol(v) -> str:
    s = (v or "").strip()
    if ":" not in s and s:
        r = datasources.resolve(s.upper())
        s = f"{r[0].prefix}:{r[1]}" if r else s
    if not s or not market.known_symbol(s):
        raise HttpError(404, f"Unknown symbol: {s}")
    return s


class Handler(BaseHTTPRequestHandler):
    server_version = "Charting/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------ plumbing
    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _cookies(self) -> dict:
        c = http_cookies.SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
        except http_cookies.CookieError:
            return {}
        return {k: m.value for k, m in c.items()}

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 5_000_000:
            raise HttpError(413, "Body too large")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise HttpError(400, "Invalid JSON")

    def _send(self, status: int, body: bytes, ctype: str, extra_headers: dict | None = None, cache: str = "no-store"):
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 5)
            extra_headers = {**(extra_headers or {}), "Content-Encoding": "gzip"}
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for k, v in (extra_headers or {}).items():
            if isinstance(v, list):
                for x in v:
                    self.send_header(k, x)
            else:
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200, headers=None):
        self._send(status, json.dumps(obj, separators=(",", ":")).encode(), "application/json", headers)

    def _user(self) -> auth.User:
        user = PROVIDER.identify(self.headers, self._cookies())
        if not user:
            raise HttpError(401, "Login required")
        return user

    # ------------------------------------------------------------------ dispatch
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str):
        url = urlparse(self.path)
        try:
            if url.path.startswith("/api/"):
                q = {k: v[-1] for k, v in parse_qs(url.query).items()}
                self._api(method, url.path[5:].strip("/").split("/"), q)
            elif method == "GET":
                self._static(url.path)
            else:
                raise HttpError(405, "Method not allowed")
        except HttpError as e:
            self._json({"error": e.msg}, e.status)
        except auth.AuthError as e:
            self._json({"error": str(e)}, 400)
        except screener.BTError as e:
            self._json({"error": str(e)}, e.status)
        except plans.PlanLimit as e:
            self._json({"error": str(e), "plan_limit": True}, 402)
        except market.NotFound as e:
            self._json({"error": str(e)}, 404)
        except ch.CHError as e:
            sys.stderr.write(f"ClickHouse error: {e}\n")
            self._json({"error": "Database error", "detail": str(e)[:500]}, 502)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self._json({"error": "Server error"}, 500)

    def _static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        f = (config.STATIC_DIR / path.lstrip("/")).resolve()
        if not str(f).startswith(str(config.STATIC_DIR.resolve())) or not f.is_file():
            raise HttpError(404, "Not found")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        cache = "public, max-age=86400" if "/vendor/" in str(f) else "no-cache"
        self._send(200, f.read_bytes(), ctype, cache=cache)

    # ------------------------------------------------------------------ API
    def _api(self, method: str, parts: list[str], q: dict):
        route = parts[0]

        # ---- auth (public)
        if route == "auth":
            sub = parts[1] if len(parts) > 1 else ""
            if sub == "config" and method == "GET":
                return self._json({"mode": PROVIDER.name, "password_login": PROVIDER.supports_password_login})
            if sub == "login" and method == "POST":
                b = self._body()
                user, token = PROVIDER.login(str(b.get("username", "")), str(b.get("password", "")))
                cookie = (f"{auth.SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
                          f"Max-Age={config.SESSION_DAYS * 86400}")
                return self._json({"user": user.public()}, headers={"Set-Cookie": cookie})
            if sub == "logout" and method == "POST":
                PROVIDER.logout(self._cookies())
                return self._json({"ok": True}, headers={
                    "Set-Cookie": f"{auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})
            if sub == "password" and method == "POST":
                user = self._user()
                b = self._body()
                if user.auth_provider != "local":
                    raise HttpError(400, "Password is managed by the identity provider")
                PROVIDER.login(user.username, str(b.get("old_password", "")))  # verifies old password
                auth.set_password(user.id, str(b.get("new_password", "")))
                return self._json({"ok": True})
            raise HttpError(404, "Not found")

        user = self._user()
        uid = user.id

        if route == "me":
            p = plans.plan_of(user)
            return self._json({"user": user.public(), "plan": {**p, "limits": plans.limits_of(user)}})

        # ---- admin
        if route == "admin":
            if not user.is_admin:
                raise HttpError(403, "Forbidden")
            if parts[1:2] == ["datasources"]:
                sub = parts[2] if len(parts) > 2 else ""
                try:
                    if method == "GET" and not sub:
                        return self._json({"datasources": [x.public() for x in datasources.sources(enabled_only=False)],
                                           "timeframes": list(datasources.APP_TFS)})
                    if method == "POST" and sub == "test":
                        return self._json(datasources.test_connection(self._body()))
                    if method == "POST" and sub == "discover":
                        return self._json(datasources.discover(self._body()))
                    if method == "POST" and not sub:
                        ds = datasources.save(self._body())
                        market.invalidate_symbols()
                        return self._json({"datasource": ds})
                    if method == "DELETE" and sub:
                        datasources.delete(sub)
                        market.invalidate_symbols()
                        return self._json({"ok": True})
                except ValueError as e:
                    raise HttpError(400, str(e))
                except ch.CHError as e:
                    raise HttpError(400, f"ClickHouse: {str(e)[:300]}")
            if parts[1:2] == ["notify"]:
                if method == "GET":
                    return self._json(notify.get_global())
                if method in ("POST", "PUT"):
                    notify.set_global(self._body())
                    return self._json(notify.get_global())
            if parts[1:2] == ["ratelimit"] and method == "GET":
                return self._json({"usage": live.usage(), "budget": live.WEIGHT_BUDGET})
            if parts[1:2] == ["plans"]:
                try:
                    if method == "GET":
                        return self._json({"plans": list(plans.all_plans().values()), "limits": plans.LIMITS})
                    if method in ("POST", "PUT"):
                        return self._json({"plan": plans.save(self._body())})
                    if method == "DELETE" and len(parts) > 2:
                        plans.delete(parts[2])
                        return self._json({"ok": True})
                except ValueError as e:
                    raise HttpError(400, str(e))
            if parts[1:2] == ["users"]:
                if method == "GET":
                    return self._json({"users": auth.list_users()})
                if method == "DELETE" and len(parts) > 2:
                    if parts[2] == uid:
                        raise HttpError(400, "You cannot delete yourself")
                    # ?purge=1 removes the user and all their data for good (used by the e2e suite)
                    if q.get("purge") in ("1", "true"):
                        auth.purge_user(parts[2])
                    else:
                        auth.delete_user(parts[2])
                    return self._json({"ok": True})
                if method == "POST" and len(parts) > 2:
                    b = self._body()
                    if b.get("plan") is not None and b["plan"] and b["plan"] not in plans.all_plans():
                        raise HttpError(400, "Unknown plan")
                    u = auth.update_user(parts[2], plan=b.get("plan"), is_admin=b.get("is_admin"))
                    return self._json({"user": u.public()})
                if method == "POST":
                    b = self._body()
                    u = auth.create_local_user(str(b.get("username", "")), str(b.get("password", "")),
                                               display_name=str(b.get("display_name", "")),
                                               is_admin=bool(b.get("is_admin")), plan=str(b.get("plan") or ""))
                    return self._json({"user": u.public()})
            raise HttpError(404, "Not found")

        # ---- market data
        if route == "symbols":
            return self._json({"symbols": market.symbols(),
                               "sources": [{"prefix": x.prefix, "name": x.cfg["name"], "live": x.live,
                                            "timeframes": list(x.plan.keys())} for x in datasources.sources()]})
        if route == "timeframes":
            return self._json({"timeframes": [{"tf": k, "seconds": v} for k, v in market.TIMEFRAMES.items()]})
        if route == "bars":
            sym = _symbol(q.get("symbol"))
            tf = q.get("tf", "1h")
            if tf not in market.TIMEFRAMES:
                raise HttpError(400, "Invalid timeframe")
            to = int(q["to"]) if q.get("to") else None
            limit = int(q.get("limit", 1500))
            return self._json({"symbol": sym, "tf": tf, "bars": market.bars(sym, tf, to, limit)})
        if route == "quotes":
            syms = [s.strip() for s in q.get("symbols", "").split(",") if s.strip()][:500]
            return self._json({"quotes": market.quotes(syms)})
        if route == "symbol":
            return self._json(market.symbol_info(_symbol(q.get("symbol"))))

        # ---- per-user state
        if route == "watchlists":
            if method == "GET":
                return self._json({"watchlists": store.list_watchlists(uid)})
            if method in ("POST", "PUT"):
                b = self._body()
                lists = store.list_watchlists(uid)
                if not any(w["id"] == b.get("id") for w in lists):
                    plans.check_count(user, "watchlists", len(lists), "watchlists")
                lim = plans.limits_of(user).get("watchlist_symbols")
                if lim is not None and len(b.get("symbols") or []) > lim:
                    raise plans.PlanLimit(f"Your {plans.plan_of(user)['name']} plan allows {lim} symbols per watchlist.")
                return self._json({"watchlist": store.save_watchlist(uid, b)})
            if method == "DELETE" and len(parts) > 1:
                store.delete_watchlist(uid, parts[1])
                return self._json({"ok": True})
        if route == "drawings":
            if method == "GET":
                return self._json({"drawings": store.list_drawings(uid, _symbol(q.get("symbol")))})
            b = self._body()
            sym = _symbol(b.get("symbol"))
            if method == "POST" and parts[1:2] == ["delete"]:
                store.delete_drawings(uid, sym, [str(i) for i in b.get("ids", [])])
                return self._json({"ok": True})
            if method in ("POST", "PUT"):
                store.save_drawings(uid, sym, list(b.get("drawings", [])))
                return self._json({"ok": True})
        if route == "alerts":
            if method == "GET" and parts[1:2] == ["log"]:
                return self._json({"log": alerts.list_log(uid, q.get("alert_id", ""), int(q.get("before", 0) or 0),
                                                         int(q.get("limit", 100)), q.get("event", ""))})
            if method == "GET" and parts[1:2] == ["events"]:
                return self._json({"events": alerts.list_events(uid, int(q.get("since", 0)), int(q.get("limit", 100)))})
            if method == "GET":
                return self._json({"alerts": alerts.list_alerts(uid)})
            if method in ("POST", "PUT"):
                try:
                    return self._json({"alert": alerts.save_alert(user, self._body())})
                except (ValueError, KeyError, TypeError) as e:
                    raise HttpError(400, f"Invalid alert: {e}")
            if method == "DELETE" and len(parts) > 1:
                alerts.delete_alert(uid, parts[1])
                return self._json({"ok": True})
        if route == "notify":
            if method == "GET":
                return self._json({**notify.get_user(uid), "server": notify.server_status()})
            if method in ("POST", "PUT") and parts[1:2] == ["test"]:
                b = self._body()
                chans = [c for c in b.get("channels", []) if c in notify.CHANNELS and c != "app"]
                return self._json({"result": notify.send(uid, chans, "🔔 Test alert", "This is a test notification from Charting.",
                                                          {"test": True, "message": "This is a test notification from Charting."})})
            if method in ("POST", "PUT"):
                try:
                    notify.set_user(uid, self._body())
                except ValueError as e:
                    raise HttpError(400, str(e))
                return self._json(notify.get_user(uid))
        if route == "scripts":
            if method == "GET":
                return self._json({"scripts": store.list_scripts(uid)})
            if method in ("POST", "PUT"):
                b = self._body()
                mine = store.list_scripts(uid)
                if not any(x["id"] == b.get("id") for x in mine):
                    plans.check_count(user, "custom_scripts", len(mine), "custom indicators")
                return self._json({"script": store.save_script(uid, b)})
            if method == "DELETE" and len(parts) > 1:
                store.delete_script(uid, parts[1])
                return self._json({"ok": True})
        # ---- screener, strategy tester, paper trading (backtester service)
        if route == "screener":
            if method == "GET" and parts[1:2] == ["meta"]:
                return self._json(screener.meta())
            if method == "POST" and parts[1:2] == ["run"]:
                try:
                    return self._json(screener.run(uid, self._body().get("spec") or {}))
                except ValueError as e:
                    raise HttpError(400, str(e))
        if route == "screens":
            if method == "GET":
                return self._json({"screens": screener.list_screens(uid)})
            if method in ("POST", "PUT"):
                try:
                    return self._json({"screen": screener.save_screen(user, self._body())})
                except ValueError as e:
                    raise HttpError(400, str(e))
            if method == "DELETE" and len(parts) > 1:
                screener.delete_screen(uid, parts[1])
                return self._json({"ok": True})
        if route == "backtest" and method == "POST":
            try:
                return self._json(screener.backtest(user, self._body()))
            except ValueError as e:
                raise HttpError(400, str(e))
        if route == "papers":
            if method == "GET" and len(parts) > 2 and parts[2] == "trades":
                run = q.get("run")
                return self._json({"trades": paper.trades(uid, parts[1], int(run) if run else None)})
            if method == "GET":
                return self._json({"papers": paper.list_papers(uid)})
            if method == "POST" and len(parts) > 2 and parts[2] == "reset":
                try:
                    return self._json({"paper": paper.reset_paper(uid, parts[1])})
                except ValueError as e:
                    raise HttpError(404, str(e))
            if method in ("POST", "PUT"):
                try:
                    return self._json({"paper": paper.save_paper(user, self._body())})
                except (ValueError, TypeError) as e:
                    raise HttpError(400, str(e))
            if method == "DELETE" and len(parts) > 1:
                paper.delete_paper(uid, parts[1])
                return self._json({"ok": True})
        if route == "settings" and len(parts) > 1:
            key = parts[1][:64]
            if method == "GET":
                return self._json({"value": store.get_setting(uid, key)})
            if method in ("POST", "PUT"):
                store.set_setting(uid, key, self._body().get("value"))
                return self._json({"ok": True})

        raise HttpError(404, "Not found")


# --------------------------------------------------------------------------- CLI

def _cli(argv: list[str]) -> None:
    cmd = argv[0]
    ch.apply_schema()
    if cmd == "adduser":
        name = argv[1]
        pw = getpass.getpass("Password: ")
        if pw != getpass.getpass("Password (again): "):
            sys.exit("Passwords do not match")
        u = auth.create_local_user(name, pw, is_admin="--admin" in argv)
        print("Created:", u.public())
    elif cmd == "passwd":
        row = auth._find_user_row("local", username=argv[1])
        if not row:
            sys.exit("No such user")
        auth.set_password(row["id"], getpass.getpass("New password: "))
        print("Password updated")
    elif cmd == "users":
        for u in auth.list_users():
            print(u)
    else:
        sys.exit(__doc__)


def main():
    if len(sys.argv) > 1:
        return _cli(sys.argv[1:])
    ch.apply_schema()
    datasources.bootstrap_default()
    try:
        datasources.migrate_recent()
    except Exception as e:
        print(f"datasource migration: {e}", file=sys.stderr)
    plans.bootstrap()
    if PROVIDER.name == "local" and auth.count_users() == 0:
        print("WARNING: no users yet. Create one: python3 server.py adduser <name> --admin", file=sys.stderr)
    alerts.start_engine()
    paper.start_engine()
    screener.warm_up()
    srv = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    srv.daemon_threads = True
    print(f"Charting server: http://{config.HOST}:{config.PORT}  (auth={PROVIDER.name})", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

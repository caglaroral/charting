"""Pluggable authentication.

Every request is resolved to an internal user (charting.users.id). All user data is keyed by
that id, so swapping the provider (local -> IAM/OIDC) only changes how a request is mapped
to a user, never the data model.

Providers:
  local  - username/password (PBKDF2) + opaque session token cookie stored in charting.sessions
  header - an auth proxy / IAM gateway in front of the app authenticates the user and passes
           identity in trusted headers. Users are auto-provisioned on first sight.
  none   - single-user dev mode.

To add IAM (OIDC/JWT) later: implement a provider with identify() that validates the bearer
token / cookie and calls users.upsert_external(provider, subject, ...). Nothing else changes.
"""
import hashlib
import hmac
import secrets
import threading
import time
import uuid
from dataclasses import dataclass

from . import ch, config

DB = config.CH_APP_DB
SESSION_COOKIE = "chart_session"


@dataclass
class User:
    id: str
    username: str
    display_name: str
    email: str
    is_admin: bool
    auth_provider: str
    plan: str = ''

    def public(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "display_name": self.display_name or self.username,
            "email": self.email,
            "is_admin": self.is_admin,
            "auth_provider": self.auth_provider,
            "plan": self.plan,
        }


class AuthError(Exception):
    pass


# --------------------------------------------------------------------------- passwords

_PBKDF2_ITER = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _PBKDF2_ITER)
    return f"pbkdf2_sha256${_PBKDF2_ITER}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, it, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(it))
        return hmac.compare_digest(dk.hex(), digest)
    except ValueError:
        return False


# --------------------------------------------------------------------------- user store

_USER_COLS = "id, username, display_name, email, is_admin, auth_provider, password_hash, plan"


def _row_to_user(r: dict) -> User:
    return User(
        id=r["id"],
        username=r["username"],
        display_name=r["display_name"],
        email=r["email"],
        is_admin=bool(int(r["is_admin"])),
        auth_provider=r["auth_provider"],
        plan=r.get("plan", ""),
    )


def get_user(user_id: str) -> User | None:
    rows = ch.query(
        f"SELECT {_USER_COLS} FROM {DB}.users FINAL WHERE id = {{id:String}} AND deleted = 0",
        {"id": user_id},
    )
    return _row_to_user(rows[0]) if rows else None


def _find_user_row(provider: str, *, username: str | None = None, external_id: str | None = None) -> dict | None:
    if external_id is not None:
        cond, params = "external_id = {v:String}", {"v": external_id}
    else:
        cond, params = "lower(username) = lower({v:String})", {"v": username}
    rows = ch.query(
        f"SELECT {_USER_COLS} FROM {DB}.users FINAL "
        f"WHERE deleted = 0 AND auth_provider = {{p:String}} AND {cond} LIMIT 1",
        {**params, "p": provider},
    )
    return rows[0] if rows else None


def list_users() -> list[dict]:
    rows = ch.query(f"SELECT {_USER_COLS} FROM {DB}.users FINAL WHERE deleted = 0 ORDER BY username")
    return [_row_to_user(r).public() for r in rows]


def create_local_user(username: str, password: str, *, display_name: str = "", email: str = "", is_admin: bool = False,
                      plan: str = "") -> User:
    username = username.strip()
    if not username or len(password) < 6:
        raise AuthError("Username is required and password must be at least 6 characters")
    if _find_user_row("local", username=username):
        raise AuthError("Username already exists")
    uid = uuid.uuid4().hex
    ch.insert(f"{DB}.users", [{
        "id": uid, "auth_provider": "local", "external_id": username.lower(), "username": username,
        "email": email, "password_hash": hash_password(password), "display_name": display_name,
        "is_admin": int(is_admin), "plan": plan,
    }])
    return get_user(uid)


def set_password(user_id: str, password: str) -> None:
    rows = ch.query(f"SELECT * FROM {DB}.users FINAL WHERE id = {{id:String}} AND deleted = 0", {"id": user_id})
    if not rows:
        raise AuthError("User not found")
    if len(password) < 6:
        raise AuthError("Password must be at least 6 characters")
    r = rows[0]
    r["password_hash"] = hash_password(password)
    r.pop("updated_at", None)
    ch.insert(f"{DB}.users", [r])


def upsert_external(provider: str, external_id: str, username: str, email: str = "") -> User:
    """Map an external identity (proxy header, IAM/OIDC subject) to an internal user, creating it if needed."""
    row = _find_user_row(provider, external_id=external_id)
    if row:
        return _row_to_user(row)
    uid = uuid.uuid4().hex
    ch.insert(f"{DB}.users", [{
        "id": uid, "auth_provider": provider, "external_id": external_id,
        "username": username or external_id, "email": email,
    }])
    return get_user(uid)


def count_users() -> int:
    return int(ch.query(f"SELECT count() c FROM {DB}.users FINAL WHERE deleted = 0")[0]["c"])


# --------------------------------------------------------------------------- identity cache

class _TTLCache:
    def __init__(self, ttl: float):
        self.ttl, self.data, self.lock = ttl, {}, threading.Lock()

    def get(self, k):
        with self.lock:
            v = self.data.get(k)
            if v and v[0] > time.time():
                return v[1]
            self.data.pop(k, None)
            return None

    def put(self, k, v):
        with self.lock:
            self.data[k] = (time.time() + self.ttl, v)

    def drop(self, k):
        with self.lock:
            self.data.pop(k, None)


_cache = _TTLCache(60)


# --------------------------------------------------------------------------- providers

class AuthProvider:
    name = "base"
    supports_password_login = False

    def identify(self, headers, cookies: dict) -> User | None:
        raise NotImplementedError

    def login(self, username: str, password: str) -> tuple[User, str]:
        raise AuthError("Password login is not available in this auth mode")

    def logout(self, cookies: dict) -> None:
        pass


class LocalAuthProvider(AuthProvider):
    name = "local"
    supports_password_login = True

    def identify(self, headers, cookies):
        token = cookies.get(SESSION_COOKIE)
        if not token:
            return None
        cached = _cache.get(("s", token))
        if cached:
            return cached
        rows = ch.query(
            f"SELECT user_id FROM {DB}.sessions FINAL "
            f"WHERE token = {{t:String}} AND deleted = 0 AND expires_at > now()",
            {"t": _token_hash(token)},
        )
        if not rows:
            return None
        user = get_user(rows[0]["user_id"])
        if user:
            _cache.put(("s", token), user)
        return user

    def login(self, username, password):
        row = _find_user_row("local", username=username)
        if not row or not verify_password(password, row["password_hash"]):
            raise AuthError("Invalid username or password")
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + config.SESSION_DAYS * 86400
        ch.insert(f"{DB}.sessions", [{"token": _token_hash(token), "user_id": row["id"], "expires_at": expires}])
        return _row_to_user(row), token

    def logout(self, cookies):
        token = cookies.get(SESSION_COOKIE)
        if token:
            _cache.drop(("s", token))
            ch.insert(f"{DB}.sessions", [{"token": _token_hash(token), "user_id": "", "expires_at": 0, "deleted": 1}])


class HeaderAuthProvider(AuthProvider):
    """Trust identity headers set by an authenticating reverse proxy / IAM gateway.
    Only safe when the app is reachable exclusively through that proxy."""
    name = "header"

    def identify(self, headers, cookies):
        ext = (headers.get(config.AUTH_HEADER_USER) or "").strip()
        if not ext:
            return None
        cached = _cache.get(("h", ext))
        if cached:
            return cached
        email = (headers.get(config.AUTH_HEADER_EMAIL) or "").strip()
        user = upsert_external(config.AUTH_HEADER_PROVIDER, ext, ext, email)
        _cache.put(("h", ext), user)
        return user


class NoAuthProvider(AuthProvider):
    name = "none"

    def identify(self, headers, cookies):
        cached = _cache.get(("dev",))
        if cached:
            return cached
        user = upsert_external("dev", "dev", "dev")
        _cache.put(("dev",), user)
        return user


def _token_hash(token: str) -> str:
    # Store only a hash of the session token, so a DB read does not leak live sessions.
    return hashlib.sha256(token.encode()).hexdigest()


def make_provider() -> AuthProvider:
    return {"local": LocalAuthProvider, "header": HeaderAuthProvider, "none": NoAuthProvider}[config.AUTH_MODE]()


def update_user(user_id: str, *, plan: str | None = None, is_admin: bool | None = None, display_name: str | None = None) -> User:
    """Admin edits: plan assignment, admin flag, display name."""
    rows = ch.query(f"SELECT * FROM {DB}.users FINAL WHERE id = {{id:String}} AND deleted = 0", {"id": user_id})
    if not rows:
        raise AuthError("User not found")
    r = rows[0]
    if plan is not None:
        r["plan"] = plan
    if is_admin is not None:
        r["is_admin"] = int(is_admin)
    if display_name is not None:
        r["display_name"] = display_name
    r.pop("updated_at", None)
    ch.insert(f"{DB}.users", [r])
    _cache.data.clear()
    return get_user(user_id)


def delete_user(user_id: str) -> None:
    """Soft-delete a user (their sessions stop resolving immediately)."""
    rows = ch.query(f"SELECT * FROM {DB}.users FINAL WHERE id = {{id:String}} AND deleted = 0", {"id": user_id})
    if not rows:
        raise AuthError("User not found")
    r = rows[0]
    r["deleted"] = 1
    r.pop("updated_at", None)
    ch.insert(f"{DB}.users", [r])
    _cache.data.clear()

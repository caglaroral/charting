# Security

## Authentication and IAM

Every request is resolved to an internal user (`users.id`) by an **auth provider**; all data is keyed
by that id, so changing the provider never touches user data.

| `AUTH_MODE` | Behaviour |
| --- | --- |
| `local` | username/password (PBKDF2-SHA256, 200k iterations), opaque session cookie (`HttpOnly`, `SameSite=Lax`); only a SHA-256 of the token is stored |
| `header` | an authenticating proxy / IAM gateway in front of the app sets `X-Auth-Request-User` (and optionally e-mail); users are provisioned on first sight. Only safe when the app is reachable exclusively through that proxy |
| `none` | single-user development mode |

**Moving to IAM / OIDC**: either run an auth proxy (oauth2-proxy, an IAM gateway …) with
`AUTH_MODE=header`, or add a provider class in `backend/auth.py` whose `identify()` validates the
bearer token / cookie and calls `upsert_external(provider, subject, username, email)`.
`users(auth_provider, external_id)` maps the external identity to the internal user.

## Tenancy

Every per-user query filters by the authenticated `user_id` (drawings, settings, watchlists, scripts,
alerts, events). Admin endpoints check `is_admin`. ClickHouse queries use server-side parameters
(`{name:Type}`), never string interpolation; identifiers chosen in the data source UI are quoted.

## Secrets

`.env` holds the app database credentials and `SECRET_KEY` (mode 600, git-ignored). Data source
passwords, the SMTP password and the Telegram token are encrypted with `SECRET_KEY`
(SHA-256 CTR keystream + HMAC tag).

## User code (custom indicators)

Custom indicators are untrusted code and run isolated on both sides.

**Browser** (`static/js/sandbox.js`):
- a hidden `<iframe sandbox="allow-scripts">` (opaque origin: no cookies, no access to the app DOM or
  API) with a CSP of `default-src 'none'` (no network);
- the iframe creates the Web Worker that executes the code, so the worker inherits the iframe's opaque
  origin and CSP; a run longer than 3 s makes the iframe replace the worker, so the page never freezes;
- runs and results travel over a `MessageChannel` port handed to the worker (they do not pass through
  the iframe); only plain data crosses: code text, inputs, bars as transferred `Float64Array` columns
  (only the changed part after the first run) and results.

Do not create the worker from the page itself: it would run in the app's origin, where user code
could call the API with the user's session cookie.

**Server** (`backend/jsrunner.py`, `backend/jsworker.js`, `backend/jsgate.js`):

With Docker the code runs in its own container, `jsworker`:
- `network_mode: none`: the container has only a loopback interface, no route anywhere (not to
  ClickHouse, the LAN, the backend or the internet);
- read-only root file system, all capabilities dropped, `no-new-privileges`, user `nobody`, memory
  and process limits;
- no secrets: it gets neither `.env` nor any backend environment variable;
- the backend reaches it only through a Unix socket on the shared `jsrun` volume. `jsgate.js`
  starts a fresh worker process per connection and kills it when the connection closes; the backend
  closes the connection when a request misses its deadline.

Inside the container, and also when running without Docker:
- the whole indicator runtime is evaluated inside a fresh `vm` context per request and only strings
  cross the boundary, so no host-realm object (`process`, host `Function`) is reachable;
- `vm` timeout and `microtaskMode: 'afterEvaluate'` stop synchronous and promise loops; WebAssembly
  is disabled;
- Node's permission model (`--permission`) allows reading only the runtime files: no file writes,
  child processes or worker threads, and from Node 25 no network access either;
- the worker process starts with an empty environment;
- without Docker it runs as `nobody` (`setpriv`) with limits (`prlimit`) and, when the host allows
  it, in an empty network namespace (`unshare --net`);
- each request has a wall-clock deadline; a hung or crashed worker is killed and restarted.

Why the network matters: `vm` is not a complete security boundary on its own. If user code ever
escaped it, the worker process is shared by all users' alerts, so it could read other users' scripts
and bars passing through it. Without a network it cannot send them anywhere, cannot reach internal
services, and cannot use the server's IP (e.g. against the shared exchange rate limit).

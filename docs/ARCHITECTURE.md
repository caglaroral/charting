# Architecture

```
 Browser (static/)                               Backend (server.py + backend/)              ClickHouse
 ┌──────────────────────────────┐   /api/*    ┌───────────────────────────────────┐    ┌──────────────────┐
 │ app.js      chart, legend,   │────────────▶│ HTTP API (stdlib ThreadingServer)  │───▶│ charting.*       │
 │             toolbars         │             │  auth.py      pluggable providers  │    │  users, sessions │
 │ drawings.js ~80 drawing tools│             │  store.py     per-user state       │    │  layout settings │
 │ indicators.js built-ins      │             │  market.py    history + quotes     │───▶│  drawings, alerts│
 │ script.js   ChartScript      │             │  datasources  UI-managed sources   │    │  scripts, plans  │
 │ sandbox.js  iframe + worker  │             │  alerts.py    engine (thread)      │    │  datasources     │
 │ live.js     exchange feed    │             │  jsrunner.py ─▶ Node jsworker.js   │    ├──────────────────┤
 │ panels.js   watchlist, alerts│             │  notify.py    telegram/email/hook  │    │ market DBs       │
 │ dialogs.js  modals, admin    │             │  plans.py     subscription limits  │    │  *_klines tables │
 └──────┬───────────────────────┘             └──────────────┬────────────────────┘    └──────────────────┘
        │ 1 REST call per symbol/timeframe                    │ REST (cached, rate limited)
        │ 1 multiplexed websocket                             ▼
        └────────────────────────────────────────────▶  Binance (fapi / api)
```

## Data flow

1. **Symbol selected** → the browser makes **one** REST request to the exchange klines endpoint
   (default limit, 500 bars) and subscribes the kline stream on the shared websocket
   (`wss://fstream.binance.com/market/stream`, `SUBSCRIBE`/`UNSUBSCRIBE`; one connection per provider
   for chart and watchlist).
2. **Realtime**: kline messages update the last bar or append a new one; indicators recompute at
   most once per second (immediately on a new bar).
3. **Scrolling left** past the first bar → `GET /api/bars?to=<first bar>` reads ClickHouse. When it
   returns nothing the user sees *No data on ClickHouse*; a gap between ClickHouse and live data is
   reported as well.
4. Timeframes without their own table (3m, 30m, 2h, 12h, 1W, 1M) are aggregated inside ClickHouse
   (`argMin(open)`, `max(high)`, `min(low)`, `argMax(close)`, `sum(volume)` per bucket).
5. Sources without a live provider fall back to ClickHouse only, polling every 15 s.

Symbols are `PREFIX:SYMBOL` (e.g. `BINANCE:BTCUSDT`). The symbol list is the union of each source's
ClickHouse symbols and the exchange's tradable symbols (`exchangeInfo`, cached for an hour).

## Frontend

No build step: ES modules served as files; lightweight-charts 5.2.1 and CodeMirror 5 are vendored in
`static/vendor`. Main modules:

| Module | Responsibility |
| --- | --- |
| `app.js` | boot/login, chart & series, chart types (incl. Renko/Line break transforms), data loading, indicator rendering (series, panes, markers, `fill()` primitive), legend, toolbars, keyboard |
| `drawings.js` | drawing registry and manager: a series primitive renders every tool through a small canvas helper that records geometry for hit-testing; selection, handles, drag, undo/redo, persistence diff |
| `indicators.js` | built-in indicator definitions and math (shared with the server) |
| `script.js` | ChartScript runtime (shared with the server) |
| `sandbox.js` | sandboxed iframe creates the web worker that runs user code; page ↔ worker over a MessageChannel, bars sent as deltas |
| `live.js` | exchange REST + multiplexed websocket |
| `panels.js` | watchlists, symbol info, alerts list, alert notifications |
| `dialogs.js` | symbol search, indicator picker/settings, script editor, alert dialog, admin dialogs |

`S.bars` holds the time-based bars; `S.view` the bars shown (identical except for Renko and Line
break, where indicators and drawings work on the transformed bars like on TradingView).

## Backend

Python standard library only (no pip packages). Node ≥ 20 is used for the indicator worker so the
server evaluates indicators with **exactly** the JavaScript the browser runs.

| Module | Responsibility |
| --- | --- |
| `server.py` | routing, JSON API, static files (dev), CLI |
| `auth.py` | providers `local` / `header` / `none`, users, sessions |
| `store.py` | watchlists, drawings, settings (layout), scripts |
| `datasources.py` | data sources from the UI, encrypted passwords, timeframe planning, table discovery |
| `market.py` | bars, symbol list, quotes, symbol info |
| `live.py` | exchange REST with weight budget and bar cache |
| `alerts.py` | alert CRUD + evaluation engine thread |
| `jsrunner.py` / `jsworker.js` / `jsgate.js` | sandboxed Node worker for indicator calculations; in Docker a separate `jsworker` container without network, reached over a Unix socket |
| `notify.py` | Telegram, SMTP, webhook delivery |
| `plans.py` | subscription plans and limit checks |

## ClickHouse schema (`charting` database)

All user tables are `ReplacingMergeTree(updated_at)` keyed by `user_id` first and read with `FINAL`;
deletes are soft (`deleted = 1`).

| Table | Key | Content |
| --- | --- | --- |
| `users` | id | provider, external id, username, password hash, admin flag, plan |
| `sessions` | token (SHA-256) | user id, expiry (TTL) |
| `settings` | user_id, key | JSON values; `layout` holds symbol, timeframe, chart type, indicators, time zone, favourites, panel state, last tools … |
| `drawings` | user_id, symbol, id | tool + JSON (points as `{t: UTC seconds, p: price}`, style, text) |
| `watchlists` | user_id, id | name, symbols, order |
| `scripts` | user_id, id | custom indicator source |
| `alerts` | user_id, id | kind, condition, spec JSON, frequency, channels, evaluation state |
| `alert_events` | user_id, created_at | fired alerts (TTL 180 days) |
| `datasources` | id | ClickHouse connection, database, table per timeframe, column mapping, live provider |
| `plans` | id | limits JSON |

## API (selection)

| Method & path | Purpose |
| --- | --- |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` | session |
| `GET /api/symbols` | symbols + sources |
| `GET /api/bars?symbol&tf&to&limit` | ClickHouse history (bars strictly before `to`) |
| `GET /api/quotes?symbols=` / `GET /api/symbol?symbol=` | quotes / symbol info & performance |
| `GET/POST /api/watchlists`, `DELETE /api/watchlists/{id}` | watchlists |
| `GET /api/drawings?symbol`, `POST /api/drawings`, `POST /api/drawings/delete` | drawings |
| `GET/PUT /api/settings/{key}` | per-user settings (layout) |
| `GET/POST /api/scripts`, `DELETE /api/scripts/{id}` | custom indicators |
| `GET/POST /api/alerts`, `DELETE /api/alerts/{id}`, `GET /api/alerts/events?since` | alerts |
| `GET/PUT /api/notify`, `POST /api/notify/test` | user notification settings |
| `/api/admin/{datasources,users,plans,notify,ratelimit}` | admin |

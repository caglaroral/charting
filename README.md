# Charting

A self-hosted, multi-tenant, TradingView-style charting platform built on
[lightweight-charts](https://github.com/tradingview/lightweight-charts) with ClickHouse as the history
store and Binance as the live feed.

- **Charts**: 12 timeframes (1m … 1M), 15 chart types (candles, hollow, volume candles, bars, line,
  step line, area, HLC area, baseline, columns, high-low, Heikin Ashi, Renko, Line break …),
  ~90 time zones, log / percent / auto scale, panes for oscillators; chart settings for candle
  body / border / wick colors, line color, background and grid (saved per user).
- **Data**: live bars from one exchange REST call per selection plus one multiplexed websocket;
  older history is loaded from ClickHouse on scroll ("No data on ClickHouse" when there is none).
- **Drawing tools**: every TradingView tool family except AI and icons — trend lines, channels,
  pitchforks, Fibonacci & Gann tools, harmonic / Elliott patterns, forecasting & measurement
  (positions, anchored VWAP, volume profiles), shapes and annotations (≈80 tools).
- **Indicators**: 22 built-ins and user-written **custom indicators** in ChartScript
  (JavaScript with a Pine-like API, `security()` for multi-timeframe, `fill()`, `plotshape()`),
  edited in an in-browser editor and executed in a sandbox.
- **Alerts**: price, drawing and indicator alerts (including custom indicators) evaluated on the
  server — notifications arrive even when the browser is closed: in-app, Telegram, e-mail, webhook.
- **Multi-tenant**: everything (layout, drawings, watchlists, scripts, alerts) is stored per user.
  Pluggable authentication (local, auth-proxy header, ready for IAM/OIDC) and subscription plans
  with limits enforced by the server and the alert engine.
- **Admin UI**: ClickHouse data sources (host, credentials, database and table mapping), users,
  plans, notification servers.

![screenshot](docs/screenshot.png)

## Quick start (Docker)

```bash
cp .env.example .env          # set CH_URL / CH_USER / CH_PASSWORD of the ClickHouse server
docker compose up -d --build  # http://<host>:8080
docker compose exec backend python3 server.py adduser admin --admin   # create the first admin
```

The backend creates the `charting` database and its tables on start, and registers the existing
`backtest_*_klines` tables as the `BINANCE` data source the first time it runs. Further data sources
are added in the UI: **user menu → Data Sources (ClickHouse)**.

## Running without Docker

Requirements: Python ≥ 3.11 and Node ≥ 20 (for the server-side indicator sandbox). No pip / npm
packages are needed at runtime.

```bash
cp .env.example .env
python3 server.py adduser admin --admin
python3 server.py            # http://localhost:8080
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, ClickHouse schema, API |
| [docs/CHARTSCRIPT.md](docs/CHARTSCRIPT.md) | Custom indicator language reference and Pine porting guide |
| [docs/ALERTS.md](docs/ALERTS.md) | Alert engine, conditions, notifications, exchange rate limits |
| [docs/ADMIN.md](docs/ADMIN.md) | Data sources, users, subscription plans, notification servers |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication, tenancy, sandboxing of user code, IAM migration |
| [docs/TESTING.md](docs/TESTING.md) | Test cases and how to run the Playwright suite |

## Repository layout

```
server.py                HTTP server, API routes, CLI (adduser / passwd / users)
backend/                 auth, ClickHouse client, market data, alerts engine, plans, notifications,
                         live exchange client, sandboxed JS runner (jsrunner.py + jsworker.js)
static/                  the web app (no build step): index.html, css/, js/, vendor/
sql/schema.sql           ClickHouse schema (applied automatically)
examples/                ChartScript ports of Pine indicators (SqueezeWt, ALL SMAs)
docker/, docker-compose.yml
tests/e2e/               Playwright end-to-end tests
```

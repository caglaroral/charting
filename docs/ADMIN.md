# Administration

All admin screens are in the **user menu** (top right) of an admin account.

## Data sources (ClickHouse)

*Data Sources (ClickHouse)* lists the sources the charts read history from.

1. **New source** → name, **symbol prefix** (symbols appear as `PREFIX:SYMBOL`), server IP/host,
   port (8123), user and password → **Test connection** lists the databases.
2. Pick the database → **Scan tables** finds tables with OHLC columns and guesses the timeframe from
   the name (`…_1m_…`, `…_1h_…`, `…_1d_…`).
3. Tick one table per timeframe and check the **column mapping** (symbol, time, open, high, low,
   close, volume). The time column must be `DateTime`/`DateTime64`.
   Table names can also be typed: **+ Add table or view** adds a row, and the name field suggests
   every table and view of the database (the *Type* column shows table / view / materialized view).
   A view works like a table; all tables share one column mapping, so a view with other column names
   should rename them (`SELECT ts AS timestamp, …`). On **Save** the server checks that every table
   exists and has the mapped columns; two tables for one timeframe are rejected.
4. **Live data**: Binance USDT-M Futures / Binance Spot / none.
5. **Recent 1m table** (optional): a table of the latest 1m bars with the same columns (e.g. `live_1m_klines`),
   merged after the history tables' last bar by the screener, strategy tester and paper trading, so they run on
   today's bars. Existing sources got `live_1m_klines` once, when that table existed next to their tables.
   The 1m table itself may already include the recent rows (e.g. the view `klines_1m_all` = `backtest_1m_klines`
   + `live_1m_klines`): a minute present in both is counted once. The recent table is still needed for the other
   timeframes when their tables (`backtest_5m_klines`, …) end before today.

Missing timeframes are aggregated from the largest smaller table that divides them (e.g. 30m from
15m, 1W from 1D). Passwords are stored encrypted with `SECRET_KEY` (generated into `.env` on first
use — keep it, or stored passwords cannot be decrypted).

The application's own database (`CH_URL`, `CH_USER`, `CH_PASSWORD`, `CH_APP_DB` in `.env`) is
configured in the environment because it is needed before anyone can log in.

## Users

*Users* creates local users, assigns plans and admin rights. CLI alternatives:

```bash
python3 server.py adduser <name> [--admin]   # docker compose exec backend python3 server.py …
python3 server.py passwd <name>
python3 server.py users
```
Deleting a user in the UI is a soft delete (the account stops resolving, data is kept). The API
also offers a permanent purge of the user and all their rows: `DELETE /api/admin/users/{id}?purge=1`.

## Subscription plans

*Plans* edits the limits of each plan (empty = unlimited). Defaults:

| Limit | Free | Pro | Premium | Unlimited |
| --- | --- | --- | --- | --- |
| Active alerts | 5 | 50 | 400 | ∞ |
| Indicator alerts | ✓ | ✓ | ✓ | ✓ |
| Custom indicator alerts | – | ✓ | ✓ | ✓ |
| Notification channels | app, telegram | all | all | all |
| Alert evaluation interval | 60 s | 20 s | 20 s | 20 s |
| Custom indicators | 3 | 25 | 100 | ∞ |
| Watchlists / symbols per list | 2 / 30 | 10 / 200 | 50 / 1000 | ∞ |
| Indicators per chart | 5 | 15 | 30 | ∞ |
| Saved screens | 5 | 50 | 200 | ∞ |
| Saved strategies | 5 | 50 | 200 | ∞ |
| Screener alerts | – | ✓ | ✓ | ✓ |
| Symbols per backtest run | 5 | 30 | 100 | ∞ |
| Paper-trading strategies (running) | 1 | 10 | 50 | ∞ |
| Symbols per paper-trading strategy | 10 | 100 | 500 | ∞ |

Plans saved before a limit existed use the default plan's value for it (custom plans: unlimited).
Users without a plan get *free*; admins without a plan get *unlimited*. Limits are enforced by the API
(HTTP 402 with a readable message) and by the alert engine (a downgraded user's oldest alerts keep
running up to the limit).

## Notification servers

SMTP (host, port, STARTTLS/SSL/none, user, password, from) and the Telegram bot token
(create one with @BotFather). Secrets are stored encrypted.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CH_URL`, `CH_USER`, `CH_PASSWORD` | | ClickHouse HTTP endpoint for the app database (and the initial data source) |
| `CH_APP_DB` | `charting` | application database |
| `CH_MARKET_DB` | `default` | database of the initial `BINANCE` source |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | backend listen address |
| `AUTH_MODE` | `local` | `local`, `header`, `none` (see SECURITY.md) |
| `AUTH_HEADER_USER/EMAIL/PROVIDER` | | header mode settings |
| `SESSION_DAYS` | `30` | session lifetime |
| `SECRET_KEY` | generated | encryption key for stored secrets |
| `APP_PORT` (compose) | `8080` | published port of the frontend container |

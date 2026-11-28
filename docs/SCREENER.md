# Screener, Strategy Tester and Paper Trading

The bottom panel (buttons **Screener**, **Strategy Tester**, **Paper Trading** at the left of the bottom bar;
on phones in the ☰ menu) runs on the **backtest engine** (`backtester/backtestengine`), a numpy / numba /
TA-Lib engine with trade rules identical to the Node engine it was ported from. The engine runs in its own
container, `backtester`; the backend calls it over the compose network.

## Conditions

Screens and strategies share one condition format:

| | Format | Example |
| --- | --- | --- |
| Operand | indicator `{ind, p, f, tf, sh}`, price `{px, tf, sh}`, value `{const}` | `{ind: 'rsi', p: [14]}`, `{ind: 'ema', p: [200], tf: '4h'}`, `{px: 'close', sh: 1}` |
| Condition | `{a, op, b}`, op `<`, `>`, `xup` (crosses up), `xdn` (crosses down) | RSI(14) < 30, Close crosses up EMA(200) 4h |

- **Indicators**: SMA, EMA, HMA, TEMA, TVWEMA, VWAP (daily), RSI, CCI, Stoch RSI, MFI, Awesome Oscillator, DPO,
  MACD (MACD / signal / histogram), ADX (adx / +DI / −DI), Bollinger, Donchian, Keltner (upper / middle / lower),
  Supertrend, Parabolic SAR, WaveTrend, ATR, OBV. Parameters default to the engine's defaults.
- **tf**: another timeframe (e.g. a 4h EMA in a 15m screen). A higher-timeframe value is the one of its last
  **closed** bar (no look-ahead).
- **sh**: bars ago (`Close[1]` is the previous bar's close).
- A condition is evaluated on **closed** bars only. "Crosses up" = below on the bar before, above on this bar.
- Indicator values come from the engine (TA-Lib and the engine's ports), not from the chart's JavaScript, so they
  can differ slightly from a chart indicator (the engine rounds RSI and MFI to 2 decimals like the Node engine;
  Supertrend and WaveTrend follow TradingView).

## Screener

- **Timeframe** and **universe** (all symbols of the data source, or a watchlist).
- **+ Filter** adds a condition (all must hold); **+ Column** adds an indicator / price column. Condition operands
  are shown as columns too.
- Fixed columns: price, 24h change and 24h quote volume (one exchange `ticker/24hr` request per minute for all
  symbols), and the **regime** of the symbol on its last closed daily bar (engine `COIN4`: *bull* / *bear* from the
  daily SMA 50/200 trend, *squeeze* when ADX(14) < 20 and the Bollinger width is in the lowest quarter of 180 days,
  *transition* otherwise).
- A blue dot marks a symbol that matches on this bar but did not on the bar before.
- Click a column to sort, a row to open the symbol. The table refreshes every minute while it is open.
- **Saved screens** (the screen menu): New, Save, Save as, Rename, Delete, and open any saved screen. An unsaved
  change shows `*`. The number of saved screens is a plan limit.
- **Alert**: a screener alert on the saved screen: on every closed bar of the screen's timeframe the server runs the
  screen and notifies about **new matches** (symbols that match now and did not on the bar before), with the
  channels of the user (in-app, Telegram, e-mail, webhook). It follows later edits of the screen and stops when the
  screen is deleted. Allowed by plan (`screener_alerts`).

Data: the history tables of the data source plus, when configured, its **recent 1m table** (merged after the last
history bar), so screens run on today's bars. Symbols missing from the recent table are topped up from the
exchange REST API (only closed bars, only missing ones, once per bar, under 30% of the exchange weight limit).
A screen is evaluated on the bar most symbols have closed; symbols behind it (halted, delisted) are skipped.
The recent table's own delay applies (e.g. a table filled every ~10 minutes delays 1m screens by that much).

## Strategy Tester

- **Strategy**: timeframe, **Long** and/or **Short** with entry conditions (all must hold; *Load entry from a saved
  screen* copies a screen's conditions and timeframe), **stop** and **take profit** as a % of the entry price or
  an ATR multiple (ATR of the signal bar).
- **Symbols**: current symbol, the screener's last results, a watchlist, or a typed list (plan limit per run).
- **Period** and **size** per trade (fixed notional, no compounding).
- Rules (the engine's, identical to the Node engine): a signal at a bar's close fills at the next bar's open; one
  position per symbol; a signal while a position is open is ignored; long wins when both sides signal; when one bar
  touches both stop and take profit the stop wins; a bar opening beyond a level fills at its open; costs 0.05% fee
  and 0.02% slippage per side plus 0.08% on stop exits; a position still open at the end is not counted.
- Indicators are computed on 1000 bars before the window plus the window, so long averages are converged.
  A symbol without 256 bars before the start (or with a data gap inside the window) starts later or is skipped.
- Results: total metrics (net, trades, win rate, profit factor, max drawdown, Sharpe, exposure; the engine's
  `metrics.py` = the app's `stats.js` formulas), a row per symbol, and its trades. A row shows its trades on the
  chart (entry arrows, exit dots with the net); a trade scrolls the chart to it.
- Limits: at most 250,000 bars per symbol and run, about 4 minutes per run.

## Paper Trading

A paper-trading strategy runs a strategy forward on new closed bars, on the server (also when the browser is
closed), with the backtest rules and costs. Several strategies run at once, each on its own symbols.

- **New strategy** (or *Paper trade this…* in the tester): name, strategy, symbols, size per trade, notifications
  (Telegram / e-mail / webhook on entries and exits), running.
- **Edit**: name, notifications: same run. Strategy, symbols or size: a **new run** (`#2`, …) starting with the next
  closed bar; trades of earlier runs are kept.
- **Pause / Resume**: resuming starts a new run (bars missed while paused are not traded).
- **Restart**: a new run now; **Delete**: removes the strategy and its trades.
- The list shows per strategy the trades, net, win rate, open positions and their unrealized P&L (marked to the last
  close, after costs). A strategy's details list the open positions (entry, stop, take profit) and the closed trades
  of the current run; a click shows them on the chart.
- How it advances: every 30 s the backend sends each active strategy's state to the backtester. For each symbol the
  state holds the first bar whose signal is not acted on yet (the open position's signal bar, or the last processed
  bar); the engine re-runs from there to the last closed bar, so an open position is re-created identically and its
  exit is found when it happens. Closed trades go to `charting.paper_trades`.
- Plan limits: running strategies (`paper_trades`) and symbols per strategy (`paper_symbols`).

## Service

`backtester/server.py` (port 8090, internal only):

| Endpoint | Purpose |
| --- | --- |
| `POST /screen` | `{source, tf, conds, columns, symbols?}` → rows of the last closed bar |
| `POST /backtest` | `{source, strategy, symbols, start, end, size}` → metrics and trades per symbol |
| `POST /paper` | `{source, strategy, symbols, state, start, size}` → trades, open positions, new state |
| `POST /validate`, `GET /meta`, `GET /health` | validation, indicator list, health |

The backend sends the data source (ClickHouse URL, user, password, tables, column mapping, recent table, live
provider) with each request; the backtester keeps no secrets on disk. It caches the latest 1000 bars of every
symbol per timeframe in memory (refreshed incrementally every 30 s) and computes one request at a time.
Every condition, column and strategy is validated against the engine's indicator list and bounded numbers:
no expressions or code reach the engine from the API.

Engine notes: `backtester/backtestengine/README.md`.

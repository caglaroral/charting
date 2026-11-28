# Python backtest engine

A Python copy of the Node backtest engine (`backend/backtest.js` of the trading app it comes from): it runs a
strategy on ClickHouse klines and gives the same trades as the Node engine, rule for rule, fast enough for a
search over millions of strategies: whole arrays in numpy, the trade loop compiled with numba.

**In this repository** the engine powers the screener, the strategy tester and paper trading through the
backtester service (`backtester/server.py`, see [docs/SCREENER.md](../../docs/SCREENER.md)). Changes made for it:

- `data.py` no longer downloads to a parquet cache: candles come from a provider set per request
  (`data.use(provider)`), the service's in-memory cache of the latest bars (`bt/market.py recent_provider`) or a
  backtest window read from ClickHouse (`window_provider`). `strategy.reset_caches()` runs on every `data.use`.
  Timeframes 3m, 2h, 12h and 1w are added (aggregated in ClickHouse like the chart does).
- `sim.simulate` also returns the position still open at the end, and `runner.run` returns it (`open`, with its
  signal bar), which paper trading resumes from.
- `Frame(..., warm=1)` lets the screener evaluate symbols with a short history (values without enough history are
  NaN, so conditions on them are false).

The parity scripts (`tests/ppo/parity/`), the searches and the parquet cache mentioned below belong to the
original project and are not part of this repository; the rules and formulas described here are unchanged.

## Contents

- [Modules](#modules)
- [Quick start](#quick-start)
- [Data](#data)
- [Strategy format](#strategy-format)
- [Indicators](#indicators)
- [Simulation rules](#simulation-rules)
- [Running a strategy](#running-a-strategy)
- [Regime labels](#regime-labels)
- [Metrics](#metrics)
- [Parity with the Node engine](#parity-with-the-node-engine)
- [Environment variables](#environment-variables)
- [Known differences and limits](#known-differences-and-limits)
- [Where it is used](#where-it-is-used)

## Modules

| File | What it does |
|---|---|
| `data.py` | Loads klines from ClickHouse, one month per query, read only. Builds 30m from 1m like the Node engine. Keeps a parquet cache per (symbol, timeframe). `Candles` holds one symbol's series and splits it into gap-free segments. |
| `indicators.py` | All indicators, named and parameterised like the Node engine. Each is parity-checked. |
| `strategy.py` | The strategy format (plain dicts), `Frame` (one window of one symbol with warm-up and higher-timeframe alignment), and export to the Node strategy JSON (`to_engine`). |
| `expr.py` | Runs the app's own strategy JSON (`longCondition`, `longStop`, ...): parses each expression once and evaluates it on whole arrays (`from_engine`). |
| `sim.py` | The trade loop (numba): entries, the four exit kinds, costs. |
| `runner.py` | `run()` for one strategy, symbol and window; `run_many()` for many in parallel on as many processes as free memory allows. |
| `metrics.py` | Net, max drawdown, Sharpe, Sortino, Ulcer, Martin, exposure, open positions, with the formulas of `backend/stats.js`. |
| `regimes.py` | Market and coin regime labels (BTC weekly, COIN4, ...) and their alignment to strategy candles without look-ahead. |

The package exports `run`, `run_many`, `workers`, `Frame`, `from_engine` and `to_engine`.

## Quick start

Setup: Python 3.11+, the packages in `tests/ppo/requirements.txt` (numpy, pyarrow, clickhouse-connect, TA-Lib, numba),
and ClickHouse access through `CLICKHOUSE_HOST` / `CLICKHOUSE_PORT` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASS`. Never
commit or print the password.

```python
import sys; sys.path.insert(0, 'tests/ppo')
import numpy as np
from backtestengine import run, to_engine, metrics

ms = lambda day: int(np.datetime64(day, 'ms').astype(np.int64))

strategy = {
    'tf': '15m',
    'long': {
        'entry': [
            {'op': '>', 'a': {'px': 'close'}, 'b': {'ind': 'ema', 'p': [200], 'f': None, 'tf': '4h'}},
            {'op': 'xup', 'a': {'ind': 'rsi', 'p': [14]}, 'b': {'const': 30}},
        ],
        'stop': {'k': 'pct', 'v': 0.02},
        'tp': {'k': 'atr', 'm': 3, 'p': 14},
    },
    'short': None,
}

r = run(strategy, 'BTCUSDT', ms('2024-01-01'), ms('2024-12-31'))
print(len(r['net']), r['net'].sum())                     # trades, net USDT at 1000 USDT per trade
print(metrics.compute(r['entry_ts'], r['exit_ts'], r['net'], 1000.0, ms('2024-01-01'), ms('2024-12-31')))
print(to_engine(strategy, 'BTCUSDT'))                    # the same strategy as Node / app JSON
```

`run()` returns `None` when the window cannot run: not enough warm-up, or a data gap inside the window. The Node
engine stops with "Data gap" in the same case.

A Node strategy JSON from the app runs too:

```python
import json
from backtestengine import from_engine, run
s = from_engine(json.load(open('tests/ppo/results/pairs_coin_v1/transition_GRTUSDT.json')))
r = run(s, 'GRTUSDT', start_ms, end_ms)
```

## Data

- **Source:** the ClickHouse tables `backtest_{1m,5m,15m,1h,4h,1d}_klines` (Binance USDⓈ-M futures). The engine only
  SELECTs; it never writes to them. 30m has no table and is aggregated from 1m in the query with the Node engine's
  rule (`backend/clickhouseKlines.js aggregateSelect`): zero-volume minutes are left out of the OHLC unless the whole
  bucket had no trades.
- **Timeframes:** `1m, 5m, 15m, 30m, 1h, 4h, 1d` (`data.TF_MS`).
- **Time:** UTC epoch milliseconds of the candle open, like the Node engine.
- **Cache:** the first `data.load(symbol, tf)` downloads one month per query, with a pause between queries, and
  writes `<symbol>_<tf>.parquet` under `LOCKDOWN_PPO_CACHE` (default `~/.cache/lockdown_ppo`). Later loads read the
  file. A lock file lets one process download while the others wait. `data.prefetch(symbols, tfs)` fills the cache
  before worker processes start.
- **Range:** from `DATA_START` (2020-01) to `DATA_END`. Coins start at their listing; most altcoins have data from
  2022-01, some from 2020-2021.
- **Holdout cut:** with `LOCKDOWN_PPO_DATA_STOP=YYYY-MM-DD`, nothing from that day on is loaded, and the cache file
  is named `<symbol>_<tf>_to<stop>.parquet`, so a cut cache never mixes with a full one.
- **Gaps:** `Candles.segments()` splits a series where two candles are not one timeframe apart. Each gap-free
  segment runs on its own, as the Node engine does (`backend/backtest.js backtestSegments`).

## Strategy format

A strategy is a plain dict: JSON-serialisable, picklable, storable in ClickHouse.

```
operand   {'ind': 'rsi', 'p': [14], 'f': None, 'tf': '4h', 'sh': 0}   candle[sh].rsi_4h(14)
          {'px': 'close', 'sh': 1}                                    candle[1].close
          {'const': 30}                                               30
cond      {'op': '<' | '>', 'a': operand, 'b': operand}
          {'op': 'xup' | 'xdn', 'a': operand, 'b': operand}           candle.crossover(a, b) / crossunder
exit      {'k': 'pct', 'v': 0.02}                                     entry.open * (1 -/+ v)
          {'k': 'atr', 'm': 2, 'p': 14}                               entry.open -/+ entry[1].atr(p) * m
          {'k': 'atr', 'm': 2, 'p': 14, 'tf': '15m'}                  the same with entry[1].atr_15m(p)
          {'k': 'cond', 'c': [cond, ...]}                             exit at the next open when all are true
          {'k': 'lvl', 'a': operand, 'm': 3, 'p': 22, 'floor': 0.03}  Math.max(entry.open * 0.97, <a> - candle.atr(p) * m)
side      {'entry': [cond, ...], 'stop': exit, 'tp': exit}
strategy  {'tf': '15m', 'long': side | None, 'short': side | None}
```

- **Fields:** `f` is the indicator's field (`macd` → `MACD` / `signal` / `histogram`, `bb` → `upper` / `middle` /
  `lower`, ...; see `indicators.FIELDS`).
- **Timeframe:** `tf` on an operand reads a higher timeframe. `None` means the strategy timeframe.
- **Shift:** `sh` looks `sh` candles back.
- **Entry conditions:** all of them must hold (AND).
- **Exits:** written for the side they belong to. A long stop sits below the fill, a short stop above.
- **`lvl` exits:** a trailing level, re-evaluated every candle. `m` adds an ATR offset (away from the price);
  `floor` bounds the level by a fixed % of the fill. For a level above the price, `+` and `Math.min` are used.
- **Export:** `strategy.to_engine(s, symbol)` writes the Node / app JSON. `strategy.from_engine(js)` reads it back
  through `expr.py`.

## Indicators

| Group | Indicators |
|---|---|
| Moving averages | `sma`, `ema`, `hma`, `tema`, `tvwema`, daily `vwap` (resets at 00:00 UTC) |
| Oscillators | `rsi`, `cci`, `stochrsi` (`stochRSI`, `k`, `d`), `mfi`, `ao`, `dpo` |
| Momentum | `macd` (`MACD`, `signal`, `histogram`) |
| Trend strength | `adx` (`adx`, `pdi`, `mdi`) |
| Bands and channels | `bb`, `donchian`, `keltner` (`upper`, `middle`, `lower`) |
| Stop and reverse | `supertrend` (`value`, `trend`, `upper`, `lower`; source `hlc3` or `hl2`), `psar` (`value`, `trend`) |
| Other | `wavetrend` (`wt1`, `wt2`), `atr`, `obv`, `price` (a price field on a higher timeframe) |

Key format, as in the Node engine: `<name>[_<field>](<params>)`, e.g. `rsi(14)`, `macd_histogram(12,26,9)`,
`supertrend_trend(10,3,"hl2")`. Defaults are in `indicators.DEFAULTS`.

- **Implementations:** TA-Lib for sma, ema, rsi, atr, cci, macd, bb, adx. Ports of the Node code, with the same
  order of float operations, for the rest.
- **Rounding:** RSI (also inside stochRSI) and MFI are rounded to 2 decimals, because the Node engine rounds them.
- **Standard definitions:** where the `technicalindicators` library deviated from the standard definition, both
  engines use the standard one: TradingView supertrend, LazyBear wavetrend, TA-Lib MFI, the true high / low in
  stochRSI.
- **Missing values:** before an indicator has a value it is NaN, and every comparison with NaN is false.
- **OBV:** cumulative from the first candle, so its level depends on where the series starts. Use it relative to
  itself (`obv > candle[10].obv`), not against a fixed number.
- **Donchian:** includes the current candle. `candle[1].donchian_upper(20)` is the channel a breakout compares
  against.

Add an indicator only together with its parity check (`parity/indicator_check.py`).

## Simulation rules

`sim.simulate` follows `backend/backtest.js`:

**Entries and positions**

- A signal at candle k's close enters at candle k+1's open.
- One position at a time. A signal while a position is open is ignored, so there is no re-entry on the candle a
  position exits on.
- When long and short both signal, long wins.

**Exit kinds** (per side, stop and take-profit separately)

| Kind | Code | Meaning |
|---|---|---|
| none | 0 | no exit of this kind |
| pct | 1 | a % of the fill, fixed at the entry |
| atr | 2 | m × ATR of the signal candle, fixed at the entry |
| cond | 3 | a condition |
| lvl | 4 | a trailing price level |

**How exits fire**

- **Price levels (pct, atr):** known at the fill and checked from the entry candle on, against high and low. When one
  candle touches both the stop and the take-profit, the stop wins. A candle that opens beyond a level fills at its
  open.
- **Conditions:** true at a candle's close, they exit at the next open, checked from the entry candle's close on.
  They come before any level, and a condition stop comes before a condition take-profit.
- **Trailing levels:** the value at candle i-1's close applies to candle i, from the entry candle on, like
  `backtest.js` re-evaluates an expression that reads `candle.*`. A level that cannot be computed keeps its last
  value.
- **End of data:** a position still open at the end of the window is dropped.

**Costs** (`backend/costDefaults.js`, every leg a market order)

| | Per leg | Round trip |
|---|---|---|
| Fee | 0.05% | 0.10% |
| Slippage | 0.02% | 0.04% |
| Extra on a stop exit | | 0.08% |
| **Total** | | **0.14% at a take-profit, 0.22% at a stop** |

`sim.trade_net(side, entry_px, exit_px, size_usdt=1000)` gives the net per trade. Position size is fixed, 1000 USDT
notional by default. Funding is not modelled.

## Running a strategy

```python
runner.run(strategy, symbol, start_ms, end_ms, gate=None, warmup='full', signal_shift=0)
```

| Argument | Meaning |
|---|---|
| `strategy` | A strategy dict, or a `from_engine()` result (runs through `expr.py`) |
| `start_ms`, `end_ms` | The window, end inclusive like the Node engine's `fetchCandlesticks` |
| `gate` | A function `ts -> (long_ok, short_ok)` of boolean arrays, applied to the signal candles (e.g. a regime filter) |
| `warmup` | `'full'` or `'node'`, see below |
| `signal_shift` | Rolls the raw entry signals that many candles later, before the gate: the null reference of the searches |

It returns arrays per trade: `side` (1 long, -1 short), `entry_ts`, `exit_ts` (candle open times of the entry and
exit candles), `entry_px`, `exit_px` and `net`.

**Warm-up modes**

- `'full'` (default, used by the searches): indicators are computed once on the whole gap-free history before the
  window, the way TradingView does, and cached per process.
- `'node'`: reproduces the Node engine exactly. The strategy timeframe gets 256 candles of warm-up before the
  start, a higher timeframe 256 of its own candles, and indicators are computed on these slices only. Long recursive
  indicators (ema 200, adx, atr 100) are then not converged and depend on the start date. Parity uses this mode.

Both modes need 256 candles of the same gap-free segment before the start.

**Higher timeframes:** a higher-timeframe value is seen by the strategy candle that closes together with it or
after it (`lookahead_off`). A 4h value is usable on the 15m candle that closes at the same time as the 4h candle.

**Many runs:** `runner.run_many(jobs)` takes `(strategy, symbol, start_ms, end_ms)` tuples and runs them on
`workers()` processes. The count is set from free memory (`MemAvailable - LOCKDOWN_PPO_RESERVE_MB`, divided by
`LOCKDOWN_PPO_MB_PER_WORKER`) and the number of cores.

## Regime labels

`regimes.py` makes labels on their own bars (BTC weekly from daily candles, a coin's daily candles, ...) and maps
them to strategy candles with `align()`. A strategy candle sees the label of the last bar that closed by its own
close, so there is no look-ahead.

| Function | Label |
|---|---|
| `r1_btc_weekly_sma()` | BTC weekly: bull if SMA7 > SMA25 and close > SMA99, bear the mirror, else sideways |
| `r2_btc_daily_sma()`, `r3_btc_weekly_adx()`, `r4_breadth()` | Other market labels (regime study) |
| `c1` / `c2` / `c3_...(symbol)` | The coin's own weekly / daily trend and consolidation |
| `coin4(symbol)` | The coin's own regime: squeeze (0), bull (1), bear (-1), transition (2), from its daily candles |

`UNKNOWN = 9` marks candles before a label exists, which belong to no regime. The gate built on these labels for
the searches is `search/evaluate.py` (`_gate`).

## Metrics

`metrics.compute(entry_ts, exit_ts, net, initial, start_ms, end_ms, symbol=None, symbols=1)` uses the formulas of
`backend/stats.js`, so a strategy reads the same here and in the app.

| Metric | Meaning |
|---|---|
| `net`, `trades`, `win_pct`, `profit_factor` | Totals over net trades. `stats.js` computes win rate and profit factor on gross profit |
| `max_dd`, `max_dd_pct` | Largest peak-to-trough fall of the closed-trade equity |
| `sharpe`, `sortino` | Daily returns, annualised with √365 |
| `ulcer`, `martin` | Ulcer index of the daily equity; Martin = annualised return % / ulcer |
| `exposure_pct` | Share of the period with a position open, averaged over `symbols` slots |
| `max_open`, `avg_open` | Open positions over time across all symbols |

Equity is closed-trade equity at a fixed position size. Open positions are not marked to market here; see
`pairs_portfolio.py --daily` for that.

## Parity with the Node engine

`tests/ppo/parity/` runs the same strategies through both engines and requires identical results. It needs Node and
`backend/`, so it runs on the development machine, not on the PPO host.

| Script | Checks |
|---|---|
| `parity.py` | Random strategies (all indicators, higher timeframes, shifts, crosses, all exit kinds, long and short) plus fixed edge cases, on several symbols and timeframes (1m to 1h). Every trade must match: side, entry and exit time, prices to 1e-9, net. |
| `indicator_check.py` | Every indicator series against Node |
| `expr_check.py` | App strategy JSON through `expr.py` against Node |
| `space_check.py` | The strategies of the search space (`--space v2` / `v3`) |
| `metrics_check.py` | `metrics.py` against `stats.js` |

```bash
~/.venvs/lockdown-lab/bin/python -P tests/ppo/parity/parity.py [--n 40] [--seed 1] [--only ETHUSDT:5m]
```

Datasets that reach into the holdout (2026-04-01 on) are skipped unless `--holdout` is given. Run parity after any
change to the engine, and add a check with every new indicator or rule.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASS` | | ClickHouse access (read only) |
| `LOCKDOWN_PPO_CACHE` | `~/.cache/lockdown_ppo` | Parquet cache directory |
| `LOCKDOWN_PPO_DATA_STOP` | none | Load nothing from this day on (holdout cut) |
| `LOCKDOWN_PPO_SERIES_MB` | 400 | Per-process cache of full-history indicator series, in MB |
| `LOCKDOWN_PPO_SERIES_CACHE` | 64 | Number of kline series kept in memory per process |
| `LOCKDOWN_PPO_MB_PER_WORKER` | 700 | Memory per worker in `run_many` |
| `LOCKDOWN_PPO_RESERVE_MB` | 1500 | Memory left for the OS and ClickHouse |

On the PPO host (`/opt/workspace/ppo`), load them with `set -a && . ./.env && set +a` and run with
`.venv/bin/python -P`.

## Known differences and limits

- **Missing values:** while an indicator has no value, Node reads `null`, which JavaScript compares as 0
  (`null < 50` is true). Here it is NaN and every comparison is false. With full warm-up this does not occur.
- **OBV level:** with `warmup='full'` it differs from Node by a constant (a different start), so only relative uses
  match.
- **Intrabar order:** within one candle the engine does not know whether the high or the low came first. The stop
  wins when both are touched (conservative).
- **Not modelled:** funding, partial fills, order-book depth. Slippage is one fixed rate for every coin, too low for
  thin coins.
- **Fixed size:** a position never compounds.
- **No breakeven or time stop:** an exit has no memory of the trade (best price, candles since entry), as in the Node
  engine (TODO in `ROADMAP.md` section 4).

## Where it is used

- `search/evaluate.py`: reward of a strategy per regime, the regime gate, nulls.
- `coin_search.py`, `map_elites.py`, `train.py`: the strategy searches (MAP-Elites, PPO).
- `pairs_portfolio.py`, `pairs_exits.py`, `run_json.py`, `null_test.py`, `cross_test.py`, `universe_scan.py`:
  portfolios, exit variants, app JSON runs, null tests and scans.
- `tests/ppo/README.md` covers the search as a whole; `ROADMAP.md` and `RESUME.md` cover the plan and results.

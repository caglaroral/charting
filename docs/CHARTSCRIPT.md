# ChartScript — custom indicators

ChartScript is plain JavaScript with a Pine-like API. The complete, detailed reference is a page of the
app: [`/docs/chartscript.html`](../static/docs/chartscript.html) (opened with **Docs** in the editor's
header). This file is a short summary. Indicators are written in the in-browser editor
(**Editor** button), stored per user in ClickHouse and added to the chart like built-ins. The same
runtime (`static/js/script.js`) runs in the browser sandbox for drawing and in the server sandbox for
alerts, so an alert always sees the values you see on the chart.

## Model

Series are **arrays aligned with the bars** (`null` = Pine `na`). Most functions take and return whole
series (vectorized). For bar-by-bar logic use `series(i => …)` or a plain `for` loop — state kept in
outer variables behaves like Pine `var`.

```js
indicator('RSI with signals', { overlay: false })

const len = input('Length', 14)
const src = input.source('Source', 'close')
const r = ta.rsi(src, len)

plot(r, { title: 'RSI', color: '#7e57c2' })
hline(70); hline(30)
plotshape(ta.crossover(r, 30), { title: 'Buy', location: 'bottom', color: color.lime, shape: 'triangleup' })
```

## Reference

| API | Notes |
| --- | --- |
| `indicator(name, {overlay, precision})` | `overlay: true` draws on the price pane, otherwise a new pane; `precision`: axis decimals of that pane (default: 2 for values ≥ 1, more for small values) |
| `input(title, default, [options])` | number / string / bool input; `input.int/float/bool/string` are aliases |
| `input.source(title, 'close')`, `input.select(title, default, options)` | |
| `plot(series, {title, color, width, style})` | style `line`, `histogram`, `circles`, `area`, `cross`, `stepline`; `color` may be a color, an array of colors or `i => color` (per bar; `null` = invisible) |
| `hline(value, {color, title})` | horizontal level |
| `plotshape(bools, {title, location, color, shape, text, textcolor, size})` | location `abovebar`, `belowbar`, `top` / `bottom` (fixed at the pane edge, they do not move with the data), `absolute` (at the series value; pass numbers instead of booleans); shape `triangleup/down`, `arrowup/down`, `labelup/down`, `circle`, `square`, `diamond`, `cross`, `xcross`, `flag`; size `tiny`, `small`, `auto`, `normal`, `large`, `huge` |
| `fill(a, b, {color})` | shade between two series; per-bar color supported |
| `fill(a, b, {topValue, bottomValue, topColor, bottomColor})` | vertical gradient between two series: `topColor` at `topValue`, `bottomColor` at `bottomValue` (`null` = transparent); colors may be per bar |
| `security(tf, s => expr)` | evaluate on another timeframe (`'4h'`, `'240'`, `'D'` …). `s` exposes `open … ohlc4`, `ta`, helpers of that timeframe. No lookahead: a higher-timeframe value becomes visible when its bar closes (`barmerge.lookahead_off`). Pass `{lookahead: true}` as third argument to opt in. |
| `open high low close volume time hl2 hlc3 ohlc4` | price series |
| `n`, `bar_index`, `timeframe`, `timeframe_sec` | |
| `ta.sma/ema/wma/rma(s, len)` | moving averages |
| `ta.rsi(s, len)`, `ta.atr(len)`, `ta.tr()` | Wilder smoothing, TradingView compatible |
| `ta.stdev`, `ta.highest`, `ta.lowest`, `ta.linreg(s, len, offset)` | |
| `ta.mfi(s, len)`, `ta.stoch(s, high, low, len)`, `ta.cci(s, len)` | Pine signatures |
| `ta.change`, `ta.mom`, `ta.roc`, `ta.cum` | |
| `ta.crossover/crossunder/cross(a, b)` | `b` may be a number |
| `ta.macd`, `ta.bb`, `ta.supertrend`, `ta.vwap`, `ta.pivothigh/low`, `ta.valuewhen`, `ta.barssince` | `ta.supertrend` returns `dir = 1` for an up trend (opposite sign to Pine) |
| `shift(s, k)` | Pine `s[k]` |
| `add sub mul div max min abs` | vectorized arithmetic (arrays or numbers) |
| `series(i => …)`, `nz(x, y)`, `na(x)` | |
| `color.red …`, `color.rgb(r, g, b, transp)`, `color.new(c, transp)` | Pine colors, transparency 0–100 |
| `math.*` | `Math` plus `math.avg`, `math.sum` |

Plot keys (used by alerts) are derived from titles, so give plots and shapes a `title`.

## Porting Pine

| Pine | ChartScript |
| --- | --- |
| `a + b`, `a * 2` | `add(a, b)`, `mul(a, 2)` or `series(i => a[i] + b[i])` |
| `x[1]` | `shift(x, 1)` or `x[i - 1]` inside `series` |
| `var float v = 0` + `if` blocks | `let v = 0; for (let i = 0; i < n; i++) { … }` |
| `na`, `nz(x)` | `null`, `nz(x)` |
| `a > b` where either may be `na` | guard: `a != null && b != null && a > b` (JS treats `null` as 0) |
| `request.security(sym, "240", expr)` | `security('240', s => expr)` |
| `plot(x, style=plot.style_histogram, color=c)` | `plot(x, { style: 'histogram', color: c })` |
| `fill(p1, p2, color)` | `fill(series1, series2, { color })` |
| `fill(p1, p2, top_value, bottom_value, top_color, bottom_color)` | `fill(series1, series2, { topValue, bottomValue, topColor, bottomColor })` |
| `plot(..., style=plot.style_area)` | `plot(x, { style: 'area' })` — filled to zero with one flat color |

`examples/` contains complete ports of *SqueezeWt* and *ALL SMAs – Dynamic Multi-TF Exit*.

## Limits and sandbox

- Execution time is limited to 3 s per run (browser and server); infinite loops are stopped.
- In the browser the code runs in a worker inside a sandboxed iframe: no DOM, no cookies, no app API,
  no network (CSP). On the server it runs in a fresh `vm` context in an unprivileged Node process
  (see [SECURITY.md](SECURITY.md)).

// ALL SMAs - Dynamic Multi-TF Exit — ChartScript port of the Pine v5 script.
// Chart SMAs + 4H SMAs via security(), 4H 21MA cross signals with a dynamic exit, and a dynamic band.
indicator('ALL SMAs - Dynamic Multi-TF Exit', { overlay: true })

// ---- User inputs
const length1 = input('1. SMA Length', 7)
const length2 = input('2. SMA Length', 21)
const length3 = input('3. SMA Length', 100)
const length4 = input('4. SMA Length', 200)

const exit_source = input.select('Signal Exit (TP) Source', '4H 21MA',
  ['SMA 7', 'SMA 21', 'SMA 100', 'SMA 200', '4H 7MA', '4H 21MA', '4H 100MA', '4H 200MA'])

const bear_percentage_filter = input('Bearish Signal Close Percentage (%)', 1.1)
const bull_percentage_filter = input('Bullish Signal Close Percentage (%)', 1.1)
const enable_bear_percentage = input('Bearish Percentage Filter', true)
const enable_bull_percentage = input('Bullish Percentage Filter', true)
const enable_ma200_filter = input('4h 200 MA Trend Filter', true)
const enable_ma_order_filter = input('MA Order (Ranking) Filter', false)
const ma_order_tolerance = input('MA Order Tolerance (%)', 0.5)

// ---- Calculations
const sma1 = ta.sma(close, length1)
const sma2 = ta.sma(close, length2)
const sma3 = ta.sma(close, length3)
const sma4 = ta.sma(close, length4)

// 4H data (no lookahead, like request.security with barmerge.lookahead_off)
const close4h = security('240', s => s.close)
const ma4h7 = security('240', s => s.ta.sma(s.close, 7))
const ma4h21 = security('240', s => s.ta.sma(s.close, 21))
const ma4h100 = security('240', s => s.ta.sma(s.close, 100))
const ma4h200 = security('240', s => s.ta.sma(s.close, 200))

const exit_ma = {
  'SMA 7': sma1, 'SMA 21': sma2, 'SMA 100': sma3, 'SMA 200': sma4,
  '4H 7MA': ma4h7, '4H 21MA': ma4h21, '4H 100MA': ma4h100, '4H 200MA': ma4h200,
}[exit_source] || ma4h21

// ---- Signal logic (x[k] = value k chart bars ago; na comparisons are false)
const at = (s, i, k) => (i - k >= 0 ? s[i - k] : null)
const ok = (...v) => v.every(x => x != null)
const tol = ma_order_tolerance / 100

const bearSignal = new Array(n).fill(false)
const bullSignal = new Array(n).fill(false)
for (let i = 0; i < n; i++) {
  const c1 = at(close4h, i, 1), c2 = at(close4h, i, 2)
  const m21_1 = at(ma4h21, i, 1), m21_2 = at(ma4h21, i, 2), m200_1 = at(ma4h200, i, 1)
  const s2_1 = at(sma2, i, 1), s4_1 = at(sma4, i, 1)
  if (!ok(c1, c2, m21_1, m21_2)) continue
  const is_uptrend = ok(m200_1) && c1 > m200_1
  const is_downtrend = ok(m200_1) && c1 < m200_1
  const bear_order = ok(s2_1, s4_1, m200_1) && s2_1 <= m21_1 * (1 + tol) && m21_1 <= s4_1 * (1 + tol) && s4_1 <= m200_1 * (1 + tol)
  const bull_order = ok(s2_1, s4_1, m200_1) && s2_1 >= m21_1 * (1 - tol) && m21_1 >= s4_1 * (1 - tol) && s4_1 >= m200_1 * (1 - tol)

  const bear_min = !enable_bear_percentage || (m21_1 - c1) / m21_1 >= bear_percentage_filter / 100
  const bear_base = c1 < m21_1 && bear_min && c2 >= m21_2
  bearSignal[i] = bear_base && (!enable_ma200_filter || is_downtrend) && (!enable_ma_order_filter || bear_order)

  const bull_min = !enable_bull_percentage || (c1 - m21_1) / m21_1 >= bull_percentage_filter / 100
  const bull_base = c1 > m21_1 && bull_min && c2 <= m21_2
  bullSignal[i] = bull_base && (!enable_ma200_filter || is_uptrend) && (!enable_ma_order_filter || bull_order)
}

// ---- Signal lifecycle (Pine `var` state)
const bearEnd = new Array(n).fill(false)
const bullEnd = new Array(n).fill(false)
let bear_active = false, bull_active = false
for (let i = 0; i < n; i++) {
  bearEnd[i] = bear_active && exit_ma[i] != null && close[i] >= exit_ma[i]
  bullEnd[i] = bull_active && exit_ma[i] != null && close[i] <= exit_ma[i]
  bear_active = bearSignal[i] ? true : (bearEnd[i] ? false : bear_active)
  bull_active = bullSignal[i] ? true : (bullEnd[i] ? false : bull_active)
  if (bearSignal[i]) bull_active = false
  if (bullSignal[i]) bear_active = false
}

// ---- Visualization
plotshape(bearSignal, { title: 'Bearish Signal', location: 'abovebar', color: color.red, shape: 'triangledown' })
plotshape(bearEnd, { title: 'Bearish Signal End', location: 'abovebar', color: color.red, shape: 'circle' })
plotshape(bullSignal, { title: 'Bullish Signal', location: 'belowbar', color: color.lime, shape: 'triangleup' })
plotshape(bullEnd, { title: 'Bullish Signal End', location: 'belowbar', color: color.green, shape: 'circle' })

plot(sma1, { title: 'SMA 7', color: color.white })
plot(sma2, { title: 'SMA 21', color: color.blue, width: 3 })
plot(sma3, { title: 'SMA 100', color: color.yellow })
plot(sma4, { title: 'SMA 200', color: color.rgb(233, 30, 99), width: 5 })
plot(ma4h21, { title: '4h 21 MA', color: color.rgb(52, 185, 174), width: 2 })
plot(ma4h200, { title: '4h 200 MA', color: color.fuchsia, width: 2 })

// ---- Dynamic band
const step = input('Radius Step', 0.15)
const multi = input('Start Points Distance', 2)
const N = 3
const range = abs(sub(high, low))
const distance = mul(ta.sma(range, 100), multi)
const distance1 = mul(ta.sma(range, 100), 0.2)

// Pine semantics: `trend` is reset to na on every bar, `multi1/multi2/band` keep state (var).
const trend = new Array(n).fill(null)
const bandS = new Array(n).fill(null)
let multi1 = 0, multi2 = 0, band = 0
for (let i = 0; i < n; i++) {
  let t = null
  if (i === 101) { t = true; band = low[i] * 0.8 }
  if (band != null && close[i] < band) t = false
  if (band != null && close[i] > band) t = true
  const prev = i > 0 ? trend[i - 1] : null
  const changed = i > 0 && t !== prev && t != null && prev != null
  if (prev === false && changed) band = distance[i] == null ? null : low[i] - distance[i]
  if (prev === true && changed) band = distance[i] == null ? null : high[i] + distance[i]
  if (i % N === 0 && t === true) { multi1 = 0; multi2 += step; band = band == null || distance1[i] == null ? null : band + distance1[i] * multi2 }
  if (i % N === 0 && t === false) { multi1 += step; multi2 = 0; band = band == null || distance1[i] == null ? null : band - distance1[i] * multi1 }
  trend[i] = t
  bandS[i] = band
}
const Sband = ta.sma(bandS, N)
const bandUp = ta.sma(add(bandS, mul(distance, 0.5)), N)
const bandDn = ta.sma(sub(bandS, mul(distance, 0.5)), N)
const band1 = series(i => (trend[i] ? bandUp[i] : bandDn[i]))
const trendChanged = series(i => i > 0 && trend[i] !== trend[i - 1])

plot(band1, { title: 'Band', color: i => (i % 2 === 0 ? color.new('#d1d4dc', 50) : null) })
const sbandLine = series(i => (trendChanged[i] ? null : Sband[i]))
plot(sbandLine, { title: 'Dynamic Band', color: color.gray })
const hl2ma = ta.sma(hl2, 20) // p2 is display.none in the original
fill(sbandLine, hl2ma, { color: i => color.new(trend[i] ? '#54b6d4' : '#dd326b', 60) })

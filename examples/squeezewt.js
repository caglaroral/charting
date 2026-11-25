// SqueezeWt — ChartScript port of the Pine v5 script "SqueezeWt" (© silversky37, MPL-2.0).
// Squeeze momentum histogram + squeeze dots, normalized DPO and WaveTrend with signals.
indicator('SqueezeWt', { overlay: false })

// Pine comparisons are false when either side is na
const gt = (a, b) => a != null && b != null && a > b
const lt = (a, b) => a != null && b != null && a < b

// ---- Squeeze
const length = input('BB Length', 20)
const mult = input('BB MultFactor', 2.0)
const lengthKC = input('KC Length', 20)
const multKC = input('KC MultFactor', 1.5)
const useTrueRange = input('Use TrueRange (KC)', true)

const source = close
const basis = ta.sma(source, length)
const dev = mul(ta.stdev(source, length), multKC) // the original script uses multKC here
const upperBB = add(basis, dev)
const lowerBB = sub(basis, dev)

const ma = ta.sma(source, lengthKC)
const rangex = useTrueRange ? ta.tr() : sub(high, low)
const rangema = ta.sma(rangex, lengthKC)
const upperKC = add(ma, mul(rangema, multKC))
const lowerKC = sub(ma, mul(rangema, multKC))

const sqzOn = series(i => gt(lowerBB[i], lowerKC[i]) && lt(upperBB[i], upperKC[i]))
const sqzOff = series(i => lt(lowerBB[i], lowerKC[i]) && gt(upperBB[i], upperKC[i]))
const noSqz = series(i => !sqzOn[i] && !sqzOff[i])

const hh = ta.highest(high, lengthKC), ll = ta.lowest(low, lengthKC), smaC = ta.sma(close, lengthKC)
const center = series(i => math.avg(math.avg(hh[i], ll[i]), smaC[i]))
const val = ta.linreg(sub(source, center), lengthKC, 0)

const bcolor = series(i => {
  const v = val[i], p = nz(val[i - 1])
  if (v == null) return null
  if (v > 0) return v > p ? color.lime : color.rgb(2, 100, 2)
  return v < p ? color.rgb(223, 25, 130) : color.maroon
})
const mltpr = ta.atr(14)
const scolor = series(i => (noSqz[i] ? color.rgb(59, 255, 255) : sqzOn[i] ? color.rgb(7, 7, 7) : color.white))

plot(series(i => (val[i] == null || !mltpr[i] ? null : val[i] * 30 / (2 * mltpr[i]))), { title: 'Squeeze', color: bcolor, style: 'histogram', width: 4 })
plot(0, { title: 'Squeeze dots', color: scolor, style: 'circles', width: 2 })

// ---- Money Flow (computed, not plotted in the original)
const mflength = input('MF Length', 14)
const mfsmooth = input('MF Smooth Factor', 3)
const mf = ta.mfi(hlc3, mflength)
const smoothedMf = ta.sma(sub(mf, 50), mfsmooth)

// ---- Stochastic RSI (computed, not plotted in the original)
const smoothK = input('K', 3)
const smoothD = input('D', 3)
const lengthRSI = input('RSI Length', 14)
const lengthStoch = input('Stochastic Length', 14)
const ssrc = input.source('RSI Source', 'close')
const rsi1 = ta.rsi(ssrc, lengthRSI)
const sk = ta.sma(ta.stoch(rsi1, rsi1, rsi1, lengthStoch), smoothK)
const sd = ta.sma(sk, smoothD)

// ---- Detrended price
const period_ = input('DPO Length', 60)
const smoothFactor = input('Smoothing Factor', 21)
const atrPeriod = input('ATR Period', 14)
const longThreshold = input('Long Threshold', 1.9)
const shortThreshold = input('Short Threshold', -1.3)

const barsback = Math.floor(period_ / 2 + 1)
const dpma = ta.sma(close, period_)
const dpo = sub(close, shift(dpma, barsback))
const smoothedDpo = ta.sma(dpo, smoothFactor)
const atr = ta.atr(atrPeriod)
const normalizedDpo = series(i => (smoothedDpo[i] == null || !atr[i] ? null : smoothedDpo[i] * 2 / atr[i]))
plot(mul(normalizedDpo, 3), { title: 'Normalized DPO', width: 2, color: i => (normalizedDpo[i] > 0 ? '#0097a7' : '#ab47bc') })

// ---- WaveTrend
const n1 = input('Channel Length', 10)
const n2 = input('Average Length', 21)
const n3 = input('Coefficient', 0.015)
const obLevel1 = input('Over Bought Level 1', 60)
const obLevel2 = input('Over Bought Level 2', 53)
const osLevel1 = input('Over Sold Level 1', -60)
const osLevel2 = input('Over Sold Level 2', -53)

const ap = hlc3
const esa = ta.ema(ap, n1)
const d = ta.ema(abs(sub(ap, esa)), n1)
const ci = series(i => (esa[i] == null || !d[i] ? null : (ap[i] - esa[i]) / (n3 * d[i])))
const wt1 = ta.ema(ci, n2)
const wt2 = ta.sma(wt1, 4)

plot(0, { title: 'Zero', color: color.gray })
plot(obLevel1, { title: 'OB 1', color: color.maroon })
plot(obLevel2, { title: 'OB 2', color: color.red })
plot(osLevel2, { title: 'OS 2', color: color.lime })
plot(osLevel1, { title: 'OS 1', color: color.green })

plot(wt1, { title: 'WT1', color: color.blue })
plot(wt2, { title: 'WT2', color: color.orange })
plot(mul(sub(wt1, wt2), 1.3), { title: 'WT diff', color: color.rgb(33, 150, 243, 55), style: 'area' })
const cr = ta.cross(wt1, wt2)
plot(series(i => (cr[i] ? wt2[i] : null)), { title: 'Cross', color: color.black, style: 'circles', width: 3 })
plot(series(i => (cr[i] ? wt2[i] : null)), { title: 'Cross dir', color: i => (wt2[i] - wt1[i] > 0 ? color.red : color.lime), style: 'circles', width: 2 })

const up = ta.crossover(wt1, wt2), dn = ta.crossunder(wt1, wt2)
const wtxl = series(i => sqzOff[i] && up[i] && lt(wt1[i], -50))
const wtxs = series(i => sqzOff[i] && dn[i] && gt(wt1[i], 50))
plotshape(wtxl, { title: 'WT Signal Long', shape: 'diamond', location: 'top', color: color.rgb(54, 179, 193) })
plotshape(wtxs, { title: 'WT Signal Short', shape: 'diamond', location: 'top', color: color.rgb(255, 0, 157) })

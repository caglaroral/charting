// TC-CHART: live data, timeframes, chart types, timezone, scale, history from ClickHouse
import { test, expect } from '@playwright/test';
import { login, trackErrors, resetLayout } from '../helpers.js';

test.beforeEach(async ({ page }) => { await login(page); });

test('TC-CHART-01 chart loads exchange bars through one REST call and one websocket', async ({ page }) => {
  const s = await page.evaluate(() => ({ n: __app.S.bars.length, src: __app.S.dataSource, ws: __app.liveConnections() }));
  expect(s.n).toBeGreaterThan(100);
  expect(s.src).toMatch(/Binance/);
  expect(s.ws).toBe(1);
  await expect(page.locator('#lg-ohlc')).toContainText('O ');
});

test('TC-CHART-02 timeframe buttons and the full timeframe menu switch data', async ({ page }) => {
  await page.click('.tf-btn[data-tf="15m"]');
  await page.waitForFunction(() => __app.S.tf === '15m' && __app.S.bars.length > 50 && __app.S.bars[1].time - __app.S.bars[0].time === 900);
  await page.click('#tf-more button');
  await page.click('[data-testid="tf-menu-4h"]');
  await page.waitForFunction(() => __app.S.tf === '4h' && __app.S.bars.length > 50 && __app.S.bars[1].time - __app.S.bars[0].time === 14400);
  await page.click('.tf-btn[data-tf="1h"]');
  await page.waitForFunction(() => __app.S.tf === '1h');
});

test('TC-CHART-03 every chart type renders without errors', async ({ page }) => {
  const errors = trackErrors(page);
  const types = ['bars', 'candles', 'hollow', 'volcandles', 'line', 'linemarkers', 'stepline', 'area', 'hlcarea', 'baseline', 'columns', 'highlow', 'heikin', 'renko', 'linebreak'];
  for (const t of types) {
    await page.click('#charttype-btn');
    await page.click(`[data-testid="ct-${t}"]`);
    await page.waitForFunction((x) => __app.S.chartType === x && __app.S.view.length > 0, t);
  }
  const renko = await page.evaluate(() => { __app.S.chartType = 'renko'; __app.refreshView(); return __app.S.view.every(b => Math.abs(Math.abs(b.close - b.open) - Math.abs(__app.S.view[0].close - __app.S.view[0].open)) < 1e-6); });
  expect(renko).toBe(true);
  await page.click('#charttype-btn');
  await page.click('[data-testid="ct-candles"]');
  expect(errors).toEqual([]);
});

test('TC-CHART-04 timezone list and selection shift the axis', async ({ page }) => {
  await page.click('#tz-btn');
  expect(await page.locator('.dd-menu .dd-item').count()).toBeGreaterThan(60);
  await page.click('.dd-menu .dd-item:has-text("UTC")');
  await page.waitForFunction(() => __app.S.tzOffset === 0);
  await expect(page.locator('#tz-btn')).toHaveText('UTC');
  await page.click('#tz-btn');
  await page.click('[data-testid="tz-Tokyo"]');
  await page.waitForFunction(() => __app.S.tzOffset === 9 * 3600);
});

test('TC-CHART-05 log and auto scale toggles (A / L)', async ({ page }) => {
  await page.click('#sb-log');
  expect(await page.evaluate(() => __app.chart.priceScale('right').options().mode)).toBe(1);
  await expect(page.locator('#sb-log')).toHaveClass(/active/);
  await page.click('#sb-log');
  expect(await page.evaluate(() => __app.chart.priceScale('right').options().mode)).toBe(0);
  await page.click('#sb-auto');
  expect(await page.evaluate(() => __app.chart.priceScale('right').options().autoScale)).toBe(false);
  await page.click('#sb-auto');
  expect(await page.evaluate(() => __app.chart.priceScale('right').options().autoScale)).toBe(true);
  // both choices are saved per user
  await page.click('#sb-log');
  await page.click('#sb-auto');
  await page.waitForTimeout(1200); // debounced layout save
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.mainSeries && __app.S.view.length > 50);
  // auto off + log restored: the candles must still be on screen (the scale is fitted once, then manual)
  await page.waitForFunction(() => __app.chart.priceScale('right').options().autoScale === false);
  expect(await page.evaluate(() => __app.chart.priceScale('right').options())).toMatchObject({ mode: 1, autoScale: false });
  expect(await page.evaluate(() => {
    const b = __app.S.view[__app.S.view.length - 1];
    const y = __app.mainSeries.priceToCoordinate(b.close), h = __app.chart.panes()[0].getHeight();
    return y != null && y > 0 && y < h;
  })).toBe(true);
  await expect(page.locator('#sb-log')).toHaveClass(/active/);
  await expect(page.locator('#sb-auto')).not.toHaveClass(/active/);
  await resetLayout(page);
});

test('TC-CHART-06 scrolling back loads older bars from ClickHouse', async ({ page }) => {
  const before = await page.evaluate(() => __app.S.bars[0].time);
  await page.evaluate(() => __app.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 100 }));
  await page.waitForFunction((t) => __app.S.bars[0].time < t, before, { timeout: 30_000 });
});

test('TC-CHART-07 symbol without ClickHouse history warns "No data on ClickHouse"', async ({ page }) => {
  const sym = await page.evaluate(() => (__app.S.symbols.find(s => s.live && !s.history) || {}).symbol);
  test.skip(!sym, 'every live symbol has history');
  await page.evaluate((s) => __app.setSymbol(s), sym);
  await page.waitForFunction((s) => __app.S.symbol === s && __app.S.bars.length > 0, sym);
  await page.evaluate(() => { __app.S.exhausted = false; __app.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 50 }); });
  await expect(page.locator('.toast', { hasText: 'No data on ClickHouse' })).toBeVisible();
});

test('TC-CHART-08 typing opens symbol search and Enter switches symbol', async ({ page }) => {
  await page.locator('#chart').click({ position: { x: 300, y: 200 } });
  await page.keyboard.type('ETHUSDT');
  await expect(page.locator('[data-testid=symbol-search]')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => __app.S.symbol === 'BINANCE:ETHUSDT' && __app.S.bars.length > 0);
  await expect(page.locator('#symbol-label')).toHaveText('ETHUSDT');
  await page.evaluate(() => __app.setSymbol('BINANCE:BTCUSDT'));
});

test.afterAll(async ({ browser }) => {
  const p = await browser.newPage();
  await login(p);
  await resetLayout(p);
  await p.close();
});

test('TC-CHART-09 chart settings change candle colors, persist, and reset to defaults', async ({ page }) => {
  const errors = trackErrors(page);
  await page.click('[data-testid="chart-settings"]');
  await page.locator('[data-testid="cs-upColor"]').fill('#00bcd4');
  await page.locator('[data-testid="cs-downColor"]').fill('#e040fb');
  await page.locator('[data-testid="cs-wickVisible"]').uncheck();
  await page.waitForFunction(() => __app.mainSeries.options().upColor === '#00bcd4' && __app.mainSeries.options().wickVisible === false);
  await page.click('[data-testid="cs-save"]');
  await page.waitForTimeout(1200); // layout save is debounced
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.mainSeries && __app.S.view.length > 50);
  const o = await page.evaluate(() => __app.mainSeries.options());
  expect(o.upColor).toBe('#00bcd4');
  expect(o.downColor).toBe('#e040fb');
  expect(o.wickVisible).toBe(false);
  // Cancel discards a change, Defaults restores the TradingView colors
  await page.click('[data-testid="chart-settings"]');
  await page.locator('[data-testid="cs-upColor"]').fill('#ffffff');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => __app.mainSeries.options().upColor)).toBe('#00bcd4');
  await page.click('[data-testid="chart-settings"]');
  await page.click('[data-testid="cs-defaults"]');
  await page.click('[data-testid="cs-save"]');
  expect(await page.evaluate(() => __app.mainSeries.options().upColor)).toBe('#089981');
  await resetLayout(page);
  expect(errors).toEqual([]);
});

test('TC-CHART-10 "Scroll to the most recent bar" appears when scrolled back and returns to the last bar', async ({ page }) => {
  const btn = page.locator('[data-testid=scroll-recent]');
  await expect(btn).toBeHidden();
  // scroll position is relative to the last bar, so loading older history meanwhile does not matter
  const back = () => page.evaluate(() => __app.chart.timeScale().scrollToPosition(-200, false));
  const atEnd = () => page.evaluate(() => __app.chart.timeScale().getVisibleLogicalRange().to >= __app.S.view.length - 1);
  await back();
  await expect(btn).toBeVisible();
  await btn.click();
  await page.waitForFunction(() => __app.chart.timeScale().getVisibleLogicalRange().to >= __app.S.view.length - 1);
  await expect(btn).toBeHidden();
  await expect.poll(async () => { await back(); return atEnd(); }, { timeout: 5000 }).toBe(false);
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await page.waitForFunction(() => __app.chart.timeScale().getVisibleLogicalRange().to >= __app.S.view.length - 1);
});

test('TC-CHART-11 changing the timeframe keeps the date on screen (history is loaded as needed)', async ({ page }) => {
  await resetLayout(page);
  const center = () => page.evaluate(() => {
    const r = __app.chart.timeScale().getVisibleLogicalRange();
    const i = Math.round((r.from + r.to) / 2);
    return { t: __app.S.view[i].time - __app.S.tzOffset, w: Math.round(r.to - r.from) };
  });
  const target = Date.UTC(2026, 8, 20, 12) / 1000; // 2026-09-20 12:00 UTC, ClickHouse history
  await page.evaluate(() => __app.setTf('1D'));
  await page.waitForFunction(() => __app.S.tf === '1D' && __app.S.view.length > 100);
  await page.evaluate((t) => {
    const i = __app.S.view.findIndex(b => b.time - __app.S.tzOffset >= t);
    __app.chart.timeScale().setVisibleLogicalRange({ from: i - 40, to: i + 40 });
  }, target);
  const d = await center();
  expect(Math.abs(d.t - target)).toBeLessThanOrEqual(86400);
  for (const [tf, sec] of [['4h', 14400], ['15m', 900]]) {
    await page.evaluate((x) => __app.setTf(x), tf);
    expect(await page.evaluate(() => __app.S.view[1].time - __app.S.view[0].time)).toBe(sec);
    await expect.poll(async () => { const c = await center(); return Math.abs(c.t - d.t) <= 86400 && c.w === 80; }, { timeout: 30_000 }).toBe(true);
  }
  // at the latest bar the chart stays at the latest bar
  await page.evaluate(() => { const n = __app.S.view.length; __app.chart.timeScale().setVisibleLogicalRange({ from: n - 60, to: n + 5 }); });
  await page.evaluate(() => __app.setTf('1h'));
  await page.waitForFunction(() => __app.S.tf === '1h');
  await expect.poll(() => page.evaluate(() => { const r = __app.chart.timeScale().getVisibleLogicalRange(); return Math.round(r.to - (__app.S.view.length - 1)); })).toBe(6);
  await resetLayout(page);
});

// TC-IND: built-in indicators: add, settings, legend actions, panes
import { test, expect } from '@playwright/test';
import { login, user, trackErrors, resetLayout } from '../helpers.js';

test.beforeEach(async ({ page }) => { await login(page); await resetLayout(page); await page.reload(); await page.waitForFunction(() => window.__app && __app.S.view.length > 50); });

test('TC-IND-01 every built-in indicator computes and renders', async ({ page }) => {
  // the unlimited plan is needed to stack every indicator on one chart (dedicated user, not the admin)
  await login(page, user('unlimited'));
  await resetLayout(page);
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.view.length > 50);
  const errors = trackErrors(page);
  await page.click('#btn-indicators');
  const names = await page.locator('[data-ind-type]').evaluateAll(els => els.map(e => e.dataset.indType));
  await page.keyboard.press('Escape');
  expect(names.length).toBeGreaterThan(20);
  for (const t of names) await page.evaluate((x) => __app.addIndicator(x), t);
  await page.waitForFunction((n) => __app.ind.items.length === n + 1 && __app.ind.items.every(i => i.res), names.length);
  const bad = await page.evaluate(() => __app.ind.items.filter(it => it.res.error || !it.res.plots.some(p => p.data.some(v => v != null))).map(it => it.inst.type));
  expect(bad).toEqual([]);
  expect(await page.evaluate(() => __app.chart.panes().length)).toBeGreaterThan(5);
  expect(errors).toEqual([]);
  await resetLayout(page);
});

test('TC-IND-05 the plan limits indicators per chart', async ({ page }) => {
  const lim = await page.evaluate(() => __app.S.plan.limits.indicators_per_chart);
  await page.evaluate((n) => { for (let i = 0; i < n + 2; i++) __app.addIndicator('sma'); }, lim);
  expect(await page.evaluate(() => __app.S.indicators.length)).toBe(lim);
  await expect(page.locator('.toast', { hasText: 'indicators per chart' }).first()).toBeVisible();
  await resetLayout(page);
});

test('TC-IND-02 add RSI from the picker, change settings, hide, remove', async ({ page }) => {
  await page.click('#btn-indicators');
  await page.fill('[data-testid=ind-search]', 'Relative');
  await page.click('[data-ind-type=rsi]');
  const row = page.locator('.pane-legend .lg-ind').first();
  await expect(row).toContainText('RSI 14');
  await row.hover();
  await row.locator('[data-testid=ind-settings]').click();
  await page.locator('.modal .form-grid input[type=number]').first().fill('21');
  await page.click('[data-testid=ind-save]');
  await expect(page.locator('.pane-legend .lg-ind').first()).toContainText('RSI 21');
  await page.locator('.pane-legend .lg-ind').first().hover();
  await page.locator('.pane-legend .lg-ind').first().locator('[data-testid=ind-toggle]').click();
  await page.waitForFunction(() => __app.S.indicators.find(i => i.type === 'rsi').visible === false);
  await page.evaluate(() => { const i = __app.S.indicators.find(x => x.type === 'rsi'); __app.removeIndicator(i.id); });
  await page.waitForFunction(() => !__app.S.indicators.some(i => i.type === 'rsi') && __app.chart.panes().length === 1);
});

test('TC-IND-03 pane controls move and maximize panes', async ({ page }) => {
  await page.evaluate(() => { __app.addIndicator('rsi'); __app.addIndicator('macd'); });
  await page.waitForFunction(() => __app.chart.panes().length === 3);
  const order = () => page.evaluate(() => __app.ind.items.filter(i => i.pane > 0).sort((a, b) => a.pane - b.pane).map(i => i.inst.type));
  expect(await order()).toEqual(['rsi', 'macd']);
  await page.evaluate(() => {
    const macd = __app.S.indicators.find(i => i.type === 'macd');
    document.querySelector(`.pane-ctrl-wrap[data-pane="2"] button[title="Move pane up"]`).click();
    return macd;
  });
  await page.waitForFunction(() => __app.ind.items.find(i => i.inst.type === 'macd')?.pane === 1);
  expect(await order()).toEqual(['macd', 'rsi']);
});

test('TC-IND-04 RSI values match a reference calculation', async ({ page }) => {
  await page.evaluate(() => __app.addIndicator('rsi'));
  await page.waitForFunction(() => __app.ind.items.some(i => i.inst.type === 'rsi' && i.res.plots));
  const { got, want } = await page.evaluate(() => {
    const c = __app.S.view.map(b => b.close);
    let au = 0, ad = 0;
    for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; au += Math.max(d, 0); ad += Math.max(-d, 0); }
    au /= 14; ad /= 14;
    for (let i = 15; i < c.length; i++) { const d = c[i] - c[i - 1]; au = (au * 13 + Math.max(d, 0)) / 14; ad = (ad * 13 + Math.max(-d, 0)) / 14; }
    const it = __app.ind.items.find(i => i.inst.type === 'rsi');
    return { got: it.res.plots[0].data[c.length - 1], want: 100 - 100 / (1 + au / ad) };
  });
  expect(Math.abs(got - want)).toBeLessThan(1e-6);
});

test('TC-IND-06 legend buttons stay visible while hovering during live updates', async ({ page }) => {
  await page.evaluate(() => __app.addIndicator('rsi'));
  const row = page.locator('.pane-legend .lg-ind').first();
  await row.hover();
  await expect(row.locator('[data-testid=ind-settings]')).toBeVisible();
  const before = await row.elementHandle();
  await page.evaluate(() => __app.refreshIndicators()); // what every live tick does
  await page.waitForTimeout(2500); // let real websocket ticks arrive as well
  expect(await before.evaluate(e => e.isConnected)).toBe(true); // the legend row was not re-created
  await expect(row.locator('[data-testid=ind-settings]')).toBeVisible();
  await resetLayout(page);
});

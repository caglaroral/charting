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

test('TC-IND-03 pane controls: move up/down (also above the price pane), delete, collapse, maximize', async ({ page }) => {
  await page.evaluate(() => { __app.addIndicator('rsi'); __app.addIndicator('macd'); });
  await page.waitForFunction(() => __app.chart.panes().length === 3);
  // visual order of all panes, price pane = 'main'
  const order = () => page.evaluate(() => {
    const names = []; names[__app.mainPaneIndex()] = 'main';
    for (const i of __app.ind.items) if (i.own) names[i.pane] = i.inst.type;
    return names;
  });
  const ctrl = (type, id) => page.evaluate(([t, x]) => {
    const it = __app.ind.items.find(i => i.inst.type === t);
    document.querySelector(`.pane-ctrl-wrap[data-pane="${it.pane}"] [data-testid="${x}"]`).click();
  }, [type, id]);
  expect(await order()).toEqual(['main', 'rsi', 'macd']);
  // only possible moves are offered: the last pane has no "down"
  expect(await page.locator('.pane-ctrl-wrap[data-pane="2"] [data-testid=pane-down]').count()).toBe(0);
  await ctrl('macd', 'pane-up');
  await page.waitForFunction(() => __app.ind.items.find(i => i.inst.type === 'macd')?.pane === 1);
  expect(await order()).toEqual(['main', 'macd', 'rsi']);
  // a pane can move above the price pane; the price legend follows it
  await ctrl('macd', 'pane-up');
  await page.waitForFunction(() => __app.mainPaneIndex() === 1);
  expect(await order()).toEqual(['macd', 'main', 'rsi']);
  const legendTop = await page.evaluate(() => parseFloat(document.querySelector('#legend').style.top));
  expect(legendTop).toBeGreaterThan(40);
  // collapse leaves a thin pane with its legend, expand restores it
  await ctrl('rsi', 'pane-collapse');
  await page.waitForFunction(() => __app.chart.panes()[2].getHeight() < 45);
  await page.waitForTimeout(1200); // debounced layout save
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.ind.items.filter(i => i.own).length === 2);
  expect(await order()).toEqual(['macd', 'main', 'rsi']); // order and collapse are saved
  await page.waitForFunction(() => __app.chart.panes()[2].getHeight() < 45);
  await ctrl('rsi', 'pane-collapse');
  await page.waitForFunction(() => __app.chart.panes()[2].getHeight() > 60);
  // maximize / restore
  await ctrl('macd', 'pane-maximize');
  await page.waitForFunction(() => __app.chart.panes()[0].getHeight() > __app.chart.panes()[1].getHeight() * 5);
  await ctrl('macd', 'pane-maximize');
  await page.waitForFunction(() => __app.chart.panes()[1].getHeight() > __app.chart.panes()[0].getHeight());
  // delete
  await ctrl('macd', 'pane-delete');
  await page.waitForFunction(() => __app.chart.panes().length === 2 && __app.mainPaneIndex() === 0);
  await resetLayout(page);
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

test('TC-IND-07 indicator panes have their own auto / log scale buttons, independent of the price pane', async ({ page }) => {
  await page.evaluate(() => __app.addIndicator('rsi'));
  await page.waitForFunction(() => __app.ind.items.some(i => i.pane === 1));
  // log on the price pane must not switch the oscillator pane to log
  await page.click('#sb-log');
  expect(await page.evaluate(() => [__app.chart.priceScale('right', 0).options().mode, __app.chart.priceScale('right', 1).options().mode])).toEqual([1, 0]);
  await page.click('#sb-log');
  const btns = page.locator('.pane-scale-btns[data-pane="1"]');
  await expect(btns.locator('[data-testid=pane-auto]')).toHaveClass(/active/);
  await btns.locator('[data-testid=pane-log]').click();
  await btns.locator('[data-testid=pane-auto]').click();
  expect(await page.evaluate(() => __app.chart.priceScale('right', 1).options())).toMatchObject({ mode: 1, autoScale: false });
  expect(await page.evaluate(() => __app.chart.priceScale('right', 0).options().mode)).toBe(0);
  await page.waitForTimeout(1200); // debounced layout save
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.ind.items.some(i => i.pane === 1));
  expect(await page.evaluate(() => __app.chart.priceScale('right', 1).options())).toMatchObject({ mode: 1, autoScale: false });
  await expect(page.locator('.pane-scale-btns[data-pane="1"] [data-testid=pane-log]')).toHaveClass(/active/);
  await resetLayout(page);
});

test('TC-IND-08 indicators stay aligned with the bars when older history is loaded', async ({ page }) => {
  const id = await page.evaluate(() => __app.addIndicator('sma').id);
  await page.waitForFunction(() => __app.ind.items.some(i => i.inst.type === 'sma' && i.res.plots));
  const lastVal = () => page.evaluate(() => { const it = __app.ind.items.find(i => i.inst.type === 'sma'); const d = it.res.plots[0].data; return +d[d.length - 1].toFixed(4); });
  const legend = () => page.locator(`.lg-ind[data-ind="${id}"] .lg-vals`).innerText();
  await page.mouse.move(5, 5); // keep the crosshair off the chart: the legend then shows the last bar
  await page.waitForTimeout(200);
  const v0 = await lastVal(), l0 = await legend(), n0 = await page.evaluate(() => __app.S.view.length);
  // scroll to the start: older bars are prepended from ClickHouse
  await page.evaluate(() => __app.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 100 }));
  await page.waitForFunction((n) => __app.S.view.length > n, n0, { timeout: 30_000 });
  await page.evaluate(() => __app.chart.timeScale().scrollToPosition(12, false));
  await page.waitForFunction(() => __app.ind.items.every(i => i.res.t0 === __app.S.view[0].time));
  expect(await lastVal()).toBeCloseTo(v0, 2);      // same value for the same (last) bar
  await page.waitForTimeout(300);
  expect(await legend()).toBe(l0);                 // legend reads the right bar
});

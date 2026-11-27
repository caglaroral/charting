// TC-MOBILE: phone layout — tab bar, Watchlist / Alerts panels, drawing tools sheet, ☰ menu
import { test, expect } from '@playwright/test';
import { login, trackErrors, resetLayout } from '../helpers.js';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.beforeEach(async ({ page }) => { await login(page); });

const visible = (page, sel) => page.locator(sel).first().isVisible();

test('TC-MOBILE-01 phone layout: tab bar, panels, menu, timeframe list', async ({ page }) => {
  const errors = trackErrors(page);
  await resetLayout(page);
  // desktop toolbars are replaced by the tab bar and the ☰ button
  expect(await page.evaluate(() => document.body.classList.contains('mobile'))).toBe(true);
  for (const sel of ['#lefttools', '.bottombar', '#btn-editor', '#user-menu', '.tf-group']) expect(await visible(page, sel), sel).toBe(false);
  for (const sel of ['#tabbar', '[data-testid=m-menu]', '[data-testid=tf-more]']) expect(await visible(page, sel), sel).toBe(true);
  await expect(page.locator('#m-tf')).toHaveText(await page.evaluate(() => ({ '1D': 'D', '1W': 'W', '1M': 'M' })[__app.S.tf] || __app.S.tf));
  // timeframe list from the current timeframe button
  await page.tap('[data-testid=tf-more]');
  await page.tap('[data-testid=tf-menu-4h]');
  await page.waitForFunction(() => __app.S.tf === '4h');
  await expect(page.locator('#m-tf')).toHaveText('4h');
  // Watchlist: the panel covers the chart; picking a symbol goes back to the chart
  await page.tap('[data-testid=tab-watchlist]');
  await expect(page.locator('#tab-watchlist')).toBeVisible();
  await expect(page.locator('[data-testid=tab-watchlist]')).toHaveClass(/active/);
  const other = page.locator('.wl-row:not(.active)').first();
  const sym = await other.getAttribute('data-sym');
  await other.tap();
  await page.waitForFunction((s) => __app.S.symbol === s, sym);
  await expect(page.locator('#tab-watchlist')).toBeHidden();
  await expect(page.locator('[data-testid=tab-chart]')).toHaveClass(/active/);
  // Alerts
  await page.tap('[data-testid=tab-alerts]');
  await expect(page.locator('#al-new')).toBeVisible();
  await page.tap('[data-testid=tab-chart]');
  await expect(page.locator('#al-new')).toBeHidden();
  // ☰ menu: scale toggles stay in the menu, time zone, editor
  await page.tap('[data-testid=m-menu]');
  const log0 = await page.evaluate(() => __app.S.scaleMode);
  await page.tap('[data-testid=m-log]');
  expect(await page.evaluate(() => __app.S.scaleMode)).toBe(log0 === 1 ? 0 : 1);
  await expect(page.locator('[data-testid=sheet-menu]')).toBeVisible();
  await page.tap('[data-testid=m-log]'); // back
  await expect(page.locator('[data-testid=m-menu-logout]')).toBeVisible();
  await page.tap('[data-testid=m-goto]');
  await expect(page.locator('[data-testid=goto-at-date]')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await resetLayout(page);
});

test('TC-MOBILE-02 drawing on a phone: tools sheet, two taps, tool bar, cancel', async ({ page }) => {
  const errors = trackErrors(page);
  await resetLayout(page);
  const before = await page.evaluate(() => __app.dm.drawings.length);
  await page.tap('[data-testid=tab-draw]');
  await expect(page.locator('[data-testid=sheet-draw]')).toBeVisible();
  await page.tap('[data-testid=m-tool-trend]');
  await expect(page.locator('[data-testid=sheet-draw]')).toHaveCount(0);
  await expect(page.locator('[data-testid=m-drawtb]')).toBeVisible();
  await expect(page.locator('[data-testid=m-drawtb]')).toContainText('Trend Line');
  const box = await page.locator('#chart').boundingBox();
  await page.tap('#chart', { position: { x: box.width * 0.3, y: box.height * 0.3 } });
  await page.tap('#chart', { position: { x: box.width * 0.6, y: box.height * 0.2 } });
  await page.waitForFunction((n) => __app.dm.drawings.length === n + 1, before);
  expect(await page.evaluate(() => __app.dm.drawings.at(-1).tool)).toBe('trend');
  // the tool ends after one drawing (no "stay in drawing mode"): the bar goes away
  await expect(page.locator('[data-testid=m-drawtb]')).toBeHidden();
  // pick again and cancel from the bar
  await page.tap('[data-testid=tab-draw]');
  await page.tap('[data-testid=m-tool-hline]');
  await page.tap('[data-testid=m-drawtb-cancel]');
  expect(await page.evaluate(() => __app.dm.tool)).toBe('cursor');
  await expect(page.locator('[data-testid=m-drawtb]')).toBeHidden();
  await page.evaluate(() => __app.dm.removeAll());
  expect(errors).toEqual([]);
  await resetLayout(page);
});

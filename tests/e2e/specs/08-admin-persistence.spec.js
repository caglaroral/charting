// TC-ADMIN: data sources, plans, users. TC-PERSIST: the workspace is restored per user.
import { test, expect } from '@playwright/test';
import { login, admin, user, resetLayout } from '../helpers.js';

test('TC-ADMIN-01 data source dialog tests the ClickHouse connection and scans tables', async ({ page }) => {
  await login(page, admin());
  await page.click('#user-btn');
  await page.click('[data-testid=menu-datasources]');
  await expect(page.locator('.ds-item .ds-pfx')).toContainText(['BINANCE']);
  await page.locator('.ds-item button:has-text("Edit")').first().click();
  await page.click('[data-testid=ds-test]');
  await expect(page.locator('.ok-box')).toContainText('Connected');
  await page.click('[data-testid=ds-discover]');
  await expect(page.locator('.ok-box')).toContainText('look like OHLC');
  expect(await page.locator('.ds-tables tr').count()).toBeGreaterThan(5);
});

test('TC-ADMIN-03 timeframe tables can be typed by name (tables or views) and are checked on save', async ({ page }) => {
  await login(page, admin());
  await page.click('#user-btn');
  await page.click('[data-testid=menu-datasources]');
  await page.locator('.ds-item button:has-text("Edit")').first().click();
  // existing rows are editable inputs; the type comes from the database
  await expect(page.locator('[data-testid=ds-table-0]')).toBeEditable();
  await expect(page.locator('.ds-tables tr').nth(1).locator('td').nth(2)).toHaveText(/table|view/);
  expect(await page.locator('#ds-table-list option').count()).toBeGreaterThan(3); // suggestions
  const n = await page.locator('[data-testid^=ds-table-]').count();
  await page.click('[data-testid=ds-add-table]');
  await page.fill(`[data-testid=ds-table-${n}]`, 'no_such_table_e2e');
  await page.selectOption(`[data-testid=ds-tf-${n}]`, '30m');
  await page.click('[data-testid=ds-save]');
  // rejected by the server: nothing is saved
  await expect(page.locator('.toast', { hasText: 'no_such_table_e2e does not exist' })).toBeVisible();
  // two tables for one timeframe are rejected before saving
  await page.fill(`[data-testid=ds-table-${n}]`, await page.inputValue('[data-testid=ds-table-0]'));
  await page.selectOption(`[data-testid=ds-tf-${n}]`, await page.inputValue('[data-testid=ds-tf-0]'));
  await page.click('[data-testid=ds-save]');
  await expect(page.locator('.toast', { hasText: 'Two tables are set for' })).toBeVisible();
});

test('TC-ADMIN-02 plans and users dialogs; non-admins do not see admin menus', async ({ page, browser }) => {
  await login(page, admin());
  await page.click('#user-btn');
  await page.click('[data-testid=menu-plans]');
  await expect(page.locator('.modal')).toContainText('Active alerts');
  await page.keyboard.press('Escape');
  await page.click('#user-btn');
  await page.click('[data-testid=menu-users]');
  await expect(page.locator(`[data-testid="user-plan-${user('free').username}"]`)).toHaveValue('free');
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await login(p2, user('free'));
  await p2.click('#user-btn');
  await expect(p2.locator('[data-testid=menu-datasources]')).toHaveCount(0);
  await ctx.close();
});

test('TC-PERSIST-01 symbol, timeframe, chart type, indicators and drawings are restored after logout/login', async ({ page }) => {
  await login(page);
  await resetLayout(page);
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.view && __app.S.view.length > 50);
  await page.evaluate(async () => {
    await __app.setSymbol('BINANCE:ETHUSDT', { tf: '4h' });
    __app.dm.removeAll(); // start from a clean drawing set on this symbol
    __app.S.chartType = 'hollow';
    __app.addIndicator('ema');
    __app.addIndicator('macd');
    __app.dm.setTool('hline');
  });
  const r = await page.locator('#chart').boundingBox();
  await page.mouse.click(r.x + r.width / 2, r.y + 150);
  await page.waitForTimeout(1500); // debounced saves
  await page.click('#user-btn');
  await page.click('[data-testid=menu-logout]');
  await page.waitForLoadState('load');
  await login(page, undefined, { navigate: false });
  const s = await page.evaluate(() => ({ sym: __app.S.symbol, tf: __app.S.tf, ct: __app.S.chartType, inds: __app.S.indicators.map(i => i.type), dr: __app.dm.drawings.map(d => d.tool) }));
  expect(s).toEqual({ sym: 'BINANCE:ETHUSDT', tf: '4h', ct: 'hollow', inds: ['volume', 'ema', 'macd'], dr: ['hline'] });
  await page.evaluate(() => __app.dm.removeAll());
  await resetLayout(page);
});

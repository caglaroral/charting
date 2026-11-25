// TC-DRAW: every drawing tool can be drawn from the toolbar, edited, persisted, undone
import { test, expect } from '@playwright/test';
import { login, trackErrors, chartPoint, closeModals } from '../helpers.js';

const clearDrawings = (page) => page.evaluate(() => { __app.dm.removeAll(); return new Promise(r => setTimeout(r, 600)); });

async function pickTool(page, group, tool) {
  await page.hover(`.lt-btn[data-group="${group}"]`);
  await page.click(`.lt-btn[data-group="${group}"] .lt-caret`);
  await page.click(`[data-testid="tool-${tool}"]`);
  await page.waitForFunction((t) => __app.dm.tool === t || __app.dm.cursorMode === t, tool);
}

async function drawWithClicks(page, n) {
  const pts = [[30, 0.35], [20, 0.55], [12, 0.3], [6, 0.6], [3, 0.4], [2, 0.5], [1, 0.45]];
  for (let i = 0; i < n; i++) {
    const p = await chartPoint(page, pts[i][0], pts[i][1]);
    await page.mouse.click(p.x, p.y);
  }
}

test.beforeEach(async ({ page }) => { await login(page); await clearDrawings(page); });

test('TC-DRAW-01 every tool in every group draws without errors', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  const tools = await page.evaluate(() => [...document.querySelectorAll('.lt-btn[data-group]')].map(b => b.dataset.group));
  const all = await page.evaluate(() => {
    const out = [];
    for (const g of [...document.querySelectorAll('.lt-btn[data-group]')].map(b => b.dataset.group)) {
      if (g === 'cursors') continue;
      out.push(...Object.values(window.__tools).filter(t => t.group === g && !t.hidden).map(t => ({ id: t.id, group: g, pts: t.pts })));
    }
    return out;
  });
  expect(tools.length).toBe(7);
  expect(all.length).toBeGreaterThan(60);
  let expected = 0;
  for (const t of all) {
    await pickTool(page, t.group, t.id);
    if (t.pts === 'free') {
      const a = await chartPoint(page, 30, 0.4), b = await chartPoint(page, 5, 0.5);
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, a.y - 30, { steps: 5 }); await page.mouse.move(b.x, b.y, { steps: 5 });
      await page.mouse.up();
    } else if (t.pts === 'multi') {
      await drawWithClicks(page, 3);
      const p = await chartPoint(page, 3, 0.4);
      await page.mouse.dblclick(p.x, p.y);
    } else {
      await drawWithClicks(page, t.pts === 'pos' ? 1 : t.pts);
    }
    if (await page.locator('.modal-backdrop').count()) { await page.keyboard.press('Enter'); await closeModals(page); }
    expected++;
    const n = await page.evaluate(() => __app.dm.drawings.length);
    expect(n, `tool ${t.id}`).toBe(expected);
    await page.keyboard.press('Escape');
  }
  // every drawing produced hit geometry (it was actually rendered)
  const unrendered = await page.evaluate(() => __app.dm.drawings.filter(d => !(d._hits || []).length).map(d => d.tool));
  expect(unrendered).toEqual([]);
  expect(errors).toEqual([]);
  await clearDrawings(page);
});

test('TC-DRAW-02 trend line: select, restyle, move, delete, undo/redo, persistence', async ({ page }) => {
  await pickTool(page, 'lines', 'trend');
  await drawWithClicks(page, 2);
  await expect(page.locator('#drawbar')).toBeVisible();
  // restyle
  await page.click('[data-testid=db-color]');
  await page.locator('.swatches .swatch').nth(2).click();
  expect(await page.evaluate(() => __app.dm.selected().style.color)).toBe('#f23645');
  // persisted
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.dm.drawings.length === 1, null, { timeout: 30_000 });
  expect(await page.evaluate(() => __app.dm.drawings[0].style.color)).toBe('#f23645');
  // select by clicking on the line and delete with the keyboard
  const mid = await page.evaluate(() => {
    const d = __app.dm.drawings[0], r = document.querySelector('#chart').getBoundingClientRect();
    const [a, b] = d.points.map(p => __app.dm.xy(p));
    return { x: r.left + (a[0] + b[0]) / 2, y: r.top + (a[1] + b[1]) / 2 };
  });
  await page.mouse.click(mid.x, mid.y);
  await expect(page.locator('#drawbar')).toBeVisible();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => __app.dm.drawings.length)).toBe(0);
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => __app.dm.drawings.length)).toBe(1);
  await page.keyboard.press('Control+y');
  expect(await page.evaluate(() => __app.dm.drawings.length)).toBe(0);
});

test('TC-DRAW-03 drawings follow the symbol and are shared across timeframes', async ({ page }) => {
  await pickTool(page, 'lines', 'hline');
  await drawWithClicks(page, 1);
  await page.waitForTimeout(800);
  await page.click('.tf-btn[data-tf="4h"]');
  await page.waitForFunction(() => __app.S.tf === '4h' && __app.dm.drawings.length === 1);
  await page.evaluate(() => __app.setSymbol('BINANCE:ETHUSDT'));
  await page.waitForFunction(() => __app.S.symbol === 'BINANCE:ETHUSDT' && __app.dm.drawings.length === 0);
  await page.evaluate(() => __app.setSymbol('BINANCE:BTCUSDT', { tf: '1h' }));
  await page.waitForFunction(() => __app.S.symbol === 'BINANCE:BTCUSDT' && __app.dm.drawings.length === 1);
  await clearDrawings(page);
});

test('TC-DRAW-04 eraser cursor deletes, measure tool is temporary, zoom changes range', async ({ page }) => {
  await pickTool(page, 'lines', 'vline');
  await drawWithClicks(page, 1);
  await pickTool(page, 'cursors', 'eraser');
  const p = await chartPoint(page, 30, 0.5);
  await page.mouse.click(p.x, p.y);
  expect(await page.evaluate(() => __app.dm.drawings.length)).toBe(0);
  await pickTool(page, 'cursors', 'cross');
  await page.click('.lt-btn[data-tool=ruler]');
  await drawWithClicks(page, 2);
  expect(await page.evaluate(() => [__app.dm.drawings.length, !!__app.dm.temp])).toEqual([0, true]);
  const before = await page.evaluate(() => __app.chart.timeScale().getVisibleLogicalRange());
  await page.click('.lt-btn[data-tool=zoom]');
  await drawWithClicks(page, 2);
  const after = await page.evaluate(() => __app.chart.timeScale().getVisibleLogicalRange());
  expect(after.to - after.from).toBeLessThan(before.to - before.from);
});

// TC-SCRIPT: custom indicators (ChartScript) — editor, run, errors, sandbox, Pine ports
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { login, trackErrors, resetLayout } from '../helpers.js';

const example = (f) => fs.readFileSync(new URL(`../../../examples/${f}`, import.meta.url), 'utf8');

async function openEditor(page) {
  await page.click('#btn-editor');
  await page.waitForFunction(() => window.__cm);
}
const setCode = (page, code) => page.evaluate((c) => window.__cm.setValue(c), code);

test.beforeEach(async ({ page }) => { await login(page); await resetLayout(page); });

test('TC-SCRIPT-01 write, run, save and add a custom indicator', async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page);
  await page.click('[data-testid=script-new]');
  await page.fill('[data-testid=script-name]', 'E2E EMA cross');
  await page.click('[data-testid=script-run]');
  await expect(page.locator('.editor-out .ok-box')).toContainText('2 plot');
  await page.click('[data-testid=script-add]');
  await page.waitForFunction(() => __app.ind.items.some(i => i.res.name === 'My Indicator' && i.res.plots?.length === 2));
  await expect(page.locator('#legend')).toContainText('My Indicator 9 21');
  expect(errors).toEqual([]);
});

test('TC-SCRIPT-02 syntax and runtime errors are reported with a line number', async ({ page }) => {
  await openEditor(page);
  await page.click('[data-testid=script-new]');
  await setCode(page, "indicator('x')\nconst a = 1\nplot(undefinedVariable)\n");
  await page.click('[data-testid=script-run]');
  await expect(page.locator('.editor-out .err-box')).toContainText('undefinedVariable');
  await expect(page.locator('.editor-out .err-box')).toContainText('line 3');
});

test('TC-SCRIPT-03 sandbox: infinite loops time out, network and cookies are unreachable', async ({ page }) => {
  await openEditor(page);
  await page.click('[data-testid=script-new]');
  await setCode(page, 'while (true) {}');
  await page.click('[data-testid=script-run]');
  await expect(page.locator('.editor-out .err-box')).toContainText('Timeout', { timeout: 15_000 });
  // the page stays responsive
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  await setCode(page, "indicator('x'); plot(close, { title: String(typeof document) + '|' + String(typeof fetch === 'function' ? 'fetch' : 'nofetch') + '|' + String(typeof parent) })");
  await page.click('[data-testid=script-run]');
  await expect(page.locator('.editor-out .ok-box')).toContainText('undefined|');
  // fetch exists in a worker, but the sandbox CSP blocks it and there are no cookies
  await setCode(page, "indicator('x'); fetch('/api/me').then(()=>{}); plot(close)");
  await page.click('[data-testid=script-run]');
  await expect(page.locator('.editor-out .ok-box')).toBeVisible();
});

test('TC-SCRIPT-04 SqueezeWt port renders in its own pane with signals', async ({ page }) => {
  const errors = trackErrors(page);
  const r = await page.evaluate(async (code) => {
    const res = await fetch('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'SqueezeWt e2e', code }) });
    return (await res.json()).script;
  }, example('squeezewt.js'));
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.view.length > 50);
  await page.evaluate((id) => __app.addIndicator('custom', { script_id: id }), r.id);
  await page.waitForFunction(() => __app.ind.items.some(i => i.res.name === 'SqueezeWt' && i.res.plots));
  const info = await page.evaluate(() => { const it = __app.ind.items.find(i => i.res.name === 'SqueezeWt'); return { pane: it.pane, plots: it.res.plots.length, shapes: it.res.shapes.length, inputs: it.res.inputs.length }; });
  expect(info).toEqual({ pane: 1, plots: 13, shapes: 2, inputs: 24 });
  await expect(page.locator('.pane-legend')).toContainText('SqueezeWt 20 2 20 1.5 14 3 3 3 14 14 close 60 21 14 1.9 -1.3 10 21 0.015 60 53 -60 -53');
  await page.evaluate((id) => fetch('/api/scripts/' + id, { method: 'DELETE' }), r.id);
  expect(errors).toEqual([]);
});

test('TC-SCRIPT-05 ALL SMAs port uses 4H security() data and fill()', async ({ page }) => {
  const r = await page.evaluate(async (code) => {
    const res = await fetch('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ALL SMAs e2e', code }) });
    return (await res.json()).script;
  }, example('all-smas.js'));
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.view.length > 50);
  await page.evaluate((id) => __app.addIndicator('custom', { script_id: id }), r.id);
  await page.waitForFunction(() => __app.ind.items.some(i => i.res.name?.startsWith('ALL SMAs') && (i.res.plots || i.res.error)), null, { timeout: 30_000 });
  const info = await page.evaluate(() => {
    const it = __app.ind.items.find(i => i.res.name?.startsWith('ALL SMAs'));
    const p = (t) => it.res.plots.find(x => x.title === t).data;
    const f = it.res.fills[0];
    return { err: it.res.error, overlay: it.res.overlay, fills: it.res.fills.length, gradient: !!f?.gradient, fade: f?.bottomColor, ma4h: p('4h 21 MA').filter(v => v != null).length, n: __app.S.view.length };
  });
  expect(info.err).toBeUndefined();
  expect(info.overlay).toBe(true);
  expect(info.fills).toBe(1);
  expect(info.gradient).toBe(true); // Pine gradient fill: colored at the band, transparent at the MA
  expect(info.fade).toBe('rgba(0,0,0,0)');
  expect(info.ma4h).toBeGreaterThan(info.n * 0.5);
  await page.evaluate((id) => fetch('/api/scripts/' + id, { method: 'DELETE' }), r.id);
});

test('TC-SCRIPT-06 the editor opens the ChartScript reference in a new tab', async ({ page, context }) => {
  await page.click('#btn-editor');
  await page.waitForFunction(() => window.__cm);
  await expect(page.locator('.editor-doc')).toHaveCount(0); // no side panel squeezing the editor
  const link = page.locator('[data-testid=script-docs]');
  await expect(link).toHaveAttribute('target', '_blank');
  const [docs] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await docs.waitForLoadState();
  await expect(docs.locator('h1')).toHaveText('ChartScript');
  await expect(docs.locator('#ta')).toBeVisible();
  await expect(docs.locator('#named-colors tr')).toHaveCount(7);
  await docs.close();
});

test('TC-SCRIPT-07 plotshape: diamonds at the pane top / bottom stay fixed at the pane edge while scrolling', async ({ page }) => {
  const code = `indicator('Shapes e2e', { overlay: false })
plot(close, { title: 'Close', color: '#787b86' })
const every = close.map((_, i) => i % 10 === 0)
plotshape(every, { title: 'Top', location: 'top', shape: 'diamond', color: '#ff00ff' })
plotshape(every, { title: 'Bottom', location: 'bottom', shape: 'diamond', color: '#00ff00' })`;
  const r = await page.evaluate(async (code) => {
    const res = await fetch('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Shapes e2e', code }) });
    return (await res.json()).script;
  }, code);
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.view.length > 50);
  await page.evaluate((id) => __app.addIndicator('custom', { script_id: id }), r.id);
  await page.waitForFunction(() => __app.ind.items.some(i => i.res.name === 'Shapes e2e' && i.res.shapes?.length === 2 && i.pane != null), null, { timeout: 30_000 });
  await page.mouse.move(5, 5);
  // color of the pane canvases at media point (x, y); y < 0 counts from the pane bottom
  const probe = (i) => page.evaluate((i) => {
    const it = __app.ind.items.find(x => x.res.name === 'Shapes e2e');
    const pane = __app.chart.panes()[it.pane].getHTMLElement();
    const x = __app.chart.timeScale().logicalToCoordinate(i);
    const h = __app.chart.panes()[it.pane].getHeight();
    const at = (y) => {
      for (const c of pane.querySelectorAll('canvas')) {
        const k = c.width / c.clientWidth, d = c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
        if (d[3] > 200 && (d[0] > 200 || d[1] > 200)) return `${d[0] > 200 ? 'r' : ''}${d[1] > 200 ? 'g' : ''}${d[2] > 200 ? 'b' : ''}`;
      }
      return null;
    };
    return { top: at(4 + 4.5), bottom: at(h - 4 - 4.5) };
  }, i);
  // a marked bar in the visible range, away from the edges
  const markedBar = () => page.evaluate(() => {
    const r = __app.chart.timeScale().getVisibleLogicalRange();
    const it = __app.ind.items.find(x => x.res.name === 'Shapes e2e');
    const off = __app.S.view.length - it.res.shapes[0].data.length;
    for (let i = Math.ceil(r.to) - 15; i > r.from + 5; i--) if (it.res.shapes[0].data[i - off]) return i;
    return null;
  });
  const i = await markedBar();
  expect(i).not.toBeNull();
  await expect.poll(() => probe(i)).toEqual({ top: 'rb', bottom: 'g' }); // magenta at the top, green at the bottom
  // scroll: the bar moves horizontally, the shapes stay at the pane edges
  await page.evaluate(() => { const ts = __app.chart.timeScale(); ts.scrollToPosition(ts.scrollPosition() - 3, false); });
  await page.waitForTimeout(300);
  await expect.poll(() => probe(i)).toEqual({ top: 'rb', bottom: 'g' });
  await page.evaluate((id) => fetch('/api/scripts/' + id, { method: 'DELETE' }), r.id);
  await resetLayout(page);
});

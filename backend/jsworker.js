// Indicator worker for server-side alert evaluation. One JSON request per stdin line, one JSON
// response per stdout line. Uses the exact same JS as the browser.
//
// Isolation layers for user code (custom indicators):
//  1. The whole indicator runtime is evaluated *inside* a fresh vm context per request; only strings
//     cross the boundary, so no host-realm object (and thus no host Function/process) is reachable.
//  2. vm timeout + microtaskMode 'afterEvaluate' bound sync loops and promise loops; wasm disabled.
//  3. The process runs with Node's permission model (fs read limited to code, no fs write, no child
//     processes, no worker threads; from Node 25 no network either) and an empty environment.
//  4. In Docker it runs in its own container without any network, read-only, as nobody, started per
//     connection by jsgate.js. Locally (jsrunner.py) it runs as nobody, in an empty network
//     namespace when possible, with a memory cap.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { INDICATORS } from '../static/js/indicators.js';

const TIMEOUT_MS = 3000;
const here = path.dirname(fileURLToPath(import.meta.url));

// Classic-script bundle of indicators.js + script.js (imports/exports stripped)
function toClassic(src) {
  return src.replace(/^import .*$/gm, '').replace(/^export (?=(async )?function|const|let|class)/gm, '');
}
const bundleSrc =
  toClassic(fs.readFileSync(path.join(here, '../static/js/indicators.js'), 'utf8')) + '\n' +
  toClassic(fs.readFileSync(path.join(here, '../static/js/script.js'), 'utf8')) + '\n' +
  `globalThis.__run = function (code, barsJson, inputsJson, envJson) {
     const r = runScript(code, JSON.parse(barsJson), JSON.parse(inputsJson), undefined, JSON.parse(envJson));
     return JSON.stringify(r);
   };`;
const bundle = new vm.Script(bundleSrc, { filename: 'chartscript-runtime.js' });

function runCustom(code, bars, params, env) {
  const ctx = vm.createContext({}, {
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  bundle.runInContext(ctx, { timeout: TIMEOUT_MS });
  ctx.__code = String(code);
  ctx.__bars = JSON.stringify(bars);
  ctx.__inputs = JSON.stringify(params || {});
  ctx.__env = JSON.stringify(env || {});
  const out = vm.runInContext('__run(__code, __bars, __inputs, __env)', ctx, { timeout: TIMEOUT_MS, filename: 'custom.js' });
  if (typeof out !== 'string') throw new Error('invalid script result');
  return JSON.parse(out);
}

function handle(req) {
  const tz = req.tz || 0;
  const bars = req.bars.map(r => ({ time: r[0] + tz, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  if (req.kind === 'custom') {
    const env = req.env || {};
    for (const [tf, rows] of Object.entries(env.htf || {})) {
      env.htf[tf] = rows.map(r => ({ time: r[0] + tz, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    }
    const res = runCustom(req.code, bars, req.params, env);
    if (res.requests && res.requests.length) return { requests: res.requests, plots: {}, shapes: [] };
    const plots = {};
    for (const p of res.plots) plots[p.k] = p.data;
    for (const s of res.shapes) plots[s.k] = s.data.map(v => (v ? 1 : 0));
    return { plots, shapes: res.shapes.map(s => s.k), meta: res.meta };
  }
  const def = INDICATORS[req.type];
  if (!def) throw new Error('unknown indicator ' + req.type);
  const params = {};
  for (const p of def.params) params[p.k] = req.params?.[p.k] ?? p.d;
  const plots = def.calc(bars, params);
  delete plots._up;
  return { plots, shapes: [] };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let id = null;
  try {
    const req = JSON.parse(line);
    id = req.id;
    process.stdout.write(JSON.stringify({ id, ok: true, ...handle(req) }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String((e && e.message) || e).slice(0, 500) }) + '\n');
  }
});

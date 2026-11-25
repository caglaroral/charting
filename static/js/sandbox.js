// Browser sandbox for user-written indicator code.
//
//   parent page ──(control: init / reset / worker errors)──▶ <iframe sandbox="allow-scripts">
//        │                                                     (opaque origin: no cookies, no API,
//        │                                                      no DOM of the app; CSP default-src
//        │                                                      'none' → no network)
//        │                                                        └─ creates the Web Worker
//        └────────── MessageChannel (runs and results) ─────────────▶ Web Worker
//
// The worker is created by the sandboxed iframe, so it inherits the iframe's opaque origin and CSP.
// Data does not pass through the iframe: a MessageChannel port is handed to the worker and runs and
// results travel directly between the page and the worker.
//
// The worker keeps the bars it has seen. The page sends only what changed (the live last bar, older
// history prepended on scroll) as columnar Float64Arrays that are transferred, not copied.
// Higher-timeframe bars for security() are cached the same way, per timeframe.

const TIMEOUT_MS = 3000;
const COLS = ['time', 'open', 'high', 'low', 'close', 'volume'];

const WORKER_MAIN = `
let port = null, bars = [], htf = {};
const COLS = ${JSON.stringify(COLS)};
function rows(c) {
  const n = c.time.length, out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { time: c.time[i], open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i], volume: c.volume[i] };
  return out;
}
function onRun(e) {
  const d = e.data;
  try {
    if (d.bars) {
      const b = d.bars;
      bars = (b.pre ? rows(b.pre) : []).concat(bars.slice(b.from, b.from + b.keep), b.tail ? rows(b.tail) : []);
    }
    for (const tf in (d.htf || {})) htf[tf] = rows(d.htf[tf]);
    const env = Object.assign({}, d.env, { htf: {} });
    for (const tf of d.useHtf || []) if (htf[tf]) env.htf[tf] = htf[tf];
    port.postMessage({ id: d.id, ok: true, result: runScript(d.code, bars, d.inputs, undefined, env) });
  } catch (err) {
    const m = /<anonymous>:(\\d+):(\\d+)/.exec(String(err && err.stack || ''));
    port.postMessage({ id: d.id, ok: false, error: String(err && err.message || err), line: m ? Number(m[1]) - 3 : null });
  }
}
self.onmessage = (e) => {
  if (e.data && e.data.type === 'port') { port = e.ports[0]; port.onmessage = onRun; }
};
`;

const FRAME_HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; worker-src blob: data:">
</head><body><script>
let runtime = null, worker = null;
function makeWorker(port) {
  if (worker) worker.terminate();
  const src = runtime + "\\n" + ${JSON.stringify(WORKER_MAIN)};
  try { worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
  catch (e) { worker = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)); }
  worker.onerror = (e) => { e.preventDefault(); parent.postMessage({ type: 'werror', error: e.message || 'Worker error' }, '*'); };
  worker.postMessage({ type: 'port' }, [port]);
}
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const d = e.data || {};
  if (d.type === 'init') { runtime = String(d.runtime); makeWorker(e.ports[0]); }
  else if (d.type === 'reset' && runtime) makeWorker(e.ports[0]); // after a timeout: fresh worker, new port
});
parent.postMessage({ type: 'ready' }, '*');
<\/script></body></html>`;

function toClassic(src) {
  return src.replace(/^import .*$/gm, '').replace(/^export (?=(async )?function|const|let|class)/gm, '');
}

/** Bars -> columnar Float64Arrays (transferable). */
function pack(list) {
  const n = list.length, c = {};
  for (const k of COLS) c[k] = new Float64Array(n);
  for (let i = 0; i < n; i++) { const b = list[i]; c.time[i] = b.time; c.open[i] = b.open; c.high[i] = b.high; c.low[i] = b.low; c.close[i] = b.close; c.volume[i] = b.volume; }
  return c;
}
const buffers = (c) => COLS.map(k => c[k].buffer);

export class ScriptSandbox {
  constructor() {
    this.queue = [];
    this.current = null;
    this.seq = 0;
    this.stats = { runs: 0, fullSends: 0, deltaSends: 0, barsSent: 0, htfSends: 0 };
    this.ready = this._init();
  }

  async _init() {
    const [ind, scr] = await Promise.all([
      fetch('/js/indicators.js').then(r => r.text()),
      fetch('/js/script.js').then(r => r.text()),
    ]);
    this.runtime = toClassic(ind) + '\n' + toClassic(scr);
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.style.display = 'none';
    this.frame.title = 'script-sandbox';
    const loaded = new Promise(resolve => { this._onReady = resolve; });
    window.addEventListener('message', (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const d = e.data || {};
      if (d.type === 'ready') this._onReady();
      else if (d.type === 'werror' && this.current) this._finish({ id: this.current.id, ok: false, error: d.error });
    });
    this.frame.srcdoc = FRAME_HTML;
    document.body.appendChild(this.frame);
    await loaded;
    this._connect('init');
  }

  // New channel (and, on 'reset', a new worker): the worker starts with no cached bars.
  _connect(type) {
    if (this.port) this.port.close();
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.onmessage = (e) => this._finish(e.data);
    this.sent = null;           // bar objects the worker holds, in order
    this.sentHtf = new Map();   // tf -> bars array reference the worker holds
    this.frame.contentWindow.postMessage(type === 'init' ? { type, runtime: this.runtime } : { type }, '*', [ch.port2]);
  }

  /**
   * Smallest update that turns the worker's bars into `view`: bars are the same objects as long as
   * they are unchanged, so identity comparison finds the kept middle part.
   */
  _barsDelta(view) {
    const sent = this.sent;
    let msg;
    if (!sent || !sent.length || !view.length) msg = { pre: null, from: 0, keep: 0, tail: pack(view) };
    else {
      // index of the worker's first bar in the new view (older history prepended before it)
      let k = -1;
      const t = sent[0].time;
      let lo = 0, hi = view.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (view[m].time < t) lo = m + 1; else hi = m; }
      if (view[lo] === sent[0]) k = lo;
      if (k < 0) msg = { pre: null, from: 0, keep: 0, tail: pack(view) };
      else {
        let m = 0;
        const lim = Math.min(sent.length, view.length - k);
        while (m < lim && view[k + m] === sent[m]) m++;
        if (k === 0 && m === sent.length && view.length === sent.length) msg = null; // unchanged
        else msg = { pre: k ? pack(view.slice(0, k)) : null, from: 0, keep: m, tail: k + m < view.length ? pack(view.slice(k + m)) : null };
      }
    }
    this.sent = view.slice();
    if (msg) {
      const full = !msg.keep;
      this.stats[full ? 'fullSends' : 'deltaSends']++;
      this.stats.barsSent += (msg.pre ? msg.pre.time.length : 0) + (msg.tail ? msg.tail.time.length : 0);
    }
    return msg;
  }

  _next() {
    if (this.current || !this.queue.length) return;
    const job = this.current = this.queue.shift();
    const transfer = [];
    const bars = this._barsDelta(job.bars);
    if (bars) { if (bars.pre) transfer.push(...buffers(bars.pre)); if (bars.tail) transfer.push(...buffers(bars.tail)); }
    const htf = {}, useHtf = Object.keys(job.env.htf || {});
    for (const tf of useHtf) {
      const ref = job.env.htf[tf];
      if (this.sentHtf.get(tf) !== ref) { htf[tf] = pack(ref); transfer.push(...buffers(htf[tf])); this.sentHtf.set(tf, ref); this.stats.htfSends++; }
    }
    const env = { ...job.env };
    delete env.htf;
    this.stats.runs++;
    job.timer = setTimeout(() => {
      // endless loop: replace the worker; its cached bars are gone, the next run sends everything
      this._connect('reset');
      this._finish({ id: job.id, ok: false, error: `Timeout: script did not finish within ${TIMEOUT_MS} ms (infinite loop?)` });
    }, TIMEOUT_MS);
    this.port.postMessage({ id: job.id, code: job.code, inputs: job.inputs, env, bars, htf, useHtf }, transfer);
  }

  _finish(d) {
    const job = this.current;
    if (!job || !d || d.id !== job.id) return;
    clearTimeout(job.timer);
    this.current = null;
    if (d.ok) job.resolve(d.result);
    else { const err = new Error(d.error); err.line = d.line; job.reject(err); }
    this._next();
  }

  // bars: [{time, open, high, low, close, volume}] -> {meta, inputs, plots, hlines, shapes, fills, requests}
  async run(code, bars, inputs = {}, env = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, code, bars, inputs, env, resolve, reject });
      this._next();
    });
  }
}

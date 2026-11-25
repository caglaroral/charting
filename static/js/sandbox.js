// Browser sandbox for user-written indicator code.
//
//   parent page ──postMessage──▶ <iframe sandbox="allow-scripts"> (opaque origin: no cookies, no API,
//                                 no DOM of the app; CSP default-src 'none' → no network)
//                                   └─▶ Web Worker (separate thread, terminated on timeout)
//
// Only plain data (bars, code text, results) crosses each boundary.

const TIMEOUT_MS = 3000;

const FRAME_HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; worker-src blob: data:">
</head><body><script>
let runtime = null, worker = null, current = null;
const queue = [];
function makeWorker() {
  const src = runtime + "\\n" + "self.onmessage = function (e) {\\n" +
    "  const d = e.data;\\n" +
    "  try { postMessage({ id: d.id, ok: true, result: runScript(d.code, d.bars, d.inputs, undefined, d.env || {}) }); }\\n" +
    "  catch (err) {\\n" +
    "    const m = /<anonymous>:(\\\\d+):(\\\\d+)/.exec(String(err && err.stack || ''));\\n" +
    "    postMessage({ id: d.id, ok: false, error: String(err && err.message || err), line: m ? Number(m[1]) - 3 : null });\\n" +
    "  }\\n" +
    "};";
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
  catch (e) { w = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)); }
  w.onmessage = (e) => finish(e.data);
  w.onerror = (e) => { e.preventDefault(); if (current) finish({ id: current.id, ok: false, error: e.message || 'Worker error' }); };
  return w;
}
function finish(msg) {
  if (!current || msg.id !== current.id) return;
  clearTimeout(current.timer);
  parent.postMessage({ type: 'result', ...msg }, '*');
  current = null;
  next();
}
function next() {
  if (current || !queue.length || !runtime) return;
  current = queue.shift();
  if (!worker) worker = makeWorker();
  current.timer = setTimeout(() => {
    worker.terminate(); worker = null;
    const id = current.id; current = null;
    parent.postMessage({ type: 'result', id, ok: false, error: 'Timeout: script did not finish within ${TIMEOUT_MS} ms (infinite loop?)' }, '*');
    next();
  }, ${TIMEOUT_MS});
  worker.postMessage({ id: current.id, code: current.code, bars: current.bars, inputs: current.inputs, env: current.env });
}
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const d = e.data || {};
  if (d.type === 'init') { runtime = String(d.runtime); if (worker) { worker.terminate(); worker = null; } next(); }
  else if (d.type === 'run') { queue.push(d); next(); }
});
parent.postMessage({ type: 'ready' }, '*');
<\/script></body></html>`;

function toClassic(src) {
  return src.replace(/^import .*$/gm, '').replace(/^export (?=(async )?function|const|let|class)/gm, '');
}

export class ScriptSandbox {
  constructor() {
    this.pending = new Map();
    this.seq = 0;
    this.ready = this._init();
  }

  async _init() {
    const [ind, scr] = await Promise.all([
      fetch('/js/indicators.js').then(r => r.text()),
      fetch('/js/script.js').then(r => r.text()),
    ]);
    const runtime = toClassic(ind) + '\n' + toClassic(scr);
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.style.display = 'none';
    this.frame.title = 'script-sandbox';
    const loaded = new Promise(resolve => {
      this._onReady = resolve;
    });
    window.addEventListener('message', (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const d = e.data || {};
      if (d.type === 'ready') { this._onReady(); return; }
      if (d.type === 'result') {
        const p = this.pending.get(d.id);
        if (!p) return;
        this.pending.delete(d.id);
        if (d.ok) p.resolve(d.result);
        else { const err = new Error(d.error); err.line = d.line; p.reject(err); }
      }
    });
    this.frame.srcdoc = FRAME_HTML;
    document.body.appendChild(this.frame);
    await loaded;
    this.frame.contentWindow.postMessage({ type: 'init', runtime }, '*');
  }

  // bars: [{time, open, high, low, close, volume}] -> {meta, inputs, plots, hlines, shapes}
  async run(code, bars, inputs = {}, env = {}) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.frame.contentWindow.postMessage({ type: 'run', id, code, bars, inputs, env }, '*');
    });
  }
}

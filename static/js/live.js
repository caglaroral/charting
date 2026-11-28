// Live market data straight from the exchange (browser side).
//   - one REST request per symbol/timeframe selection (exchange default limit)
//   - a kline websocket per open chart for realtime updates
//   - one all-market mini-ticker websocket for the watchlist
// Older history comes from ClickHouse (see app.js loadMore).

export const PROVIDERS = {
  'binance-futures': {
    name: 'Binance USDT-M Futures',
    rest: 'https://fapi.binance.com/fapi/v1/klines',
    // Market data streams live under /market (the legacy /ws path accepts connections but sends nothing)
    ws: 'wss://fstream.binance.com/market/stream',
  },
  'binance-spot': {
    name: 'Binance Spot',
    rest: 'https://api.binance.com/api/v3/klines',
    ws: 'wss://stream.binance.com:9443/stream',
  },
};

// app timeframe -> Binance interval
const INTERVAL = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '12h': '12h', '1D': '1d', '1W': '1w', '1M': '1M' };

const rowFromRest = (k) => [Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5]];

/** Single REST request; returns rows [t, o, h, l, c, v] ascending (exchange default limit). */
export async function restKlines(provider, symbol, tf, { endTime, limit } = {}) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({ symbol, interval: INTERVAL[tf] });
  if (endTime) q.set('endTime', String(endTime * 1000));
  if (limit) q.set('limit', String(limit));
  const r = await fetch(`${p.rest}?${q}`);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).msg || msg; } catch { /* */ }
    throw new Error(`${p.name}: ${msg}`);
  }
  return (await r.json()).map(rowFromRest);
}

class ReconnectingWS {
  constructor(url, onMessage, onState) {
    this.url = url; this.onMessage = onMessage; this.onState = onState;
    this.closed = false; this.retry = 0;
    this._open();
    // Watchdog: an open socket that stays silent is treated as dead and reconnected.
    this.lastMsg = Date.now();
    this.watch = setInterval(() => {
      if (!this.closed && this.ws && this.ws.readyState === 1 && Date.now() - this.lastMsg > 20000) {
        this.onState?.('stale');
        try { this.ws.close(); } catch { /* */ }
      }
    }, 5000);
  }
  _open() {
    if (this.closed) return;
    this.onState?.('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.lastMsg = Date.now(); this.onState?.('open'); };
    ws.onmessage = (e) => { this.lastMsg = Date.now(); try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
    ws.onclose = () => {
      if (this.closed) return;
      this.onState?.('closed');
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this._open(), delay);
    };
    ws.onerror = () => ws.close();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.watch);
    try { this.ws.close(); } catch { /* */ }
  }
}

// One multiplexed websocket per provider. Streams are added/removed with SUBSCRIBE/UNSUBSCRIBE
// on the combined-stream endpoint, so the page never holds more than one connection per exchange.
class Multiplexer {
  constructor(provider) {
    this.handlers = new Map(); // stream -> Set(fn)
    this.stateFns = new Set();
    this.reqId = 1;
    this.conn = new ReconnectingWS(PROVIDERS[provider].ws, (m) => {
      if (!m || !m.stream) return;
      const hs = this.handlers.get(m.stream);
      if (hs) for (const fn of hs) fn(m.data);
    }, (state) => {
      if (state === 'open') this._send('SUBSCRIBE', [...this.handlers.keys()]);
      for (const fn of this.stateFns) fn(state);
    });
  }
  _send(method, params) {
    if (!params.length || !this.conn.ws || this.conn.ws.readyState !== 1) return;
    this.conn.ws.send(JSON.stringify({ method, params, id: this.reqId++ }));
  }
  subscribe(stream, fn, onState) {
    const fresh = !this.handlers.has(stream);
    if (fresh) this.handlers.set(stream, new Set());
    this.handlers.get(stream).add(fn);
    if (onState) { this.stateFns.add(onState); if (this.conn.ws?.readyState === 1) onState('open'); }
    if (fresh) this._send('SUBSCRIBE', [stream]);
    return {
      close: () => {
        const hs = this.handlers.get(stream);
        if (!hs) return;
        hs.delete(fn);
        if (onState) this.stateFns.delete(onState);
        if (!hs.size) { this.handlers.delete(stream); this._send('UNSUBSCRIBE', [stream]); }
      },
    };
  }
}

const muxes = {};
const mux = (provider) => (muxes[provider] ||= new Multiplexer(provider));

/** Number of open exchange websocket connections (for diagnostics/tests). */
export const connectionCount = () => Object.values(muxes).filter(m => m.conn.ws && m.conn.ws.readyState <= 1).length;

/** Kline stream. onBar([t,o,h,l,c,v], closed) */
export function klineStream(provider, symbol, tf, onBar, onState) {
  return mux(provider).subscribe(`${symbol.toLowerCase()}@kline_${INTERVAL[tf]}`, (m) => {
    const k = m.k;
    if (!k) return;
    onBar([Math.floor(k.t / 1000), +k.o, +k.h, +k.l, +k.c, +k.v], !!k.x);
  }, onState);
}

/** All-market 24h mini tickers. onTickers({SYMBOL: {last, open, chg, chgp, vol, qvol}}) */
export function miniTickerStream(provider, onTickers) {
  return mux(provider).subscribe('!miniTicker@arr', (arr) => {
    if (!Array.isArray(arr)) return;
    const out = {};
    for (const t of arr) {
      const last = +t.c, open = +t.o;
      out[t.s] = { last, open, high: +t.h, low: +t.l, chg: last - open, chgp: open ? (last / open - 1) * 100 : 0, vol24: +t.v, qvol: +t.q, time: Math.floor(t.E / 1000) };
    }
    onTickers(out);
  });
}

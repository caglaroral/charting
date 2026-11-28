"""Backtester HTTP service (internal: only the backend calls it; no published port).

POST /screen    {source, tf, conds, columns, symbols?, regime?}            -> screener rows
POST /backtest  {source, strategy, symbols, start, end, size?}            -> trades and metrics per symbol
POST /paper     {source, strategy, symbols, state, start, size?}          -> paper-trading step
GET  /meta                                                                -> indicators, fields, timeframes
GET  /health

The engine keeps module-level caches, so requests are computed one at a time (a lock); the host has few cores
and the screener / paper engine work in short bursts.
"""
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from bt import market, screen, spec, tester

_compute = threading.Lock()
_sources = {}
MAX_SCREEN_SYMBOLS = 5000
MAX_BACKTEST_SECONDS = 240


def _source(cfg):
    if not isinstance(cfg, dict) or not cfg.get('url') or not cfg.get('cols'):
        raise spec.SpecError('source is required')
    s = market.Source(cfg)
    return _sources.setdefault(s.key, s)


def _time(v, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v < 4_102_444_800:
        raise spec.SpecError(f'{what}: invalid time')
    return int(v)


def handle(path, body):
    if path == '/screen':
        src = _source(body.get('source'))
        tf = spec.tf(body.get('tf'))
        conds = spec.conds(body.get('conds') or [])
        cols = spec.columns(body.get('columns') or [])
        syms = spec.symbols(body.get('symbols'), MAX_SCREEN_SYMBOLS)
        return screen.run(src, tf, conds, cols, syms, regime=bool(body.get('regime', True)))
    if path == '/backtest':
        src = _source(body.get('source'))
        st = spec.strategy(body.get('strategy'))
        syms = spec.symbols(body.get('symbols') or [], int(body.get('max_symbols') or 50))
        if not syms:
            raise spec.SpecError('choose at least one symbol')
        a, b = _time(body.get('start'), 'start'), _time(body.get('end'), 'end')
        if b <= a:
            raise spec.SpecError('the end must be after the start')
        size = float(body.get('size') or 1000)
        return tester.backtest(src, st, syms, a, b, size, deadline=time.time() + MAX_BACKTEST_SECONDS)
    if path == '/paper':
        src = _source(body.get('source'))
        st = spec.strategy(body.get('strategy'))
        syms = spec.symbols(body.get('symbols') or [], MAX_SCREEN_SYMBOLS)
        state = {}
        for k, v in (body.get('state') or {}).items():
            if isinstance(v, list) and len(v) == 2 and all(x is None or isinstance(x, (int, float)) for x in v):
                state[str(k)] = [None if x is None else int(x) for x in v]
        return {'symbols': tester.paper_step(src, st, syms, state, _time(body.get('start'), 'start'),
                                             float(body.get('size') or 1000))}
    if path == '/validate':
        out = {}
        if 'strategy' in body:
            out['strategy'] = spec.strategy(body['strategy'])
        if 'conds' in body:
            out['conds'] = spec.conds(body['conds'])
        if 'columns' in body:
            out['columns'] = spec.columns(body['columns'])
        if 'tf' in body:
            spec.tf(body['tf'])
        return out
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, obj):
        b = json.dumps(obj, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'ok': True})
        if self.path == '/meta':
            return self._send(200, spec.meta())
        self._send(404, {'error': 'Not found'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 2_000_000:
                return self._send(413, {'error': 'Request too large'})
            body = json.loads(self.rfile.read(n) or b'{}')
            with _compute:
                res = handle(self.path, body)
            if res is None:
                return self._send(404, {'error': 'Not found'})
            self._send(200, res)
        except (spec.SpecError, ValueError) as e:
            self._send(400, {'error': str(e)})
        except market.CHError as e:
            self._send(502, {'error': f'Data error: {e}'})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {'error': f'{type(e).__name__}: {e}'})


def main():
    host, port = os.environ.get('HOST', '0.0.0.0'), int(os.environ.get('PORT', 8090))
    print(f'backtester on {host}:{port}', flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__':
    main()

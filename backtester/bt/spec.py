"""Validation of screener conditions and strategies, and the app <-> engine timeframe names.

Everything that reaches the engine passes through here: a request can only name known indicators, fields,
timeframes and bounded numbers (no expressions, no code).
"""
import math

from backtestengine import indicators

# app timeframe -> engine timeframe (1M is not supported: months are not a fixed length)
APP_TO_ENGINE = {'1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h',
                 '12h': '12h', '1D': '1d', '1W': '1w'}
ENGINE_TO_APP = {v: k for k, v in APP_TO_ENGINE.items()}
PRICES = ('open', 'high', 'low', 'close', 'volume')
OPS = ('<', '>', 'xup', 'xdn')
MAX_CONDS = 12
MAX_COLUMNS = 12
MAX_SHIFT = 50


class SpecError(ValueError):
    pass


def tf(v, what='timeframe'):
    if v not in APP_TO_ENGINE:
        raise SpecError(f'{what}: unsupported timeframe {v!r}')
    return APP_TO_ENGINE[v]


def _num(v, what, lo=-1e12, hi=1e12):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise SpecError(f'{what}: {v!r} is not a number in [{lo}, {hi}]')
    return v


def operand(o):
    """App operand -> engine operand. App: {ind, p, f, tf, sh} | {px, tf?, sh} | {const}. tf: app timeframe or None."""
    if not isinstance(o, dict):
        raise SpecError('operand must be an object')
    if 'const' in o:
        return {'const': float(_num(o['const'], 'value'))}
    sh = int(_num(o.get('sh', 0) or 0, 'shift', 0, MAX_SHIFT))
    otf = tf(o['tf'], 'operand timeframe') if o.get('tf') else None
    if 'px' in o:
        if o['px'] not in PRICES:
            raise SpecError(f'unknown price field {o["px"]!r}')
        if otf:   # a price on another timeframe is the engine's 'price' indicator with the field
            return {'ind': 'price', 'p': [], 'f': o['px'], 'tf': otf, 'sh': sh}
        return {'px': o['px'], 'sh': sh}
    name = o.get('ind')
    if name not in indicators.DEFAULTS or name == 'price':
        raise SpecError(f'unknown indicator {name!r}')
    fields = indicators.FIELDS.get(name)
    f = o.get('f') or None
    if fields:
        if f not in fields:
            raise SpecError(f'{name}: field must be one of {", ".join(fields)}')
    elif f:
        raise SpecError(f'{name} has no fields')
    p = list(o.get('p') or [])
    d = indicators.DEFAULTS[name]
    if len(p) > len(d):
        raise SpecError(f'{name}: at most {len(d)} parameters')
    out = []
    for i, v in enumerate(p):
        if isinstance(d[i], str):
            if v not in indicators.SOURCES:
                raise SpecError(f'{name}: source must be one of {", ".join(indicators.SOURCES)}')
            out.append(v)
        elif isinstance(d[i], float) or (isinstance(v, float) and not float(v).is_integer()):
            out.append(float(_num(v, f'{name} parameter', 0, 1000)))
        else:
            out.append(int(_num(v, f'{name} parameter', 1, 1000)))
    try:
        indicators.params_of(name, out)
    except ValueError as e:
        raise SpecError(str(e)) from None
    return {'ind': name, 'p': out, 'f': f, 'tf': otf, 'sh': sh}


def cond(c):
    if not isinstance(c, dict) or c.get('op') not in OPS:
        raise SpecError(f'condition operator must be one of {", ".join(OPS)}')
    a, b = operand(c.get('a')), operand(c.get('b'))
    if 'const' in a:
        raise SpecError('the left side of a condition cannot be a plain number')
    return {'op': c['op'], 'a': a, 'b': b}


def conds(lst, what='conditions', min_n=0):
    if not isinstance(lst, list) or not min_n <= len(lst) <= MAX_CONDS:
        raise SpecError(f'{what}: {min_n} to {MAX_CONDS} conditions')
    return [cond(c) for c in lst]


def columns(lst):
    if not isinstance(lst, list) or len(lst) > MAX_COLUMNS:
        raise SpecError(f'columns: at most {MAX_COLUMNS}')
    out = [operand(o) for o in lst]
    if any('const' in o for o in out):
        raise SpecError('a column cannot be a plain number')
    return out


def _exit(e, what):
    if e is None:
        return None
    if not isinstance(e, dict):
        raise SpecError(f'{what}: invalid')
    if e.get('k') == 'pct':
        return {'k': 'pct', 'v': float(_num(e.get('v'), f'{what} %', 0.0001, 0.99))}
    if e.get('k') == 'atr':
        out = {'k': 'atr', 'm': float(_num(e.get('m'), f'{what} ATR multiple', 0.01, 50)),
               'p': int(_num(e.get('p', 14), f'{what} ATR period', 1, 500))}
        return out
    raise SpecError(f'{what}: kind must be pct or atr')


def strategy(s):
    """App strategy {tf, long: {entry, stop, tp} | null, short: ...} -> engine strategy."""
    if not isinstance(s, dict):
        raise SpecError('strategy must be an object')
    out = {'tf': tf(s.get('tf'), 'strategy timeframe'), 'long': None, 'short': None}
    for side in ('long', 'short'):
        sd = s.get(side)
        if not sd:
            continue
        out[side] = {'entry': conds(sd.get('entry'), f'{side} entry', 1), 'stop': _exit(sd.get('stop'), f'{side} stop'),
                     'tp': _exit(sd.get('tp'), f'{side} take-profit')}
        if not out[side]['stop'] and not out[side]['tp']:
            raise SpecError(f'{side}: set a stop or a take-profit (a position needs a way out)')
    if not out['long'] and not out['short']:
        raise SpecError('strategy: enable long or short')
    return out


def symbols(lst, max_n):
    if lst is None:
        return None
    if not isinstance(lst, list) or not all(isinstance(x, str) for x in lst):
        raise SpecError('symbols must be a list of names')
    out = list(dict.fromkeys(x.split(':')[-1].strip().upper() for x in lst if x.strip()))
    if len(out) > max_n:
        raise SpecError(f'at most {max_n} symbols')
    return out


def meta():
    """What the UI may offer: indicators with default parameters and fields, timeframes, operators."""
    return {'indicators': [{'name': k, 'defaults': list(v), 'fields': list(indicators.FIELDS.get(k, ()))}
                           for k, v in indicators.DEFAULTS.items() if k != 'price'],
            'timeframes': list(APP_TO_ENGINE), 'prices': list(PRICES), 'ops': list(OPS),
            'max_conds': MAX_CONDS, 'max_columns': MAX_COLUMNS}

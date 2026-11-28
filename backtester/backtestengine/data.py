"""
Kline data for the backtest engine.

The engine asks for candles with `load(symbol, tf)`. In this app the candles come from a provider set by the
caller for the current request (`use(provider)`), so the same engine code runs on:
  - the screener / paper-trading cache: the latest bars of every symbol of a data source (bt/market.py);
  - a backtest window: one symbol, the window plus warm-up, read from ClickHouse for that run.

Times are UTC epoch milliseconds (candle open time).
"""
import threading
from dataclasses import dataclass

import numpy as np

# Engine timeframe names. The app's 1D / 1W are 1d / 1w here (bt/spec.py maps them).
TF_MS = {'1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
         '2h': 7_200_000, '4h': 14_400_000, '12h': 43_200_000, '1d': 86_400_000, '1w': 604_800_000}


@dataclass
class Candles:
    symbol: str
    tf: str
    ts: np.ndarray       # int64 ms, open time
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray

    def __len__(self):
        return len(self.ts)

    def slice(self, a, b):
        return Candles(self.symbol, self.tf, *(x[a:b] for x in (self.ts, self.open, self.high, self.low, self.close, self.volume)))

    def segments(self):
        """[start, end) index ranges without a gap; each gap-free segment runs on its own."""
        if getattr(self, '_segs', None) is None:
            step = np.diff(self.ts)
            if self.tf == '1w':
                gap = step != TF_MS['1w']
            else:
                gap = step != TF_MS[self.tf]
            cut = np.where(gap)[0] + 1
            edges = np.r_[0, cut, len(self.ts)]
            self._segs = [(int(a), int(b)) for a, b in zip(edges[:-1], edges[1:])] if len(self.ts) else []
        return self._segs


def empty(symbol, tf):
    z = np.zeros(0)
    return Candles(symbol, tf, np.zeros(0, np.int64), z, z, z, z, z)


_local = threading.local()


def use(provider):
    """Set the candle provider of this thread: provider(symbol, tf) -> Candles. Clears the engine's caches, whose
    keys do not include the data they were computed on."""
    from . import strategy
    strategy.reset_caches()
    _local.provider = provider


def load(symbol, tf):
    """Candles of one symbol and timeframe from the current provider (symbol without '.P', e.g. 'XLMUSDT')."""
    p = getattr(_local, 'provider', None)
    if p is None:
        raise RuntimeError('no candle provider set (data.use)')
    if tf not in TF_MS:
        raise ValueError(f'timeframe {tf}: supported are {list(TF_MS)}')
    return p(symbol.replace('.P', ''), tf)

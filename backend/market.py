"""Market data (read-only) from the configured data sources. Symbols are 'PREFIX:SYMBOL'."""
import datetime as dt
import threading
import time

from . import ch, datasources, live

TIMEFRAMES = datasources.APP_TFS
MAX_LIMIT = 5000


class NotFound(Exception):
    pass


_sym_lock = threading.Lock()
_sym_cache = {"at": 0.0, "list": None, "set": set()}


def _source_symbols(src: datasources.Source) -> list[dict]:
    # Use the coarsest native table: fewest rows to scan.
    tf = max(src.tables, key=lambda t: TIMEFRAMES.get(t, 0))
    t, s = src.col("time"), src.col("symbol")
    rows = src.client.query(
        f"SELECT toString({s}) AS symbol, toUInt32(min({t})) AS first, toUInt32(max({t})) AS last "
        f"FROM {src.table(tf)} GROUP BY {s} ORDER BY {s}", timeout=60)
    return [{"symbol": f"{src.prefix}:{r['symbol']}", "name": r["symbol"], "source": src.prefix,
             "first": int(r["first"]), "last": int(r["last"])} for r in rows]


def symbols() -> list[dict]:
    """Union of ClickHouse history symbols and live exchange symbols per source.
    Each item: {symbol: PREFIX:SYM, name, source, live: bool, history: bool, first, last}."""
    with _sym_lock:
        if _sym_cache["list"] is None or time.time() - _sym_cache["at"] > 600:
            out = []
            for src in datasources.sources():
                hist = []
                if src.tables:
                    try:
                        hist = _source_symbols(src)
                    except ch.CHError as e:
                        print(f"symbols from {src.prefix} failed: {e}")
                live_syms = set(live.symbols(src.live)) if src.live else set()
                seen = set()
                for h in hist:
                    h["history"] = True
                    h["live"] = h["name"] in live_syms
                    seen.add(h["name"])
                    out.append(h)
                for name in sorted(live_syms - seen):
                    out.append({"symbol": f"{src.prefix}:{name}", "name": name, "source": src.prefix,
                                "first": 0, "last": 0, "history": False, "live": True})
            out.sort(key=lambda x: x["symbol"])
            _sym_cache.update(list=out, set={x["symbol"] for x in out}, at=time.time())
        return _sym_cache["list"]


def invalidate_symbols() -> None:
    with _sym_lock:
        _sym_cache["list"] = None


def known_symbol(key: str) -> bool:
    symbols()
    return key in _sym_cache["set"]


def _resolve(key: str):
    r = datasources.resolve(key)
    if not r:
        raise NotFound(f"Unknown symbol: {key}")
    return r


def recent_bars(key: str, tf: str, limit: int) -> list[list]:
    """Latest bars: from the live exchange when the source has one, else ClickHouse."""
    src, sym = _resolve(key)
    if src.live:
        return live.klines(src.live, sym, tf, limit=limit)
    return bars(key, tf, None, limit)


def bars(key: str, tf: str, to: int | None, limit: int) -> list[list]:
    """Up to `limit` bars strictly before `to` (unix seconds), ascending: [time, o, h, l, c, v]."""
    src, sym = _resolve(key)
    if tf not in src.plan:
        return []  # no ClickHouse history for this timeframe
    native, bucket, sec = src.plan[tf]
    table = src.table(native)
    T, S = src.col("time"), src.col("symbol")
    O, H, L, C, V = (src.col(k) for k in ("open", "high", "low", "close", "volume"))
    limit = max(1, min(limit, MAX_LIMIT))
    to = to or 4_102_444_800  # 2100-01-01
    params = {"s": sym, "to": to, "n": limit}
    if bucket is None:
        sql = (f"SELECT toUInt32({T}), {O}, {H}, {L}, {C}, {V} FROM {table} "
               f"WHERE {S} = {{s:String}} AND {T} < toDateTime({{to:UInt32}}) ORDER BY {T} DESC LIMIT {{n:UInt32}}")
    else:
        anchor = to
        if to >= 4_000_000_000:
            r = src.client.query_compact(f"SELECT toUInt32(max({T})) FROM {table} WHERE {S} = {{s:String}}", {"s": sym})
            anchor = (r[0][0] if r else 0) + 1
        # Bound the scan: limit bars back plus slack (buckets can be partial / have gaps).
        params["from"] = max(0, anchor - limit * sec * 2 - 31 * 86400)
        sql = (f"SELECT toUInt32(b), argMin({O}, {T}), max({H}), min({L}), argMax({C}, {T}), sum({V}) FROM {table} "
               f"WHERE {S} = {{s:String}} AND {T} < toDateTime({{to:UInt32}}) AND {T} >= toDateTime({{from:UInt32}}) "
               f"GROUP BY {bucket} AS b HAVING b < toDateTime({{to:UInt32}}) ORDER BY b DESC LIMIT {{n:UInt32}}")
    rows = src.client.query_compact(sql, params)
    rows.reverse()
    return rows


def quotes(keys: list[str]) -> dict:
    """Last price, 24h change and 24h volume per symbol (relative to each symbol's latest bar)."""
    by_src: dict = {}
    for k in keys:
        r = datasources.resolve(k)
        if r:
            by_src.setdefault(r[0].prefix, (r[0], []))[1].append(r[1])
    out = {}
    for prefix, (src, syms) in by_src.items():
        # Prefer the native table closest to 1h (and not above it) for a cheap 24h window.
        cands = sorted((TIMEFRAMES[t], t) for t in src.tables if TIMEFRAMES[t] <= 3600)
        if cands:
            sec, tf = cands[-1]
        else:
            sec, tf = min((TIMEFRAMES[t], t) for t in src.tables)
        per = max(2, int(86400 / sec) + 1)
        T, S, C, V = src.col("time"), src.col("symbol"), src.col("close"), src.col("volume")
        try:
            rows = src.client.query(
                f"SELECT toString({S}) AS symbol, groupArray(c) AS c, groupArray(v) AS v, groupArray(t) AS t FROM ("
                f"  SELECT {S}, toUInt32({T}) AS t, {C} AS c, {V} AS v FROM {src.table(tf)} "
                f"  WHERE {S} IN {{syms:Array(String)}} ORDER BY {S}, {T} DESC LIMIT {per} BY {S}"
                f") GROUP BY {S}", {"syms": syms})
        except ch.CHError as e:
            print(f"quotes {prefix}: {e}")
            continue
        for r in rows:
            c, t = r["c"], r["t"]
            last, last_t = c[0], t[0]
            # 24h change: from the close of the bar 24h before the latest bar
            idx = next((i for i in range(len(t)) if t[i] <= last_t - 86400), len(c) - 1)
            prev = c[idx]
            chg = last - prev
            vol24 = sum(v for v, tt in zip(r["v"], t) if tt > last_t - 86400)
            out[f"{prefix}:{r['symbol']}"] = {"last": last, "chg": chg, "chgp": (chg / prev * 100) if prev else 0,
                                              "vol24": vol24, "time": last_t}
    return out


def symbol_info(key: str) -> dict:
    src, sym = _resolve(key)
    rows = bars(key, "1D", None, MAX_LIMIT) if "1D" in src.plan else []
    if not rows:
        return {"symbol": key}
    times = [r[0] for r in rows]
    closes = [r[4] for r in rows]
    vols = [r[5] for r in rows]
    last_t, last = times[-1], closes[-1]

    def close_at(ts):
        lo, hi, ans = 0, len(times) - 1, None
        while lo <= hi:
            mid = (lo + hi) // 2
            if times[mid] <= ts:
                ans, lo = mid, mid + 1
            else:
                hi = mid - 1
        return closes[ans] if ans is not None else closes[0]

    day = 86400
    ytd_start = int(dt.datetime(dt.datetime.fromtimestamp(last_t, dt.timezone.utc).year, 1, 1,
                                tzinfo=dt.timezone.utc).timestamp()) - day
    perf = {}
    for k, back in (("1W", 7), ("1M", 30), ("3M", 91), ("6M", 182), ("1Y", 365)):
        ref = close_at(last_t - back * day)
        perf[k] = (last / ref - 1) * 100 if ref else None
    ref = close_at(ytd_start)
    perf["YTD"] = (last / ref - 1) * 100 if ref else None
    perf["ALL"] = (last / closes[0] - 1) * 100 if closes[0] else None
    q = quotes([key]).get(key, {})
    highs = [r[2] for r in rows[-365:]]
    lows = [r[3] for r in rows[-365:]]
    return {
        "symbol": key, "name": sym, "source": src.prefix, "source_name": src.cfg["name"],
        "first": times[0], "last_time": q.get("time", last_t), "last": q.get("last", last),
        "chg": q.get("chg"), "chgp": q.get("chgp"), "vol24": q.get("vol24"),
        "avg_vol30": sum(vols[-30:]) / min(30, len(vols)),
        "high52": max(highs), "low52": min(lows), "perf": perf,
        "timeframes": list(src.plan.keys()),
    }

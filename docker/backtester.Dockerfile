# Backtester: Python backtest engine (numpy / numba / TA-Lib) for the screener and the strategy tester.
# Reached only by the backend on the internal compose network (no published port). Reads ClickHouse (SELECT only).
FROM python:3.13-slim

WORKDIR /app
COPY backtester/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backtester ./
RUN useradd -r -u 10001 bt && mkdir -p /cache && chown bt /cache
USER bt
ENV PYTHONUNBUFFERED=1 BT_CACHE=/cache NUMBA_CACHE_DIR=/cache/numba PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)" || exit 1
CMD ["python3", "server.py"]

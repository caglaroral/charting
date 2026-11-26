# Backend: Python API + alert engine. Indicator code runs in the separate "jsworker" container.
FROM python:3.15.2-slim

WORKDIR /app
COPY package.json server.py ./
COPY backend ./backend
COPY sql ./sql
# mount point of the shared socket volume (owned by the worker's user, nobody)
RUN mkdir -p /run/jsrun && chown 65534:65534 /run/jsrun

ENV HOST=0.0.0.0 PORT=8080 PYTHONUNBUFFERED=1 JSRUN_SOCKET=/run/jsrun/jsrun.sock
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python3 -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8080/api/auth/config', timeout=4)" || exit 1
CMD ["python3", "server.py"]

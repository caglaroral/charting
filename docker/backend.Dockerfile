# Backend: Python API + alert engine + sandboxed Node indicator worker
FROM python:3.13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.py ./
COPY backend ./backend
COPY sql ./sql
# The indicator worker imports the same JS the browser uses
COPY static/js ./static/js

ENV HOST=0.0.0.0 PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python3 -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8080/api/auth/config', timeout=4)" || exit 1
CMD ["python3", "server.py"]

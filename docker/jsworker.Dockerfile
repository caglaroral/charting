# Indicator worker for server-side alerts: runs user-written indicator code.
# Started with network_mode: none, read-only root, no capabilities, as nobody (see docker-compose.yml).
# Reached by the backend only through a Unix socket on the shared "jsrun" volume.
FROM node:26.13.1-slim

WORKDIR /app
COPY package.json ./
COPY backend/jsworker.js backend/jsgate.js ./backend/
# the same JS the browser uses
COPY static/js ./static/js
RUN mkdir -p /run/jsrun && chown 65534:65534 /run/jsrun

ENV JSRUN_SOCKET=/run/jsrun/jsrun.sock
USER 65534:65534
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["node", "-e", "require('net').connect(process.env.JSRUN_SOCKET).on('connect', function () { this.destroy(); process.exit(0) }).on('error', () => process.exit(1))"]
CMD ["node", "backend/jsgate.js"]

// Gate for the indicator worker when it runs in its own container (docker-compose service "jsworker").
//
// The container has no network at all (network_mode: none). The backend reaches it through a Unix
// socket on a shared volume. Every connection gets a fresh, restricted jsworker.js child process with
// the same JSON-lines protocol as the local mode of backend/jsrunner.py; closing the connection kills
// the child. The backend closes the connection after a timeout, so a hung script is killed with it.
// This gate never runs user code itself.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOCKET = process.env.JSRUN_SOCKET || '/run/jsrun/jsrun.sock';
const MAX_CONN = 4;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = [
  '--permission', '--no-warnings', // Node >= 25: also blocks network (no --allow-net)
  `--allow-fs-read=${root}/static/js/*`, `--allow-fs-read=${root}/backend/jsworker.js`,
  `--allow-fs-read=${root}/package.json`, `--allow-fs-read=${root}/backend/package.json`,
  `--allow-fs-read=${root}/static/package.json`, `--allow-fs-read=${root}/static/js/package.json`,
  '--max-old-space-size=256', `${root}/backend/jsworker.js`,
];

let open = 0;
const server = net.createServer((conn) => {
  if (open >= MAX_CONN) { conn.destroy(); return; }
  open++;
  // empty environment, nothing inherited from the gate
  const child = spawn(process.execPath, args, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    open--;
    child.kill('SIGKILL');
    conn.destroy();
  };
  conn.pipe(child.stdin);
  child.stdout.pipe(conn);
  conn.on('close', close);
  conn.on('error', close);
  child.on('exit', close);
  child.on('error', close);
  child.stdin.on('error', close);
});

try { fs.unlinkSync(SOCKET); } catch { /* not there */ }
server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o660);
  console.log(`jsgate: listening on ${SOCKET}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });

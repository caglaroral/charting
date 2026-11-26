"""Runs indicator calculations in a long-lived, sandboxed Node worker (backend/jsworker.js) so alerts
use the exact same JavaScript as the browser, including user-written custom indicators.

Two modes:
  - JSRUN_SOCKET set (Docker): the worker runs in its own container without any network
    (docker-compose service "jsworker", backend/jsgate.js). We talk to it over a Unix socket on a
    shared volume; every connection is a fresh worker process, closing it kills the process.
  - otherwise: a local child process, sandboxed as below.

Local sandbox (outermost first, each applied when available):
  - unshare --net         : empty network namespace (no network at all)       [needs root]
  - setpriv nobody         : unprivileged uid/gid, no supplementary groups     [needs root]
  - prlimit                : address-space and CPU-time limits
  - node --permission      : fs read only for code files, no fs write / child_process / workers,
                             and from Node 25 no network either
  - vm context per request : see jsworker.js
The worker gets an empty environment (no secrets), so an escape cannot read credentials.
Every request has a wall-clock deadline; a hung or crashed worker is killed and restarted.
"""
import json
import os
import select
import shutil
import socket
import subprocess
import threading
import time

from . import config

REQUEST_TIMEOUT = 10.0
SOCKET = os.environ.get("JSRUN_SOCKET", "").strip()
_lock = threading.Lock()
_proc = None  # subprocess.Popen (local mode) or _SockWorker (socket mode)
_seq = 0


class _SockWorker:
    """Connection to the worker container; same interface as the Popen object as far as used here."""

    def __init__(self, path: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect(path)
        self.sock.settimeout(None)
        self.stdin = self.sock.makefile("w", encoding="utf-8", newline="\n")
        self.stdout = self.sock.makefile("r", encoding="utf-8", newline="\n")
        self._dead = False

    def poll(self):
        return 1 if self._dead else None

    def kill(self):
        self._dead = True
        for f in (self.stdin, self.stdout, self.sock):
            try:
                f.close()
            except Exception:
                pass

    def wait(self, timeout=None):
        return 0


class JSError(Exception):
    pass


_probe: dict = {}


def _works(cmd: list[str]) -> bool:
    """True if a sandbox wrapper is usable here (e.g. unshare needs CAP_SYS_ADMIN, absent in Docker)."""
    key = " ".join(cmd)
    if key not in _probe:
        try:
            _probe[key] = subprocess.run(cmd + ["true"], capture_output=True, timeout=5).returncode == 0
        except Exception:
            _probe[key] = False
        if not _probe[key]:
            print(f"jsrunner: sandbox layer unavailable, skipping: {cmd[0]}")
    return _probe[key]


def _permission_flag(node: str) -> str:
    """'--permission' (Node >= 23.5; from Node 25 it also blocks network access unless --allow-net),
    '--experimental-permission' on older versions."""
    if "perm" not in _probe:
        try:
            out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5).stdout
            major, minor = (int(x) for x in out.strip().lstrip("v").split(".")[:2])
            _probe["perm"] = "--permission" if (major, minor) >= (23, 5) else "--experimental-permission"
        except Exception:
            _probe["perm"] = "--experimental-permission"
    return _probe["perm"]


def _command() -> list[str]:
    node = shutil.which("node")
    if not node:
        raise JSError("node not found")
    root = str(config.ROOT)
    cmd = [node, _permission_flag(node), "--no-warnings",
           f"--allow-fs-read={root}/static/js/*", f"--allow-fs-read={root}/backend/jsworker.js",
           f"--allow-fs-read={root}/package.json", f"--allow-fs-read={root}/backend/package.json",
           f"--allow-fs-read={root}/static/package.json", f"--allow-fs-read={root}/static/js/package.json",
           "--max-old-space-size=256", f"{root}/backend/jsworker.js"]
    prlimit = shutil.which("prlimit")
    if prlimit:
        cmd = [prlimit, "--as=4294967296", "--nofile=64", "--"] + cmd
    if os.geteuid() == 0:
        setpriv, unshare = shutil.which("setpriv"), shutil.which("unshare")
        drop = [setpriv, "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--no-new-privs"] if setpriv else None
        if drop and _works(drop):
            cmd = drop + cmd
        if unshare and _works([unshare, "--net"]):
            cmd = [unshare, "--net"] + cmd
    return cmd


def _start():
    if SOCKET:
        return _SockWorker(SOCKET)
    # Empty environment: the worker must never see secrets (CH_PASSWORD, SECRET_KEY, ...) even if
    # user code escaped the vm context and could read process.env.
    env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")}
    return subprocess.Popen(_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1, cwd="/", env=env)


def _kill():
    global _proc
    if _proc is not None:
        try:
            _proc.kill()
            _proc.wait(timeout=2)
        except Exception:
            pass
    _proc = None


def _readline(proc, deadline: float) -> str:
    # One request -> one response line, so nothing is left buffered between requests and select()
    # on the underlying descriptor is enough.
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return ""
        r, _, _ = select.select([proc.stdout], [], [], remaining)
        if r:
            return proc.stdout.readline()


def compute(req: dict, bars: list[list]) -> dict:
    """req: {kind: 'builtin'|'custom', type?, code?, params, tz}. bars: [[t,o,h,l,c,v], ...]."""
    global _proc, _seq
    with _lock:
        for _attempt in (1, 2):
            if _proc is None or _proc.poll() is not None:
                try:
                    _proc = _start()
                except OSError as e:
                    _proc = None
                    raise JSError(f"Indicator worker unavailable: {e}") from e
            _seq += 1
            seq = _seq
            line = ""
            try:
                _proc.stdin.write(json.dumps({**req, "id": seq, "bars": bars}, separators=(",", ":")) + "\n")
                _proc.stdin.flush()
                line = _readline(_proc, time.monotonic() + REQUEST_TIMEOUT)
            except (BrokenPipeError, OSError):
                pass
            if line:
                res = json.loads(line)
                if res.get("id") != seq:
                    _kill()
                    continue
                if not res.get("ok"):
                    raise JSError(res.get("error", "error"))
                return res
            _kill()  # hung, crashed or OOM: restart and retry once
        raise JSError("Indicator computation failed (timeout or crash)")

"""Runs indicator calculations in a long-lived, sandboxed Node worker (backend/jsworker.js) so alerts
use the exact same JavaScript as the browser, including user-written custom indicators.

Sandbox (outermost first, each applied when available):
  - unshare --net         : empty network namespace (no network at all)       [needs root]
  - setpriv nobody         : unprivileged uid/gid, no supplementary groups     [needs root]
  - prlimit                : address-space and CPU-time limits
  - node --experimental-permission : fs read only for code files, no fs write / child_process / workers
  - vm context per request : see jsworker.js
Every request has a wall-clock deadline; a hung or crashed worker is killed and restarted.
"""
import json
import os
import select
import shutil
import subprocess
import threading
import time

from . import config

REQUEST_TIMEOUT = 10.0
_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_seq = 0


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


def _command() -> list[str]:
    node = shutil.which("node")
    if not node:
        raise JSError("node not found")
    root = str(config.ROOT)
    cmd = [node, "--experimental-permission", "--no-warnings",
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


def _start() -> subprocess.Popen:
    return subprocess.Popen(_command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1, cwd="/")


def _kill():
    global _proc
    if _proc is not None:
        try:
            _proc.kill()
            _proc.wait(timeout=2)
        except Exception:
            pass
    _proc = None


def _readline(proc: subprocess.Popen, deadline: float) -> str:
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
                _proc = _start()
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

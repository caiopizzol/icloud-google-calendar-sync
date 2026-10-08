#!/usr/bin/env python3
"""Run a private local sync under an OS lock, released even after a crash."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

if len(sys.argv) < 2:
    raise SystemExit('Usage: run-local.py <private-config.json> [--dry]')
config = Path(sys.argv[1]).expanduser().resolve(strict=True)
os.umask(0o077)
with open(config.parent / 'runner.lock', 'a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Another calendar sync is already running; skipped.')
        raise SystemExit(0)
    env = dict(os.environ, CALENDAR_SYNC_LOCKED='1')
    result = subprocess.run([os.environ.get('CALENDAR_SYNC_NODE', 'node'), str(Path(__file__).with_suffix('.mjs')), str(config), *sys.argv[2:]], env=env)
    raise SystemExit(result.returncode)

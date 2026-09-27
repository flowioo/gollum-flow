#!/usr/bin/env python3
"""Run all tests with per-test timeout, exit 0 only if all pass."""
import sys, os, signal, subprocess

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

passed = 0
failed = 0
timed_out = []

def alarm_handler(signum, frame):
    raise TimeoutError('test timeout')

for test_file in sorted(os.listdir(os.path.join(os.path.dirname(__file__), 'tests'))):
    if not test_file.startswith('test_'):
        continue
    path = os.path.join(os.path.dirname(__file__), 'tests', test_file)
    mod = {}
    with open(path) as f:
        exec(compile(f.read(), path, 'exec'), mod)
    for name, fn in mod.items():
        if name.startswith('test_') and callable(fn):
            try:
                # Per-test timeout (in case of infinite loop)
                signal.signal(signal.SIGALRM, alarm_handler)
                signal.alarm(2)  # 2 seconds
                fn()
                signal.alarm(0)
                print(f"  ✓ {test_file}::{name}")
                passed += 1
            except AssertionError as e:
                signal.alarm(0)
                print(f"  ✗ {test_file}::{name}: {e}")
                failed += 1
            except TimeoutError:
                signal.alarm(0)
                print(f"  ⏱ {test_file}::{name}: TIMEOUT (likely infinite loop)")
                timed_out.append(name)
                failed += 1

print(f"\n{passed} passed, {failed} failed, {len(timed_out)} timed out")
sys.exit(0 if failed == 0 else 1)
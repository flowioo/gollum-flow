#!/usr/bin/env bash
# Use the same isolated, assertion-based cross-process recovery scenario.
set -euo pipefail
cd "$(dirname "$0")/.."
node --import tsx tests/recovery-demo.mts

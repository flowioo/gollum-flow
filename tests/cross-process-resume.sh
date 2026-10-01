#!/bin/bash
# Cross-process Resume simulation test
#
# Proves Gollum's core proposition:
#   "Close the agent, restart it, it still knows what it's doing,
#    where it left off, and what to do next."
set -e
cd "$(dirname "$0")/.."

DB=/tmp/gollum-resume-test.db
rm -f /tmp/gollum-resume-test.db*

export GOLLUM_DB_PATH=$DB
export GOLLUM_MIGRATION_DIR=./src/workflow/store/migrations

echo "=== Process A: setup + claim (2s lease) + checkpoint + crash ==="
npx tsx tests/_process_a.ts 2>&1 | grep -v "npm warn"

echo ""
echo "Waiting 3s for lease to expire..."
sleep 3

echo ""
echo "=== Process B: scheduler tick on same DB ==="
npx tsx tests/_process_b.ts 2>&1 | grep -v "npm warn"

echo ""
echo "=== CROSS-PROCESS RESUME TEST DONE ==="
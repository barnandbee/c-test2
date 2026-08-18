#!/bin/bash
# Run every test. Starts a static server on a free port, runs the suites
# against it, and always cleans the server up.
#
#   tests/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8123}"
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

# Wait for it rather than guessing at a sleep.
for _ in $(seq 1 50); do
  if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then break; fi
  sleep 0.2
done

status=0
echo "── save codec ──────────────────────────────────────"
node tests/savecode.test.mjs || status=1
echo
echo "── browser ─────────────────────────────────────────"
node tests/browser.test.mjs "http://127.0.0.1:$PORT/index.html" || status=1
echo
[ $status -eq 0 ] && echo "✅ everything passed" || echo "‼️  something failed"
exit $status

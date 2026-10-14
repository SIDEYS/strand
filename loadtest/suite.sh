#!/usr/bin/env bash
# The full benchmark set, one scenario after another, each from freshly
# restarted instances. About 35 minutes. Needs the compose stack up
# (`docker compose up -d --build --wait`) and `npm run build`.
#
# Close other heavy applications first. run.mjs measures what else the machine
# is doing and refuses to start if it is busy (pass --allow-busy to override,
# in which case every report says the host was contended).
set -u
cd "$(dirname "$0")/.."

fresh() {
  docker compose unpause strand-2 >/dev/null 2>&1 || true
  docker compose restart strand-1 strand-2 strand-3 >/dev/null
  sleep 30
}

for scenario in "steady" "steady" "lb" "kill" "kill --failure freeze --restart-after 70" "rooms"; do
  echo "=== $scenario $(date +%H:%M:%S)"
  fresh
  node loadtest/run.mjs $scenario "$@" || { echo "stopped: run.mjs exited $?"; exit 1; }
done
echo "=== done $(date +%H:%M:%S); reports: node loadtest/report.mjs loadtest/results/<run>"

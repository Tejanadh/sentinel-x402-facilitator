#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Run: npm run bootstrap" >&2
  exit 1
fi

mkdir -p data
cleanup() {
  if [[ -n "${VANILLA_PID:-}" ]]; then kill "$VANILLA_PID" 2>/dev/null || true; fi
  if [[ -n "${SENTINEL_PID:-}" ]]; then kill "$SENTINEL_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

FACILITATOR_PORT=3001 ./node_modules/.bin/tsx demo/vanilla-facilitator.ts > data/contrast-vanilla.log 2>&1 &
VANILLA_PID=$!
FACILITATOR_PORT=3000 SENTINEL_DB=data/contrast.sqlite ./node_modules/.bin/tsx src/facilitator.ts > data/contrast-sentinel.log 2>&1 &
SENTINEL_PID=$!

wait_health() {
  local url="$1"
  for _ in $(seq 1 40); do
    if curl -sf "$url" >/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "timed out waiting for $url" >&2
  cat data/contrast-vanilla.log >&2 || true
  cat data/contrast-sentinel.log >&2 || true
  exit 1
}

wait_health "http://127.0.0.1:3001/health"
wait_health "http://127.0.0.1:3000/health"
VANILLA_URL=http://127.0.0.1:3001 SENTINEL_URL=http://127.0.0.1:3000 \
  ./node_modules/.bin/tsx demo/contrast-demo.ts

#!/usr/bin/env bash
# End-to-end Sentinel demo. No prompts. Exits non-zero on any failed check.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env. Run: npm run bootstrap" >&2
  exit 1
fi

mkdir -p data
rm -f data/demo-rows.jsonl

cleanup() {
  if [[ -n "${FAC_PID:-}" ]]; then kill "$FAC_PID" 2>/dev/null || true; fi
  if [[ -n "${RES_PID:-}" ]]; then kill "$RES_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

./node_modules/.bin/tsx src/facilitator.ts > data/facilitator.log 2>&1 &
FAC_PID=$!

wait_health() {
  local url="$1"
  for _ in $(seq 1 40); do
    if curl -sf "$url" >/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "timed out waiting for $url" >&2
  echo "----- facilitator log -----" >&2
  cat data/facilitator.log >&2 || true
  echo "----- resource log -----" >&2
  cat data/resource.log >&2 || true
  exit 1
}

wait_health "http://127.0.0.1:${FACILITATOR_PORT:-4020}/health"
./node_modules/.bin/tsx src/resource.ts > data/resource.log 2>&1 &
RES_PID=$!
wait_health "http://127.0.0.1:${RESOURCE_PORT:-4021}/health"

run_step() {
  local name="$1"
  shift
  echo "== $name =="
  ./node_modules/.bin/tsx "$@" | tee "data/${name}.log"
  grep '^SENTINEL_ROW ' "data/${name}.log" | sed 's/^SENTINEL_ROW //' >> data/demo-rows.jsonl
}

run_step poisoned demo/poisoned-agent.ts
run_step clean demo/clean-agent.ts
run_step replay demo/replay-agent.ts

node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";
const rows = readFileSync("data/demo-rows.jsonl", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(line => JSON.parse(line));
const expected = ["poisoned", "clean", "replay"];
if (rows.length !== 3 || rows.some((row, i) => row.scenario !== expected[i])) {
  console.error("demo rows missing", rows);
  process.exit(1);
}
console.log("");
console.log("| Scenario | Decision | Risk | HCS Log | Tx |");
console.log("| --- | --- | --- | --- | --- |");
for (const row of rows) {
  console.log(`| ${row.scenario} | ${row.decision} | ${row.risk} | ${row.hcs} | ${row.tx} |`);
}
EOF

TOPIC=$(grep '^HCS_TOPIC_ID=' .env | cut -d= -f2-)
python3 - <<PY
import base64, json, os, time, urllib.request
topic = open(".env").read().split("HCS_TOPIC_ID=",1)[1].splitlines()[0].strip()
url = f"https://testnet.mirrornode.hedera.com/api/v1/topics/{topic}/messages?limit=25&order=desc"
need = {"block", "approve", "replay-reject"}
found = set()
deadline = time.time() + 45
while time.time() < deadline and found != need:
    with urllib.request.urlopen(url, timeout=20) as res:
        body = json.load(res)
    for message in body.get("messages", []):
        raw = base64.b64decode(message["message"]).decode()
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if entry.get("decision") in need:
            found.add(entry["decision"])
            print(f"HCS {entry['decision']} seq={message['sequence_number']} paymentId={entry.get('paymentId','')[:12]} tx={entry.get('txHash') or '-'}")
    if found != need:
        time.sleep(3)
missing = need - found
if missing:
    raise SystemExit(f"mirror node missing decisions: {sorted(missing)}")
print("mirror node has block, approve, and replay-reject entries")
PY

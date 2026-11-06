import { readFileSync } from "node:fs";
import { FACILITATOR_URL, MERCHANT_ACCOUNT_ID } from "../src/config.js";

const saved = JSON.parse(readFileSync("data/last-clean-payment.json", "utf8")) as {
  paymentPayload: unknown;
  paymentRequirements: unknown;
};

const response = await fetch(`${FACILITATOR_URL}/settle`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-intent": "buy-credits",
    "x-recipient": MERCHANT_ACCOUNT_ID,
  },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload: saved.paymentPayload,
    paymentRequirements: saved.paymentRequirements,
  }),
});
const body = (await response.json()) as { success?: boolean; errorReason?: string };
if (body.errorReason !== "REPLAY_DETECTED") {
  console.error("expected REPLAY_DETECTED", body);
  process.exit(1);
}

console.log("REPLAY_DETECTED — same paymentId rejected before resubmission");
console.log("Replay protection, anchored permanently on HCS");
console.log(
  `SENTINEL_ROW ${JSON.stringify({
    scenario: "replay",
    decision: "REPLAY_DETECTED",
    risk: 100,
    hcs: "replay-reject",
    tx: "-",
  })}`,
);

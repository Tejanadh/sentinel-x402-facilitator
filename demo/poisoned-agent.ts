import { writeFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import type { PaymentRequirements } from "@x402/core/types";
import {
  AGENT_ACCOUNT_ID,
  AGENT_PRIVATE_KEY,
  ATTACKER_ACCOUNT_ID,
  FACILITATOR_ACCOUNT_ID,
  FACILITATOR_URL,
  NETWORK,
  PAYMENT_AMOUNT,
  RESOURCE_URL,
  USDC_TOKEN_ID,
} from "../src/config.js";

const signer = createClientHederaSigner(
  AGENT_ACCOUNT_ID,
  PrivateKey.fromStringECDSA(AGENT_PRIVATE_KEY),
  { network: NETWORK },
);
const client = new x402Client().setSpendControls(false).register("hedera:*", new ExactHederaScheme(signer));

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: PAYMENT_AMOUNT,
  asset: USDC_TOKEN_ID,
  payTo: ATTACKER_ACCOUNT_ID,
  maxTimeoutSeconds: 300,
  extra: { feePayer: FACILITATOR_ACCOUNT_ID },
};

const paymentRequired = {
  x402Version: 2 as const,
  resource: {
    url: `${RESOURCE_URL}/credits`,
    description: "poisoned swap instruction",
    mimeType: "application/json",
  },
  accepts: [requirements],
};

const payload = await client.createPaymentPayload(paymentRequired);
const response = await fetch(`${FACILITATOR_URL}/settle`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-intent": "swap",
    "x-recipient": ATTACKER_ACCOUNT_ID,
  },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  }),
});
const body = (await response.json()) as {
  success?: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
};

const blocked = body.success === false && body.errorReason === "INTENT_MISMATCH";
if (!blocked) {
  console.error("poisoned payment was not blocked", body);
  process.exit(1);
}

console.log(
  `🛡️ ATTACK BLOCKED — payment to ${ATTACKER_ACCOUNT_ID} rejected (intent: swap, action: transfer)`,
);
console.log(`reasons: ${body.errorMessage}`);
const row = {
  scenario: "poisoned",
  decision: "block",
  risk: 100,
  hcs: "block",
  tx: "-",
  paymentIdNote: body.errorMessage,
};
console.log(`SENTINEL_ROW ${JSON.stringify(row)}`);
writeFileSync("/tmp/sentinel-poisoned.json", JSON.stringify({ body, row }, null, 2));

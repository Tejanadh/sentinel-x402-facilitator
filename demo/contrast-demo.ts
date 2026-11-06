import { mkdirSync, writeFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  AGENT_ACCOUNT_ID,
  AGENT_PRIVATE_KEY,
  ATTACKER_ACCOUNT_ID,
  FACILITATOR_ACCOUNT_ID,
  MERCHANT_ACCOUNT_ID,
  NETWORK,
  PAYMENT_AMOUNT,
  USDC_TOKEN_ID,
} from "../src/config.js";

const sentinelUrl = process.env.SENTINEL_URL ?? "http://127.0.0.1:3000";
const vanillaUrl = process.env.VANILLA_URL ?? "http://127.0.0.1:3001";
const signer = createClientHederaSigner(
  AGENT_ACCOUNT_ID,
  PrivateKey.fromStringECDSA(AGENT_PRIVATE_KEY),
  { network: NETWORK },
);
const client = new x402Client().setSpendControls(false).register("hedera:*", new ExactHederaScheme(signer));

const poisonedRequirements = requirements(ATTACKER_ACCOUNT_ID);
const poisonedPayload = await createPayload(poisonedRequirements, "poisoned transfer to unknown address");
const sentinelPoisoned = await post(`${sentinelUrl}/verify`, {
  paymentPayload: poisonedPayload,
  paymentRequirements: poisonedRequirements,
  intent: "swap",
  recipient: ATTACKER_ACCOUNT_ID,
});
if (sentinelPoisoned.isValid !== false || !Array.isArray(sentinelPoisoned.profile?.results)) {
  throw new Error(`Sentinel did not return a blocked profile result: ${JSON.stringify(sentinelPoisoned)}`);
}
const profileResults = sentinelPoisoned.profile.results as Array<{
  passed: boolean;
  checkId: string;
  reason?: string;
}>;
for (const id of ["B1", "B2", "B3"]) {
  if (profileResults.find(result => result.checkId === id)?.passed !== false) {
    throw new Error(`Sentinel profile did not block ${id}`);
  }
}

const vanillaVerify = await post(`${vanillaUrl}/verify`, {
  paymentPayload: poisonedPayload,
  paymentRequirements: poisonedRequirements,
});
if (vanillaVerify.isValid !== true) {
  throw new Error(`Vanilla facilitator did not accept the protocol-valid payment: ${JSON.stringify(vanillaVerify)}`);
}
const vanillaSettle = await post(`${vanillaUrl}/settle`, {
  paymentPayload: poisonedPayload,
  paymentRequirements: poisonedRequirements,
});
if (vanillaSettle.success !== true || typeof vanillaSettle.transaction !== "string") {
  throw new Error(`Vanilla facilitator failed to settle the poisoned payment: ${JSON.stringify(vanillaSettle)}`);
}
const vanillaHashscan = hashscan(vanillaSettle.transaction);

console.log("Poisoned payment comparison (same signed transfer)");
console.log("┌─────────────────────┬──────────┬──────────┐");
console.log("│ Check               │ Vanilla  │ Sentinel │");
console.log("├─────────────────────┼──────────┼──────────┤");
console.log("│ B1 Intent Binding   │ ✗ missed │ ✓ caught │");
console.log("│ B2 Recipient List   │ ✗ missed │ ✓ caught │");
console.log("│ B3 Exploit Pattern  │ ✗ missed │ ✓ caught │");
console.log("│ Payment Settled?    │ YES ⚠️   │ BLOCKED  │");
console.log("└─────────────────────┴──────────┴──────────┘");
console.log(`vanilla facilitator let it through: ${vanillaHashscan}`);

const cleanRequirements = requirements(MERCHANT_ACCOUNT_ID);
const cleanPayload = await createPayload(cleanRequirements, "clean buy-credits payment");
const cleanBody = {
  paymentPayload: cleanPayload,
  paymentRequirements: cleanRequirements,
  intent: "buy-credits",
  recipient: MERCHANT_ACCOUNT_ID,
};
const cleanVerify = await post(`${sentinelUrl}/verify`, cleanBody);
if (cleanVerify.isValid !== true || !Array.isArray(cleanVerify.profile?.results)) {
  throw new Error(`Sentinel did not approve the clean profile: ${JSON.stringify(cleanVerify)}`);
}
const cleanResults = cleanVerify.profile.results as Array<{ passed: boolean; checkId: string }>;
for (const id of ["B1", "B2", "B3", "B4", "B5"]) {
  if (cleanResults.find(result => result.checkId === id)?.passed !== true) {
    throw new Error(`Clean payment did not pass ${id}`);
  }
  console.log(`✓ ${id} ${checkName(id)} passed`);
}
const cleanSettle = await post(`${sentinelUrl}/settle`, cleanBody);
if (cleanSettle.success !== true) {
  throw new Error(`Sentinel failed to settle the clean payment: ${JSON.stringify(cleanSettle)}`);
}
console.log(`clean payment settled: ${hashscan(cleanSettle.transaction)}`);

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/contrast-demo.json",
  JSON.stringify(
    {
      poisoned: {
        vanilla: { decision: "settled", transaction: vanillaSettle.transaction, hashscan: vanillaHashscan },
        sentinel: { decision: "blocked", checks: profileResults },
      },
      clean: { sentinel: { decision: "settled", transaction: cleanSettle.transaction, checks: cleanResults } },
    },
    null,
    2,
  ),
);

function requirements(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PAYMENT_AMOUNT,
    asset: USDC_TOKEN_ID,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FACILITATOR_ACCOUNT_ID },
  };
}

async function createPayload(paymentRequirements: PaymentRequirements, description: string): Promise<PaymentPayload> {
  return client.createPaymentPayload({
    x402Version: 2,
    resource: {
      url: "http://localhost/contrast",
      description,
      mimeType: "application/json",
    },
    accepts: [paymentRequirements],
  });
}

async function post(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

function hashscan(transaction: string): string {
  return `https://hashscan.io/testnet/transaction/${encodeURIComponent(transaction)}`;
}

function checkName(id: string): string {
  return ({ B1: "Intent Binding", B2: "Recipient Allowlist", B3: "Exploit Pattern", B4: "Reputation Floor", B5: "Amount Anomaly" } as Record<string, string>)[id] ?? id;
}

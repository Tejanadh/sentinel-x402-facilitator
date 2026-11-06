import { mkdirSync, writeFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import {
  AGENT_ACCOUNT_ID,
  AGENT_PRIVATE_KEY,
  MERCHANT_ACCOUNT_ID,
  NETWORK,
  RESOURCE_URL,
} from "../src/config.js";

const signer = createClientHederaSigner(
  AGENT_ACCOUNT_ID,
  PrivateKey.fromStringECDSA(AGENT_PRIVATE_KEY),
  { network: NETWORK },
);
const httpClient = new x402HTTPClient(
  new x402Client().setSpendControls(false).register("hedera:*", new ExactHederaScheme(signer)),
);

const headers = {
  "x-intent": "buy-credits",
  "x-recipient": MERCHANT_ACCOUNT_ID,
};

const discovered = await fetch(`${RESOURCE_URL}/credits`, { headers });
if (discovered.status !== 402) {
  console.error(`expected 402 from resource server, got ${discovered.status}`);
  console.error(await discovered.text());
  process.exit(1);
}

const paymentRequired = httpClient.getPaymentRequiredResponse(
  name => discovered.headers.get(name),
  await discovered.json(),
);
const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
const paid = await fetch(`${RESOURCE_URL}/credits`, {
  headers: { ...headers, ...paymentHeaders },
});
const text = await paid.text();
if (!paid.ok) {
  console.error(`clean payment failed: ${paid.status} ${text}`);
  process.exit(1);
}

const settlement = httpClient.getPaymentSettleResponse(name => paid.headers.get(name));
const tx = settlement?.transaction;
if (!tx) {
  console.error("settlement response missing transaction", settlement, text);
  process.exit(1);
}

const hashscan = `https://hashscan.io/testnet/transaction/${encodeURIComponent(tx)}`;
console.log(`SETTLED ${hashscan}`);
console.log(text);

const accepted = paymentPayload.accepted;
mkdirSync("data", { recursive: true });
writeFileSync(
  "data/last-clean-payment.json",
  JSON.stringify(
    {
      paymentPayload,
      paymentRequirements: accepted,
      intent: "buy-credits",
      recipient: MERCHANT_ACCOUNT_ID,
    },
    null,
    2,
  ),
);

console.log(
  `SENTINEL_ROW ${JSON.stringify({
    scenario: "clean",
    decision: "settle",
    risk: 0,
    hcs: "approve",
    tx: hashscan,
  })}`,
);

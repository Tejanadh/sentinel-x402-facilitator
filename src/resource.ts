import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  FACILITATOR_URL,
  MERCHANT_ACCOUNT_ID,
  NETWORK,
  PAYMENT_AMOUNT,
  RESOURCE_PORT,
  USDC_TOKEN_ID,
} from "./config.js";

const intentStore = new AsyncLocalStorage<{ intent?: string; recipient?: string }>();
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const store = intentStore.getStore();
  if (store && (url === `${FACILITATOR_URL}/verify` || url === `${FACILITATOR_URL}/settle`)) {
    const headers = new Headers(init?.headers);
    if (store.intent) headers.set("x-intent", store.intent);
    if (store.recipient) headers.set("x-recipient", store.recipient);
    return originalFetch(input, { ...init, headers });
  }
  return originalFetch(input, init);
}) as typeof fetch;

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }));
resourceServer.register(
  "hedera:*",
  new ExactHederaScheme({
    defaultAssets: {
      [NETWORK]: { asset: USDC_TOKEN_ID, decimals: 6 },
    },
  }),
);

const app = express();
app.use((req, _res, next) => {
  intentStore.run(
    {
      intent: req.header("x-intent") ?? undefined,
      recipient: req.header("x-recipient") ?? undefined,
    },
    () => next(),
  );
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, merchant: MERCHANT_ACCOUNT_ID, asset: USDC_TOKEN_ID });
});

app.use(
  paymentMiddleware(
    {
      "GET /credits": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: MERCHANT_ACCOUNT_ID,
          price: {
            amount: PAYMENT_AMOUNT,
            asset: USDC_TOKEN_ID,
            extra: { decimals: 6 },
          },
          maxTimeoutSeconds: 300,
        },
        description: "API credits",
        mimeType: "application/json",
      },
    },
    resourceServer,
    undefined,
    undefined,
    true,
  ),
);

app.get("/credits", (_req, res) => {
  res.json({
    credits: 1000,
    merchant: MERCHANT_ACCOUNT_ID,
    asset: USDC_TOKEN_ID,
  });
});

app.listen(RESOURCE_PORT, "127.0.0.1", () => {
  console.log(`resource server listening on ${RESOURCE_PORT}`);
});

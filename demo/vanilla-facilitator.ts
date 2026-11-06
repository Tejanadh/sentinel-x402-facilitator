import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { FACILITATOR_ACCOUNT_ID, FACILITATOR_PORT, FACILITATOR_PRIVATE_KEY, NETWORK } from "../src/config.js";
import { createSigner } from "../src/signer.js";

const scheme = new ExactHederaScheme(createSigner(FACILITATOR_ACCOUNT_ID, FACILITATOR_PRIVATE_KEY), {
  aliasPolicy: "reject",
});
const facilitator = new x402Facilitator().register(NETWORK, scheme);
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, kind: "vanilla-x402" }));
app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
app.post("/verify", async (req, res) => {
  const body = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  try {
    res.json(await facilitator.verify(body.paymentPayload, body.paymentRequirements));
  } catch (error) {
    res.status(400).json({ isValid: false, error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/settle", async (req, res) => {
  const body = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  try {
    res.json(await facilitator.settle(body.paymentPayload, body.paymentRequirements));
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(FACILITATOR_PORT, "127.0.0.1", () => {
  console.log(`vanilla x402 facilitator listening on ${FACILITATOR_PORT}`);
});

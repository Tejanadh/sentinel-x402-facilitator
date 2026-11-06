import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ALLOWLIST,
  DB_PATH,
  FACILITATOR_ACCOUNT_ID,
  FACILITATOR_PORT,
  FACILITATOR_PRIVATE_KEY,
  HCS_TOPIC_ID,
  LISTED_PRICES,
  MERCHANT_ACCOUNT_ID,
  NETWORK,
} from "./config.js";
import { publishAudit, type AuditDecision } from "./hcs.js";
import { parsePayment } from "./payment-id.js";
import { BehavioralProfile } from "./safety/profile/BehavioralProfile.js";
import type { ProfileResult } from "./safety/profile/types.js";
import { createSigner } from "./signer.js";
import { PaymentStore } from "./store.js";

const signer = createSigner(FACILITATOR_ACCOUNT_ID, FACILITATOR_PRIVATE_KEY);
const scheme = new ExactHederaScheme(signer, { aliasPolicy: "reject" });
const facilitator = new x402Facilitator().register(NETWORK, scheme);
const store = new PaymentStore(DB_PATH);
const behavioralProfile = new BehavioralProfile({ merchant: MERCHANT_ACCOUNT_ID, allowlist: ALLOWLIST });

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, network: NETWORK, feePayer: FACILITATOR_ACCOUNT_ID });
});

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", async (req, res) => {
  try {
    const body = readBody(req);
    const result = await decide(body, false);
    res.json(result.verify);
  } catch (error) {
    res.json({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: error instanceof Error ? error.message : String(error),
      payer: "",
    });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const body = readBody(req);
    const result = await decide(body, true);
    res.json(result.settle);
  } catch (error) {
    res.json({
      success: false,
      network: NETWORK,
      transaction: "",
      errorReason: "unexpected_settle_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      payer: "",
    });
  }
});

type Body = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  intent?: string;
  recipient?: string;
};

function readBody(req: express.Request): Body & { intent?: string; recipient?: string } {
  const body = req.body as Body;
  const extra = body.paymentRequirements?.extra as { intent?: string; recipient?: string } | undefined;
  return {
    ...body,
    intent: header(req, "x-intent") || body.intent || extra?.intent,
    recipient: header(req, "x-recipient") || body.recipient || extra?.recipient,
  };
}

function header(req: express.Request, name: string): string | undefined {
  const value = req.header(name);
  return value && value.length > 0 ? value : undefined;
}

async function decide(body: Body & { intent?: string; recipient?: string }, settle: boolean) {
  const requirements = body.paymentRequirements;
  const payload = body.paymentPayload;
  const transaction = (payload?.payload as { transaction?: string } | undefined)?.transaction;
  if (!requirements || !payload || !transaction) {
    return {
      verify: { isValid: false, invalidReason: "invalid_payload", payer: "" },
      settle: failSettle("", "invalid_payload", "missing payment payload"),
    };
  }

  // SR5: fail fast — zero or negative amounts must never reach transaction verification or submission.
  if (BigInt(requirements.amount) <= 0n) {
    const message = "payment amount must be greater than zero";
    return {
      verify: { isValid: false, invalidReason: "invalid_amount", invalidMessage: message, payer: "" },
      settle: failSettle("", "invalid_amount", message),
    };
  }

  let parsed;
  try {
    parsed = parsePayment(transaction, requirements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verify: { isValid: false, invalidReason: "invalid_payload", invalidMessage: message, payer: "" },
      settle: failSettle("", "invalid_payload", message),
    };
  }

  if (settle) {
    const existing = store.get(parsed.paymentId);
    if (existing) {
      store.recordHistory({
        agentId: parsed.payer,
        intent: body.intent ?? "",
        amount: Number(requirements.amount),
        asset: requirements.asset,
        decision: "replay-reject",
      });
      await audit("replay-reject", parsed.payer, parsed.paymentId, "REPLAY_DETECTED", existing.tx_hash);
      console.log(`REPLAY_DETECTED ${parsed.paymentId}`);
      return {
        verify: {
          isValid: false,
          invalidReason: "REPLAY_DETECTED",
          payer: parsed.payer,
        },
        settle: failSettle(parsed.payer, "REPLAY_DETECTED", "REPLAY_DETECTED"),
      };
    }
  }

  // SR5: fail fast — ExactHederaScheme.verify runs the Mirror Node payer-token balance preflight before settlement.
  const verified = await facilitator.verify(payload, requirements);
  if (!verified.isValid) {
    return {
      verify: verified,
      settle: failSettle(
        verified.payer || parsed.payer,
        verified.invalidReason ?? "verification_failed",
        verified.invalidMessage,
      ),
    };
  }

  const profile = behavioralProfile.run({
    agentId: parsed.payer,
    intent: body.intent ?? "",
    recipient: requirements.payTo,
    declaredRecipient: body.recipient,
    amount: Number(requirements.amount),
    amountAtomic: parsed.amount,
    asset: requirements.asset,
    history: store.getHistory(parsed.payer),
    paymentId: parsed.paymentId,
    endpoint: payload.resource?.url,
    listedPrice: payload.resource?.url ? LISTED_PRICES[payload.resource.url] : undefined,
  });
  if (profile.decision === "block") {
    // B3 retains fixture-003's original reason string for compatibility with the original demo.
    const legacyResult = profile.results.find(result => result.checkId === "B3" && !result.passed);
    const blocking = profile.results.filter(result => !result.passed && result.severity === "block");
    let reason = legacyResult?.reason ?? blocking.map(result => `${result.checkId}:${result.reason}`).join(",");
    if (blocking.some(result => result.checkId === "B6")) {
      const listedPrice = payload.resource?.url ? LISTED_PRICES[payload.resource.url] : undefined;
      const delta = BigInt(parsed.amount) - BigInt(listedPrice!);
      reason += `;B6=price_mismatch;endpoint=${payload.resource?.url ?? "unknown"};listedPrice=${listedPrice};requestedAmount=${parsed.amount};delta=${delta}`;
    }
    if (blocking.some(result => result.checkId === "B7")) {
      const metrics = behavioralProfile.getSpendMetrics(parsed.payer);
      const b7Reason = blocking.find(result => result.checkId === "B7")?.reason;
      reason += `;B7=${b7Reason};payer=${parsed.payer};amount=${parsed.amount};cumulativeSpend=${metrics.cumulativeSpend};velocityCount=${metrics.velocityCount}`;
    }
    const errorReason = legacyResult ? "INTENT_MISMATCH" : "BEHAVIORAL_PROFILE_BLOCK";
    store.recordHistory({
      agentId: parsed.payer,
      intent: body.intent ?? "",
      amount: Number(requirements.amount),
      asset: requirements.asset,
      decision: "block",
    });
    await audit("block", parsed.payer, parsed.paymentId, reason, "");
    if (legacyResult) {
      const line = `🛡️ ATTACK BLOCKED — payment to ${requirements.payTo} rejected (intent: ${body.intent ?? "missing"}, action: transfer)`;
      console.log(line);
      console.log(`reasons: ${reason}`);
    } else {
      console.log(`BEHAVIORAL_PROFILE_BLOCK ${parsed.paymentId} reasons=${reason}`);
    }
    return {
      verify: {
        isValid: false,
        invalidReason: errorReason,
        invalidMessage: reason,
        payer: parsed.payer,
        profile: publicProfile(profile),
      },
      settle: failSettle(parsed.payer, errorReason, reason),
    };
  }

  if (!settle) {
    return {
      verify: {
        isValid: true,
        payer: verified.payer || parsed.payer,
        profile: publicProfile(profile),
      },
      settle: failSettle(parsed.payer, "not_settled", "verify only"),
    };
  }

  if (!store.claim(parsed.paymentId)) {
    store.recordHistory({
      agentId: parsed.payer,
      intent: body.intent ?? "",
      amount: Number(requirements.amount),
      asset: requirements.asset,
      decision: "replay-reject",
    });
    await audit("replay-reject", parsed.payer, parsed.paymentId, "REPLAY_DETECTED", "");
    console.log(`REPLAY_DETECTED ${parsed.paymentId}`);
    return {
      verify: { isValid: false, invalidReason: "REPLAY_DETECTED", payer: parsed.payer },
      settle: failSettle(parsed.payer, "REPLAY_DETECTED", "REPLAY_DETECTED"),
    };
  }

  const spendContext = {
    agentId: parsed.payer,
    intent: body.intent ?? "",
    recipient: requirements.payTo,
    declaredRecipient: body.recipient,
    amount: Number(requirements.amount),
    amountAtomic: parsed.amount,
    asset: requirements.asset,
    history: store.getHistory(parsed.payer),
    paymentId: parsed.paymentId,
    endpoint: payload.resource?.url,
    listedPrice: payload.resource?.url ? LISTED_PRICES[payload.resource.url] : undefined,
  };
  const spendReservation = behavioralProfile.reserveSettlement(spendContext);
  if (!spendReservation.passed) {
    store.release(parsed.paymentId);
    const metrics = behavioralProfile.getSpendMetrics(parsed.payer);
    const reason = `B7:${spendReservation.reason};payer=${parsed.payer};amount=${parsed.amount};cumulativeSpend=${metrics.cumulativeSpend};velocityCount=${metrics.velocityCount}`;
    const reservedProfile: ProfileResult = {
      ...profile,
      decision: "block",
      riskScore: 100,
      results: profile.results.map(result => result.checkId === "B7" ? spendReservation : result),
    };
    store.recordHistory({
      agentId: parsed.payer,
      intent: body.intent ?? "",
      amount: Number(requirements.amount),
      asset: requirements.asset,
      decision: "block",
    });
    await audit("block", parsed.payer, parsed.paymentId, reason, "");
    return {
      verify: {
        isValid: false,
        invalidReason: "BEHAVIORAL_PROFILE_BLOCK",
        invalidMessage: reason,
        payer: parsed.payer,
        profile: publicProfile(reservedProfile),
      },
      settle: failSettle(parsed.payer, "BEHAVIORAL_PROFILE_BLOCK", reason),
    };
  }

  // SR7: re-verify before settle — ExactHederaScheme.settle verifies the signature, amount, payTo, and preflight again.
  let settled;
  try {
    settled = await facilitator.settle(payload, requirements);
  } catch (error) {
    store.release(parsed.paymentId);
    behavioralProfile.releaseReservation(spendContext);
    throw error;
  }
  if (!settled.success) {
    store.release(parsed.paymentId);
    behavioralProfile.releaseReservation(spendContext);
    return { verify: verified, settle: settled };
  }

  store.markSettled(parsed.paymentId, settled.transaction);
  store.recordHistory({
    agentId: parsed.payer,
    intent: body.intent ?? "",
    amount: Number(requirements.amount),
    asset: requirements.asset,
    decision: "approve",
  });
  behavioralProfile.recordSettlement(spendContext);
  await audit("approve", parsed.payer, parsed.paymentId, "ok", settled.transaction);
  console.log(`SETTLED ${settled.transaction}`);
  return { verify: verified, settle: settled };
}

function publicProfile(profile: ProfileResult) {
  return {
    decision: profile.decision,
    riskScore: profile.riskScore,
    results: profile.results.map(({ passed, checkId, reason, severity }) => ({
      passed,
      checkId,
      reason,
      severity,
    })),
  };
}

function failSettle(payer: string, errorReason: string, errorMessage?: string) {
  return {
    success: false,
    network: NETWORK,
    transaction: "",
    errorReason,
    errorMessage,
    payer,
  };
}

async function audit(
  decision: AuditDecision,
  agentId: string,
  paymentId: string,
  reason: string,
  txHash: string,
) {
  await publishAudit(
    {
      paymentId,
      agentId,
      decision,
      reason,
      txHash,
      timestamp: new Date().toISOString(),
    },
    {
      accountId: FACILITATOR_ACCOUNT_ID,
      privateKey: FACILITATOR_PRIVATE_KEY,
      topicId: HCS_TOPIC_ID,
    },
  );
}

app.listen(FACILITATOR_PORT, "127.0.0.1", () => {
  console.log(`facilitator listening on ${FACILITATOR_PORT} feePayer=${FACILITATOR_ACCOUNT_ID}`);
});

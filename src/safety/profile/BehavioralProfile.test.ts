import assert from "node:assert/strict";
import test from "node:test";
import { BehavioralProfile } from "./BehavioralProfile.js";
import { B1IntentResourceBinding } from "./B1IntentResourceBinding.js";
import { B2RecipientAllowlist } from "./B2RecipientAllowlist.js";
import { B3ExploitPatternReplay } from "./B3ExploitPatternReplay.js";
import { B4AgentReputationFloor } from "./B4AgentReputationFloor.js";
import { B5AmountAnomaly } from "./B5AmountAnomaly.js";
import { B6PriceMatchGuard } from "./B6PriceMatchGuard.js";
import { B7SpendCapVelocity } from "./B7SpendCapVelocity.js";
import { validateTransactionSafety } from "../../payment-id.js";
import type { PaymentContext } from "./types.js";

const allowlist = { "buy-credits": ["merchant"], swap: ["router"] };

function context(overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    agentId: "agent",
    intent: "buy-credits",
    recipient: "merchant",
    declaredRecipient: "merchant",
    amount: 10_000,
    asset: "token",
    history: [],
    ...overrides,
  };
}

test("B2 and B3 preserve fixture-003 allow/block decisions", () => {
  const b2 = new B2RecipientAllowlist(allowlist);
  const b3 = new B3ExploitPatternReplay(allowlist);
  const clean = context();
  const poisoned = context({ intent: "swap", recipient: "attacker", declaredRecipient: "attacker" });

  assert.equal(b2.check(clean).passed, true);
  assert.equal(b3.check(clean).passed, true);
  assert.equal(b2.check(poisoned).passed, false);
  assert.equal(b3.check(poisoned).passed, false);
});

test("a clean merchant payment passes all seven profile checks", () => {
  const profile = new BehavioralProfile({ merchant: "merchant", allowlist });
  const result = profile.run(
    context({
      history: [
        {
          intent: "buy-credits",
          amount: 10_000,
          asset: "token",
          decision: "approve",
          safetyScore: 95,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );

  assert.equal(result.decision, "approve");
  assert.deepEqual(result.results.map(check => check.checkId), ["B1", "B2", "B3", "B4", "B5", "B6", "B7"]);
  assert.ok(result.results.every(check => check.passed));
});

test("B6 accepts listed-price matches within tolerance and blocks excessive price deltas", () => {
  const check = new B6PriceMatchGuard({ tolerancePct: 10 });
  assert.equal(check.check(context({ amountAtomic: "1100", listedPrice: "1000" })).passed, true);
  const mismatch = check.check(context({ amountAtomic: "1101", listedPrice: "1000" }));
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.reason, "price_mismatch");
});

test("B6 skips when no listed price is available", () => {
  const result = new B6PriceMatchGuard().check(context({ listedPrice: undefined }));
  assert.equal(result.passed, true);
  assert.equal(result.severity, "info");
});

test("B6 blocks malformed listed-price metadata instead of failing open", () => {
  const result = new B6PriceMatchGuard().check(context({ amountAtomic: "10", listedPrice: "not-an-amount" }));
  assert.equal(result.passed, false);
  assert.equal(result.reason, "price_mismatch");
});

test("B7 blocks a single payment above its configured cap", () => {
  const check = new B7SpendCapVelocity({ maxSinglePayment: 100n, dailyCap: 1_000n, velocityLimit: 10 });
  const result = check.check(context({ amountAtomic: "101", paymentId: "single-over-cap" }));
  assert.equal(result.passed, false);
  assert.equal(result.reason, "single_payment_cap");
});

test("B7 blocks cumulative settled spend above the daily cap", () => {
  const check = new B7SpendCapVelocity({ maxSinglePayment: 100n, dailyCap: 150n, velocityLimit: 10 });
  const first = context({ amountAtomic: "80", paymentId: "daily-first" });
  assert.equal(check.check(first).passed, true);
  check.recordSettlement(first);
  const second = check.check(context({ amountAtomic: "80", paymentId: "daily-second" }));
  assert.equal(second.passed, false);
  assert.equal(second.reason, "daily_cap");
});

test("B7 reserves daily cap headroom before concurrent settlements", () => {
  const check = new B7SpendCapVelocity({ maxSinglePayment: 100n, dailyCap: 150n, velocityLimit: 10 });
  const first = context({ amountAtomic: "80", paymentId: "reserve-first" });
  const second = context({ amountAtomic: "80", paymentId: "reserve-second" });
  assert.equal(check.reserveSettlement(first).passed, true);
  assert.equal(check.reserveSettlement(second).reason, "daily_cap");
  check.releaseReservation(first);
  assert.equal(check.check(second).passed, true);
});

test("B7 blocks payment velocity above its configured limit", () => {
  const check = new B7SpendCapVelocity({ maxSinglePayment: 100n, dailyCap: 1_000n, velocityLimit: 1 });
  assert.equal(check.check(context({ agentId: "velocity-agent", amountAtomic: "10", paymentId: "velocity-first" })).passed, true);
  const second = check.check(context({ agentId: "velocity-agent", amountAtomic: "10", paymentId: "velocity-second" }));
  assert.equal(second.passed, false);
  assert.equal(second.reason, "velocity_limit");
});

test("B7 allows a payment under its single, daily, and velocity limits", () => {
  const check = new B7SpendCapVelocity({ maxSinglePayment: 20_000n, dailyCap: 100_000n, velocityLimit: 10 });
  const result = check.check(context({ amountAtomic: "10000", paymentId: "normal-payment" }));
  assert.equal(result.passed, true);
});

test("Hedera transaction safety rejects stale, long-lived, and high-fee payloads", () => {
  const priorDuration = process.env.SENTINEL_MAX_TX_VALID_DURATION_SECONDS;
  const priorFee = process.env.SENTINEL_MAX_TX_FEE_TINYBARS;
  process.env.SENTINEL_MAX_TX_VALID_DURATION_SECONDS = "120";
  process.env.SENTINEL_MAX_TX_FEE_TINYBARS = "200000000";
  try {
    const now = 1_000_000;
    const valid = { validStartMs: now - 1_000, validDurationSeconds: 120, maxFeeTinybars: "200000000" };
    assert.equal(validateTransactionSafety(valid, now), undefined);
    assert.match(validateTransactionSafety({ ...valid, validStartMs: now - 121_000 }, now) ?? "", /expired/);
    assert.match(validateTransactionSafety({ ...valid, validStartMs: now + 31_000 }, now) ?? "", /future/);
    assert.match(validateTransactionSafety({ ...valid, validDurationSeconds: 121 }, now) ?? "", /duration/);
    assert.match(validateTransactionSafety({ ...valid, maxFeeTinybars: "200000001" }, now) ?? "", /fee/);
  } finally {
    if (priorDuration === undefined) delete process.env.SENTINEL_MAX_TX_VALID_DURATION_SECONDS;
    else process.env.SENTINEL_MAX_TX_VALID_DURATION_SECONDS = priorDuration;
    if (priorFee === undefined) delete process.env.SENTINEL_MAX_TX_FEE_TINYBARS;
    else process.env.SENTINEL_MAX_TX_FEE_TINYBARS = priorFee;
  }
});

test("B1 binds buy-credits to the registered merchant and swaps to a known router", () => {
  const check = new B1IntentResourceBinding({ merchant: "merchant", dexRouters: ["router"] });
  assert.equal(check.check(context({ recipient: "attacker" })).reason, "INTENT_BINDING_FAIL");
  assert.equal(
    check.check(context({ intent: "swap", recipient: "router", declaredRecipient: "router" })).passed,
    true,
  );
});

test("B4 blocks agents below the reputation floor", () => {
  const result = new B4AgentReputationFloor().check(
    context({ history: [{
      intent: "buy-credits",
      amount: 10_000,
      asset: "token",
      decision: "block",
      safetyScore: 69,
      timestamp: "2026-01-01T00:00:00.000Z",
    }] }),
  );
  assert.equal(result.passed, false);
  assert.equal(result.severity, "block");
});

test("B5 blocks amounts greater than three times the historical intent median", () => {
  const check = new B5AmountAnomaly();
  const history = [10_000, 20_000, 30_000].map(amount => ({
    intent: "buy-credits",
    amount,
    asset: "token",
    decision: "approve" as const,
    safetyScore: 100,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
  assert.equal(check.check(context({ amount: 60_000, history })).passed, true);
  assert.equal(check.check(context({ amount: 60_001, history })).passed, false);
});

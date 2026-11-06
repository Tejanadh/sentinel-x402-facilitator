import { B1IntentResourceBinding } from "./B1IntentResourceBinding.js";
import { B2RecipientAllowlist } from "./B2RecipientAllowlist.js";
import { B3ExploitPatternReplay } from "./B3ExploitPatternReplay.js";
import { B4AgentReputationFloor } from "./B4AgentReputationFloor.js";
import { B5AmountAnomaly } from "./B5AmountAnomaly.js";
import { B6PriceMatchGuard } from "./B6PriceMatchGuard.js";
import { B7SpendCapVelocity } from "./B7SpendCapVelocity.js";
import type { BehavioralCheck, PaymentContext, ProfileResult } from "./types.js";

/** Deterministic behavioral checks run after protocol verification and before settlement. */
export class BehavioralProfile {
  private readonly checks: BehavioralCheck[];
  private readonly spendCapVelocity = new B7SpendCapVelocity();

  constructor(options: { merchant: string; allowlist: Record<string, readonly string[]> }) {
    this.checks = [
      new B1IntentResourceBinding({ merchant: options.merchant, dexRouters: options.allowlist.swap ?? [] }),
      new B2RecipientAllowlist(options.allowlist),
      new B3ExploitPatternReplay(options.allowlist),
      new B4AgentReputationFloor(),
      new B5AmountAnomaly(),
      new B6PriceMatchGuard(),
      this.spendCapVelocity,
    ];
  }

  run(ctx: PaymentContext): ProfileResult {
    const results = this.checks.map(check => check.check(ctx));
    const blocked = results.some(result => result.severity === "block");
    const warned = results.some(result => result.severity === "warn");
    return {
      decision: blocked ? "block" : warned ? "escalate" : "approve",
      results,
      riskScore: blocked ? 100 : warned ? 50 : 0,
    };
  }

  recordSettlement(ctx: Pick<PaymentContext, "agentId" | "amount" | "amountAtomic" | "paymentId">): void {
    this.spendCapVelocity.recordSettlement(ctx);
  }

  reserveSettlement(ctx: PaymentContext) {
    return this.spendCapVelocity.reserveSettlement(ctx);
  }

  releaseReservation(ctx: Pick<PaymentContext, "agentId" | "paymentId">): void {
    this.spendCapVelocity.releaseReservation(ctx);
  }

  getSpendMetrics(agentId: string): { cumulativeSpend: string; velocityCount: number } {
    return this.spendCapVelocity.getMetrics(agentId);
  }
}

export type { BehavioralCheck, CheckResult, PaymentContext, PaymentHistory, ProfileResult } from "./types.js";

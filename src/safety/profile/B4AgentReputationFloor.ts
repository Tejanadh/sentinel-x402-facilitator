import type { BehavioralCheck, PaymentContext } from "./types.js";

export class B4AgentReputationFloor implements BehavioralCheck {
  readonly id = "B4" as const;
  readonly name = "Agent Reputation Floor";

  check(ctx: PaymentContext) {
    const recent = ctx.history.slice(-10);
    const score = recent.length
      ? recent.reduce((total, payment) => total + payment.safetyScore, 0) / recent.length
      : 100;
    const passed = score >= 70;
    return {
      passed,
      checkId: this.id,
      severity: passed ? "info" : "block",
      ...(passed ? {} : { reason: `AGENT_REPUTATION_BELOW_70:${score.toFixed(1)}` }),
    } as const;
  }
}

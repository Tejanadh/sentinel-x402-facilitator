import type { BehavioralCheck, PaymentContext } from "./types.js";

export class B5AmountAnomaly implements BehavioralCheck {
  readonly id = "B5" as const;
  readonly name = "Amount Anomaly";

  check(ctx: PaymentContext) {
    const amounts = ctx.history
      .filter(payment => payment.intent === ctx.intent && payment.amount > 0)
      .map(payment => payment.amount)
      .sort((a, b) => a - b);
    if (amounts.length === 0) {
      return { passed: true, checkId: this.id, severity: "info" } as const;
    }
    const middle = Math.floor(amounts.length / 2);
    const median = amounts.length % 2
      ? amounts[middle]!
      : (amounts[middle - 1]! + amounts[middle]!) / 2;
    const passed = ctx.amount <= median * 3;
    return {
      passed,
      checkId: this.id,
      severity: passed ? "info" : "block",
      ...(passed ? {} : { reason: `AMOUNT_EXCEEDS_3X_INTENT_MEDIAN:${median}` }),
    } as const;
  }
}

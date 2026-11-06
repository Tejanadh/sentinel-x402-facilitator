import type { BehavioralCheck, PaymentContext } from "./types.js";

export class B1IntentResourceBinding implements BehavioralCheck {
  readonly id = "B1" as const;
  readonly name = "Intent-Resource Binding";

  constructor(
    private readonly options: { merchant: string; dexRouters: readonly string[] },
  ) {}

  check(ctx: PaymentContext) {
    let bound = true;
    if (ctx.intent === "buy-credits") bound = ctx.recipient === this.options.merchant;
    if (ctx.intent === "swap") bound = this.options.dexRouters.includes(ctx.recipient);
    return {
      passed: bound,
      checkId: this.id,
      severity: bound ? "info" : "block",
      ...(bound ? {} : { reason: "INTENT_BINDING_FAIL" }),
    } as const;
  }
}

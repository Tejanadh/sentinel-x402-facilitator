import type { BehavioralCheck, PaymentContext } from "./types.js";

export class B2RecipientAllowlist implements BehavioralCheck {
  readonly id = "B2" as const;
  readonly name = "Recipient Allowlist";

  constructor(private readonly allowlist: Record<string, readonly string[]>) {}

  check(ctx: PaymentContext) {
    const recipientAllowed = (this.allowlist[ctx.intent] ?? []).includes(ctx.recipient);
    const declarationMatches = (ctx.declaredRecipient ?? "") === ctx.recipient;
    const passed = recipientAllowed && declarationMatches;
    return {
      passed,
      checkId: this.id,
      severity: passed ? "info" : "block",
      ...(passed ? {} : { reason: "UNAUTHORIZED_RECIPIENT" }),
    } as const;
  }
}

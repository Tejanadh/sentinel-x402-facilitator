export type SafetyDecision =
  | { ok: true; risk: 0 }
  | { ok: false; risk: 100; reasons: ["INTENT_MISMATCH", "UNAUTHORIZED_RECIPIENT"] };

/**
 * The one safety fixture. Rule-based, no model.
 * A declared swap or buy-credits payment is safe only when payTo is on that
 * intent's merchant allowlist and the declared recipient is that same payTo.
 */
export function evaluateIntent(input: {
  intent: string | undefined;
  recipient: string | undefined;
  payTo: string;
  allowlist: Record<string, readonly string[]>;
}): SafetyDecision {
  const intent = (input.intent ?? "").trim();
  const recipient = (input.recipient ?? "").trim();
  const allowed = input.allowlist[intent] ?? [];
  const recipientMatchesPayTo = recipient.length > 0 && recipient === input.payTo;
  const payToAllowed = allowed.includes(input.payTo);
  if ((intent === "swap" || intent === "buy-credits") && recipientMatchesPayTo && payToAllowed) {
    return { ok: true, risk: 0 };
  }
  return { ok: false, risk: 100, reasons: ["INTENT_MISMATCH", "UNAUTHORIZED_RECIPIENT"] };
}

import type { BehavioralCheck, PaymentContext } from "./types.js";

export class B6PriceMatchGuard implements BehavioralCheck {
  readonly id = "B6" as const;
  readonly name = "Price-Match Guard";
  private readonly toleranceBasisPoints: bigint;

  constructor(options: { tolerancePct?: number } = {}) {
    const configured = options.tolerancePct ?? Number(process.env.SENTINEL_PRICE_TOLERANCE_PCT ?? 10);
    const tolerancePct = Number.isFinite(configured) ? Math.max(0, configured) : 10;
    this.toleranceBasisPoints = BigInt(Math.round(tolerancePct * 100));
  }

  check(ctx: PaymentContext) {
    if (ctx.listedPrice === undefined || ctx.listedPrice === null) {
      return { passed: true, checkId: this.id, severity: "info", reason: "listed_price_unavailable" } as const;
    }

    let listedPrice: bigint;
    let requestedAmount: bigint;
    try {
      // Assumption: listedPrice and payment requirements.amount use the same atomic USDC units.
      listedPrice = BigInt(String(ctx.listedPrice));
      requestedAmount = BigInt(ctx.amountAtomic ?? String(Math.trunc(ctx.amount)));
    } catch {
      return { passed: false, checkId: this.id, severity: "block", reason: "price_mismatch" } as const;
    }
    if (listedPrice < 0n || requestedAmount < 0n) {
      return { passed: false, checkId: this.id, severity: "block", reason: "price_mismatch" } as const;
    }

    const passed = requestedAmount * 10_000n <= listedPrice * (10_000n + this.toleranceBasisPoints);
    return {
      passed,
      checkId: this.id,
      severity: passed ? "info" : "block",
      ...(passed ? {} : { reason: "price_mismatch" }),
    } as const;
  }
}

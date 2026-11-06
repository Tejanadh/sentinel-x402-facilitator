import type { BehavioralCheck, PaymentContext } from "./types.js";

type SpendEntry = { paymentId: string; amount: bigint; timestamp: number; status: "reserved" | "settled" };
type VelocityEntry = { paymentId: string; timestamp: number };
type AgentState = { spend: SpendEntry[]; velocity: VelocityEntry[] };

export class B7SpendCapVelocity implements BehavioralCheck {
  readonly id = "B7" as const;
  readonly name = "Spend Cap and Velocity Limit";
  // In-memory state keeps the demo self-contained; production should use a persistent store.
  private readonly agents = new Map<string, AgentState>();
  private readonly maxSinglePayment: bigint;
  private readonly dailyCap: bigint;
  private readonly velocityLimit: number;
  private anonymousPaymentId = 0;

  constructor(options: { maxSinglePayment?: bigint; dailyCap?: bigint; velocityLimit?: number } = {}) {
    this.maxSinglePayment = options.maxSinglePayment ?? envBigInt("SENTINEL_MAX_SINGLE_PAYMENT", 1_000_000n);
    this.dailyCap = options.dailyCap ?? envBigInt("SENTINEL_DAILY_CAP", 10_000_000n);
    this.velocityLimit = options.velocityLimit ?? envPositiveInteger("SENTINEL_VELOCITY_LIMIT", 10);
  }

  check(ctx: PaymentContext) {
    const now = Date.now();
    const state = this.stateFor(ctx.agentId);
    this.prune(state, now);
    const paymentId = this.paymentId(ctx, now);
    if (!state.velocity.some(entry => entry.paymentId === paymentId)) {
      state.velocity.push({ paymentId, timestamp: now });
    }

    const amount = BigInt(ctx.amountAtomic ?? String(Math.trunc(ctx.amount)));
    const cumulativeSpend = state.spend.reduce((sum, entry) => sum + entry.amount, 0n);
    const alreadyCounted = state.spend.some(entry => entry.paymentId === paymentId);
    const velocityCount = state.velocity.length;
    const reason = amount > this.maxSinglePayment
      ? "single_payment_cap"
      : !alreadyCounted && cumulativeSpend + amount > this.dailyCap
        ? "daily_cap"
        : velocityCount > this.velocityLimit
          ? "velocity_limit"
          : undefined;

    return {
      passed: reason === undefined,
      checkId: this.id,
      severity: reason ? "block" : "info",
      ...(reason ? { reason } : {}),
    } as const;
  }

  /** Atomically reserve cap headroom before the async Hedera submit can interleave with another settle. */
  reserveSettlement(ctx: PaymentContext) {
    const result = this.check(ctx);
    if (!result.passed) return result;
    const now = Date.now();
    const state = this.stateFor(ctx.agentId);
    const paymentId = this.paymentId(ctx, now);
    if (!state.spend.some(entry => entry.paymentId === paymentId)) {
      state.spend.push({
        paymentId,
        amount: BigInt(ctx.amountAtomic ?? String(Math.trunc(ctx.amount))),
        timestamp: now,
        status: "reserved",
      });
    }
    return result;
  }

  /** Record daily spend only after Hedera confirms the payment settled successfully. */
  recordSettlement(ctx: Pick<PaymentContext, "agentId" | "amount" | "amountAtomic" | "paymentId">): void {
    const now = Date.now();
    const state = this.stateFor(ctx.agentId);
    this.prune(state, now);
    const paymentId = this.paymentId(ctx, now);
    const reservation = state.spend.find(entry => entry.paymentId === paymentId);
    if (reservation) {
      reservation.status = "settled";
      reservation.timestamp = now;
      return;
    }
    state.spend.push({
      paymentId,
      amount: BigInt(ctx.amountAtomic ?? String(Math.trunc(ctx.amount))),
      timestamp: now,
      status: "settled",
    });
  }

  releaseReservation(ctx: Pick<PaymentContext, "agentId" | "paymentId">): void {
    const state = this.stateFor(ctx.agentId);
    const paymentId = this.paymentId(ctx, Date.now());
    state.spend = state.spend.filter(entry => entry.paymentId !== paymentId || entry.status !== "reserved");
  }

  getMetrics(agentId: string): { cumulativeSpend: string; velocityCount: number } {
    const now = Date.now();
    const state = this.stateFor(agentId);
    this.prune(state, now);
    return {
      cumulativeSpend: state.spend.reduce((sum, entry) => sum + entry.amount, 0n).toString(),
      velocityCount: state.velocity.length,
    };
  }

  private stateFor(agentId: string): AgentState {
    let state = this.agents.get(agentId);
    if (!state) {
      state = { spend: [], velocity: [] };
      this.agents.set(agentId, state);
    }
    return state;
  }

  private prune(state: AgentState, now: number): void {
    state.spend = state.spend.filter(entry => now - entry.timestamp < 24 * 60 * 60 * 1000);
    state.velocity = state.velocity.filter(entry => now - entry.timestamp < 60 * 1000);
  }

  private paymentId(ctx: Pick<PaymentContext, "agentId" | "paymentId">, now: number): string {
    return ctx.paymentId ?? `${ctx.agentId}:anonymous:${now}:${++this.anonymousPaymentId}`;
  }
}

function envBigInt(name: string, fallback: bigint): bigint {
  try {
    const value = BigInt(process.env[name] ?? fallback.toString());
    return value > 0n ? value : fallback;
  } catch {
    return fallback;
  }
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

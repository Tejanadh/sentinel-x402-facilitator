export type BehavioralCheckId = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7";

export interface PaymentHistory {
  intent: string;
  amount: number;
  asset: string;
  decision: "approve" | "block" | "replay-reject";
  safetyScore: number;
  timestamp: string;
}

export interface PaymentContext {
  agentId: string;
  intent: string;
  /** The actual x402 payTo address. */
  recipient: string;
  /** The agent's x-recipient declaration; retained to preserve fixture-003 behavior. */
  declaredRecipient?: string;
  amount: number;
  /** Atomic amount from PaymentRequirements.amount, retained without floating-point conversion. */
  amountAtomic?: string;
  asset: string;
  history: PaymentHistory[];
  paymentId?: string;
  endpoint?: string;
  /** Listed price in the same atomic units as amountAtomic. */
  listedPrice?: string | number;
}

export interface CheckResult {
  passed: boolean;
  checkId: BehavioralCheckId;
  reason?: string;
  severity: "info" | "warn" | "block";
}

export interface BehavioralCheck {
  id: BehavioralCheckId;
  name: string;
  check(ctx: PaymentContext): CheckResult;
}

export interface ProfileResult {
  decision: "approve" | "block" | "escalate";
  results: CheckResult[];
  riskScore: number;
}

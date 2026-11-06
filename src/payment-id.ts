import { createHash } from "node:crypto";
import { Transaction } from "@hiero-ledger/sdk";
import { inspectHederaTransaction, isHbarAsset } from "@x402/hedera";

export type ParsedPayment = {
  paymentId: string;
  payer: string;
  payTo: string;
  amount: string;
  asset: string;
  nonce: string;
};

/**
 * paymentId = sha256(payer | payTo | amount | asset | nonce).
 * nonce is the Hedera transaction id on the client-signed transfer.
 */
export function parsePayment(
  transactionBase64: string,
  requirements: { payTo: string; amount: string; asset: string },
): ParsedPayment {
  const decodedTransaction = Transaction.fromBytes(Buffer.from(transactionBase64, "base64"));
  const validStart = decodedTransaction.transactionId?.validStart;
  const transactionSafetyFailure = validateTransactionSafety({
    validStartMs: validStart ? validStart.toDate().getTime() : Number.NaN,
    validDurationSeconds: decodedTransaction.transactionValidDuration,
    maxFeeTinybars: decodedTransaction.maxTransactionFee?.toTinybars().toString() ?? null,
  });
  if (transactionSafetyFailure) throw new Error(transactionSafetyFailure);

  const inspected = inspectHederaTransaction(transactionBase64);
  const transfers = isHbarAsset(requirements.asset)
    ? inspected.hbarTransfers
    : (inspected.tokenTransfers[requirements.asset] ?? []);
  const debits = new Map<string, bigint>();
  for (const entry of transfers) {
    const amount = BigInt(entry.amount);
    if (amount < 0n) {
      debits.set(entry.accountId, (debits.get(entry.accountId) ?? 0n) + -amount);
    }
  }
  const payer = [...debits.keys()].sort()[0];
  if (!payer) {
    throw new Error("could not infer payer from transfer list");
  }
  if (!inspected.transactionId) {
    throw new Error("transaction has no id");
  }

  const nonce = inspected.transactionId;
  const payTo = requirements.payTo;
  const amount = requirements.amount;
  const asset = requirements.asset;
  const paymentId = createHash("sha256")
    .update([payer, payTo, amount, asset, nonce].join("|"))
    .digest("hex");
  return { paymentId, payer, payTo, amount, asset, nonce };
}

export function validateTransactionSafety(
  input: { validStartMs: number; validDurationSeconds: number; maxFeeTinybars: string | null },
  nowMs = Date.now(),
): string | undefined {
  const maximumDuration = positiveIntegerEnv("SENTINEL_MAX_TX_VALID_DURATION_SECONDS", 120);
  if (
    !Number.isFinite(input.validStartMs) ||
    !Number.isInteger(input.validDurationSeconds) ||
    input.validDurationSeconds <= 0 ||
    input.validDurationSeconds > maximumDuration
  ) {
    return "transaction validity duration is invalid or exceeds the configured limit";
  }

  const maxFutureSkewMs = 30_000;
  if (input.validStartMs > nowMs + maxFutureSkewMs) {
    return "transaction valid start is too far in the future";
  }
  if (nowMs > input.validStartMs + input.validDurationSeconds * 1000) {
    return "transaction has expired";
  }

  const maximumFeeTinybars = positiveBigIntEnv("SENTINEL_MAX_TX_FEE_TINYBARS", 200_000_000n);
  // An unset Hedera transaction fee uses the SDK's default maximum of 2 HBAR.
  let requestedFeeTinybars: bigint;
  try {
    requestedFeeTinybars = input.maxFeeTinybars === null ? 200_000_000n : BigInt(input.maxFeeTinybars);
  } catch {
    return "transaction maximum fee is invalid";
  }
  if (requestedFeeTinybars < 0n || requestedFeeTinybars > maximumFeeTinybars) {
    return "transaction maximum fee exceeds the configured limit";
  }
  return undefined;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveBigIntEnv(name: string, fallback: bigint): bigint {
  try {
    const value = BigInt(process.env[name] ?? fallback.toString());
    return value > 0n ? value : fallback;
  } catch {
    return fallback;
  }
}

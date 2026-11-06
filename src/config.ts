import "dotenv/config";

export const NETWORK = (process.env.HEDERA_NETWORK ?? "hedera:testnet") as `${string}:${string}`;
export const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT ?? 4020);
export const RESOURCE_PORT = Number(process.env.RESOURCE_PORT ?? 4021);
export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? `http://127.0.0.1:${FACILITATOR_PORT}`;
export const RESOURCE_URL = process.env.RESOURCE_URL ?? `http://127.0.0.1:${RESOURCE_PORT}`;

export const FACILITATOR_ACCOUNT_ID = required("FACILITATOR_ACCOUNT_ID");
export const FACILITATOR_PRIVATE_KEY = required("FACILITATOR_PRIVATE_KEY");
export const AGENT_ACCOUNT_ID = required("AGENT_ACCOUNT_ID");
export const AGENT_PRIVATE_KEY = required("AGENT_PRIVATE_KEY");
export const MERCHANT_ACCOUNT_ID = required("MERCHANT_ACCOUNT_ID");
export const ATTACKER_ACCOUNT_ID = required("ATTACKER_ACCOUNT_ID");
export const USDC_TOKEN_ID = required("USDC_TOKEN_ID");
export const HCS_TOPIC_ID = required("HCS_TOPIC_ID");

/** 0.01 USDC in 6-decimal base units. */
export const PAYMENT_AMOUNT = process.env.PAYMENT_AMOUNT ?? "10000";
export const DB_PATH = process.env.SENTINEL_DB ?? "data/sentinel.sqlite";
/** Trusted facilitator-side quote baselines; client-supplied requirements metadata is not authoritative. */
export const LISTED_PRICES = parseListedPrices(process.env.SENTINEL_LISTED_PRICES_JSON);

/**
 * Merchant addresses allowed to receive value for each declared intent.
 * `swap` is intentionally empty: a swap-labeled transfer to any address is a mismatch
 * until a DEX treasury is registered. `buy-credits` allows only the demo merchant.
 */
export const ALLOWLIST: Record<string, readonly string[]> = {
  swap: split(process.env.SWAP_ALLOWLIST),
  "buy-credits": split(process.env.BUY_CREDITS_ALLOWLIST ?? MERCHANT_ACCOUNT_ID),
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run npm run bootstrap after funding the facilitator.`);
  }
  return value;
}

function split(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

function parseListedPrices(value: string | undefined): Record<string, string> {
  const defaults = { [`${RESOURCE_URL}/credits`]: PAYMENT_AMOUNT };
  if (!value) return defaults;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SENTINEL_LISTED_PRICES_JSON must be a JSON object mapping endpoint URLs to atomic amounts");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([endpoint, amount]) => !endpoint.startsWith("http") || typeof amount !== "string" || !/^\d+$/.test(amount))) {
    throw new Error("SENTINEL_LISTED_PRICES_JSON entries must map HTTP endpoint URLs to non-negative integer amounts");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

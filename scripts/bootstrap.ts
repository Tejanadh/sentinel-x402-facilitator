import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenId,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";

type Env = Record<string, string>;

const env = loadEnv(".env");
if (!env.FACILITATOR_PRIVATE_KEY) {
  env.FACILITATOR_PRIVATE_KEY = PrivateKey.generateECDSA().toStringRaw();
  writeEnv(env);
}
const facilitatorKey = PrivateKey.fromStringECDSA(env.FACILITATOR_PRIVATE_KEY);

if (!env.FACILITATOR_ACCOUNT_ID) {
  const evm = `0x${facilitatorKey.publicKey.toEvmAddress()}`;
  console.log(`Facilitator has no account id yet. EVM address: ${evm}`);
  const funded = await fundAddress(evm);
  if (funded) {
    console.log("faucet accepted the disbursement");
  }
  const existing = await lookupAlias(evm, funded ? 20 : 2);
  if (!existing) {
    throw new Error(
      `Fund ${evm} with testnet HBAR, then rerun npm run bootstrap.\nPortal faucet: https://portal.hedera.com/faucet\nOr export HEDERA_PAT and rerun to use the faucet API.`,
    );
  }
  env.FACILITATOR_ACCOUNT_ID = existing;
  await completeHollowAccount(env.FACILITATOR_ACCOUNT_ID, facilitatorKey);
  writeEnv(env);
}

const facilitatorId = AccountId.fromString(env.FACILITATOR_ACCOUNT_ID);
const client = Client.forTestnet().setOperator(facilitatorId, facilitatorKey);

await ensureAccount(client, "AGENT");
await ensureAccount(client, "MERCHANT");
await ensureAccount(client, "ATTACKER");

const mintedHere = !env.USDC_TOKEN_ID || env.USDC_TOKEN_ID === "mint";
if (mintedHere) {
  const response = await new TokenCreateTransaction()
    .setTokenName("USD Coin")
    .setTokenSymbol("USDC")
    .setMaxTransactionFee(new Hbar(30))
    .setDecimals(6)
    .setInitialSupply(100_000_000)
    .setTreasuryAccountId(facilitatorId)
    .setSupplyType(TokenSupplyType.Finite)
    .setMaxSupply(1_000_000_000_000)
    .setTokenType(TokenType.FungibleCommon)
    .setAdminKey(facilitatorKey)
    .setSupplyKey(facilitatorKey)
    .execute(client);
  const receipt = await response.getReceipt(client);
  env.USDC_TOKEN_ID = receipt.tokenId!.toString();
  console.log(`created HTS USDC ${env.USDC_TOKEN_ID}`);
  writeEnv(env);
}

const tokenId = TokenId.fromString(env.USDC_TOKEN_ID);
await fundTokenAccounts(tokenId);

if (!env.HCS_TOPIC_ID) {
  const response = await new TopicCreateTransaction()
    .setTopicMemo("sentinel-x402-audit")
    .setSubmitKey(facilitatorKey.publicKey)
    .execute(client);
  const receipt = await response.getReceipt(client);
  env.HCS_TOPIC_ID = receipt.topicId!.toString();
  console.log(`created HCS topic ${env.HCS_TOPIC_ID}`);
}

env.HEDERA_NETWORK ??= "hedera:testnet";
env.FACILITATOR_PORT ??= "4020";
env.RESOURCE_PORT ??= "4021";
env.PAYMENT_AMOUNT ??= "10000";
env.BUY_CREDITS_ALLOWLIST ??= env.MERCHANT_ACCOUNT_ID;
env.SWAP_ALLOWLIST ??= "";
writeEnv(env);
client.close();
console.log(
  JSON.stringify(
    {
      facilitator: env.FACILITATOR_ACCOUNT_ID,
      agent: env.AGENT_ACCOUNT_ID,
      merchant: env.MERCHANT_ACCOUNT_ID,
      attacker: env.ATTACKER_ACCOUNT_ID,
      usdc: env.USDC_TOKEN_ID,
      topic: env.HCS_TOPIC_ID,
    },
    null,
    2,
  ),
);

async function ensureAccount(operator: Client, label: "AGENT" | "MERCHANT" | "ATTACKER") {
  const idKey = `${label}_ACCOUNT_ID`;
  const keyKey = `${label}_PRIVATE_KEY`;
  if (env[idKey] && env[keyKey]) return;
  const key = env[keyKey] ? PrivateKey.fromStringECDSA(env[keyKey]) : PrivateKey.generateECDSA();
  env[keyKey] = key.toStringRaw();
  const response = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key.publicKey)
    .setInitialBalance(new Hbar(2))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(operator);
  const receipt = await response.getReceipt(operator);
  env[idKey] = receipt.accountId!.toString();
  console.log(`created ${label} ${env[idKey]}`);
  writeEnv(env);
}

async function fundTokenAccounts(token: TokenId) {
  const recipients = [
    { id: env.AGENT_ACCOUNT_ID, amount: 5_000_000, label: "agent" },
    { id: env.MERCHANT_ACCOUNT_ID, amount: 1, label: "merchant" },
    { id: env.ATTACKER_ACCOUNT_ID, amount: 1, label: "attacker" },
  ];
  const needsTokens: typeof recipients = [];
  for (const recipient of recipients) {
    const url = `https://testnet.mirrornode.hedera.com/api/v1/accounts/${recipient.id}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mirror Node account lookup failed for ${recipient.id}: ${response.status}`);
    const account = (await response.json()) as { tokens?: Array<{ token_id: string }> };
    if (!account.tokens?.some(entry => entry.token_id === token.toString())) needsTokens.push(recipient);
  }
  if (needsTokens.length === 0) {
    console.log("demo token accounts already funded and auto-associated");
    return;
  }
  const total = needsTokens.reduce((sum, recipient) => sum + recipient.amount, 0);
  const transfer = new TransferTransaction().addTokenTransfer(token, facilitatorId, -total);
  for (const recipient of needsTokens) {
    transfer.addTokenTransfer(token, AccountId.fromString(recipient.id), recipient.amount);
  }
  const response = await transfer.execute(client);
  const receipt = await response.getReceipt(client);
  console.log(`funded ${needsTokens.map(recipient => recipient.label).join(", ")} token account(s) (${receipt.status.toString()})`);
}

async function fundAddress(address: string): Promise<boolean> {
  const pat = process.env.HEDERA_PAT ?? env.HEDERA_PAT;
  if (!pat) return false;
  const response = await fetch("https://portal.hedera.com/api/disbursement/cli", {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ address, amount: 100, network: "testnet" }),
  });
  const text = await response.text();
  console.log(`faucet ${response.status} ${text.slice(0, 400)}`);
  return response.ok;
}

async function lookupAlias(evm: string, attempts: number): Promise<string | undefined> {
  const bare = evm.replace(/^0x/, "");
  const url = `https://testnet.mirrornode.hedera.com/api/v1/accounts/${bare}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const body = (await response.json()) as { account: string };
      return body.account;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return undefined;
}

async function completeHollowAccount(accountId: string, key: PrivateKey) {
  const id = AccountId.fromString(accountId);
  const net = Client.forTestnet();
  try {
    const tx = await new TransferTransaction()
      .addHbarTransfer(id, Hbar.fromTinybars(-10_000_000))
      .addHbarTransfer(AccountId.fromString("0.0.800"), Hbar.fromTinybars(10_000_000))
      .setTransactionId(TransactionId.generate(id))
      .freezeWith(net);
    const signed = await tx.sign(key);
    const response = await signed.execute(net);
    const receipt = await response.getReceipt(net);
    console.log(`completed account ${accountId} (${receipt.status.toString()})`);
  } finally {
    net.close();
  }
}

function loadEnv(path: string): Env {
  if (!existsSync(path)) return {};
  const out: Env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function writeEnv(values: Env) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(".env", `${lines.join("\n")}\n`);
}

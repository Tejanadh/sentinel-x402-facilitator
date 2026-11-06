import {
  AccountId,
  Client,
  PrivateKey,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

export type AuditDecision = "approve" | "block" | "replay-reject";

export type AuditEntry = {
  paymentId: string;
  agentId: string;
  decision: AuditDecision;
  reason: string;
  txHash: string;
  timestamp: string;
};

export async function publishAudit(
  entry: AuditEntry,
  opts: { accountId: string; privateKey: string; topicId: string },
): Promise<string> {
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(opts.accountId),
    PrivateKey.fromStringECDSA(opts.privateKey),
  );
  try {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(opts.topicId))
      .setMessage(JSON.stringify(entry))
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new Error(`HCS submit status ${receipt.status.toString()}`);
    }
    return response.transactionId.toString();
  } finally {
    client.close();
  }
}

export function mirrorMessagesUrl(topicId: string): string {
  return `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?limit=20&order=desc`;
}

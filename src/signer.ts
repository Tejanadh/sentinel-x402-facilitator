import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  PrivateKey,
  type FacilitatorHederaSigner,
} from "@x402/hedera";

export function createSigner(accountId: string, privateKeyHex: string): FacilitatorHederaSigner {
  const privateKey = PrivateKey.fromStringECDSA(privateKeyHex);
  return {
    getAddresses: () => [accountId],
    // SR4: settle-failure means no success; the SDK helper checks getReceipt() before returning a transaction ID.
    signAndSubmitTransaction: createHederaSignAndSubmitTransaction(
      network => createHederaClient(network),
      privateKey,
    ),
    verifyPayerSignature: createHederaVerifyPayerSignature(),
    // SR5: fail fast — the helper queries Mirror Node token balances before verification permits settlement.
    preflightTransfer: createHederaPreflightTransfer(),
    resolveAccount: async (accountIdOrAlias, network) => {
      const { mirrorNodeUrlForNetwork, fetchJson } = await import("@x402/hedera");
      try {
        const account = await fetchJson<{ account: string; alias: string | null }>(
          `${mirrorNodeUrlForNetwork(network)}/api/v1/accounts/${encodeURIComponent(accountIdOrAlias)}`,
        );
        const isAlias = accountIdOrAlias !== account.account;
        return { exists: true, isAlias };
      } catch {
        return { exists: false, isAlias: false };
      }
    },
  };
}

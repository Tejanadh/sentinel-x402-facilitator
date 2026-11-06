# Sentinel

Security-first x402 facilitator for AI agents on Hedera testnet.

x402 lets an agent pay for an HTTP resource without a human in the loop. A normal facilitator checks that the payment is **valid**: the client signed a Hedera `TransferTransaction`, the fee payer is the facilitator, the amount and asset match, and the payer has the funds. Sentinel adds a deterministic Behavioral Safety Profile before it co-signs, checking whether the payment fits the agent's declared intent, recipient policy, exploit fixtures, reputation, and amount history.

## Demo

```bash
npm install
cp .env.example .env   # or let bootstrap fill this in
npm run bootstrap
bash demo/run-demo.sh
```

`demo/run-demo.sh` preserves the original end-to-end milestone. It must print:

- a blocked poisoned payment (`INTENT_MISMATCH`, `UNAUTHORIZED_RECIPIENT`)
- a settled clean payment with a HashScan link
- a `REPLAY_DETECTED` rejection of that same payment
- three HCS messages readable from the Hedera testnet mirror node

The clean path uses `@x402/hedera` and `@x402/core`. The client requests `GET /credits`, receives HTTP 402, signs a partial USDC transfer, and retries. Nobody approves that payment. Run `npm test` for the profile checks.

## The Behavioral Safety Profile

Existing x402 conformance suites exercise protocol mechanics such as replay prevention, settlement validity, and amount/asset matching. They do not measure whether a protocol-valid payment matches an agent's intent and task context. The [May 2026 Grok/Bankr prompt-injection incident](https://oecd.ai/en/incidents/2026-05-04-4a73) illustrates the risk of poisoned context leading to an unauthorized transfer; it involved a Base wallet and was not an x402 payment. Sentinel proposes the B-family as a behavioral-safety check family alongside protocol conformance.

| ID | Check | Catches |
| --- | --- | --- |
| B1 | Intent-Resource Binding | `buy-credits` sent somewhere other than the registered merchant, or `swap` sent somewhere other than a configured DEX router |
| B2 | Recipient Allowlist | A declared recipient mismatch or a `payTo` address outside the allowlist for the intent |
| B3 | Exploit-Pattern Replay | The existing fixture-003 intent-mismatch pattern, tracked in corpus `sentinel-fixtures/1.0.0` |
| B4 | Agent Reputation Floor | A rolling safety score below 70, calculated from the agent's ten most recent stored decisions |
| B5 | Amount Anomaly | An amount greater than three times the historical median for the same intent |
| B6 | Price-Match Guard | A requested price more than the configured tolerance above a facilitator-configured listed price |
| B7 | Spend Cap + Velocity | A per-payer single-payment cap, rolling 24-hour spend cap, and 60-second payment-count limit |

B2 and B3 preserve the original fixture's allow/block result and legacy block reason. B1, B4, and B5 add deterministic profile signals. Payment history and reputation scores are stored in SQLite beside the replay store.

B6 uses `SENTINEL_LISTED_PRICES_JSON`, a facilitator-side map from exact resource URLs to atomic token amounts. The default maps `${RESOURCE_URL}/credits` to `PAYMENT_AMOUNT`. The facilitator does not trust a caller-supplied listed price. B7 defaults to 1 USDC per payment, 10 USDC settled or reserved in a rolling 24-hour window, and 10 attempts in 60 seconds. Spend tracking is in memory for this demo; production must persist it and coordinate reservations across facilitator instances.

The [USENIX Security 2026 study](https://www.usenix.org/conference/usenixsecurity26/presentation/wang-qinying) evaluated 15 major x402 facilitators and found security-rule violations in every evaluated facilitator. Sentinel's B-family checks are designed to be portable to the x402-conformance check framework.

Run the contrast demo with:

```bash
bash demo/contrast-demo.sh
```

It starts plain `@x402/hedera` on port 3001 and Sentinel on port 3000. Both receive the same client-signed poisoned payment: vanilla settles it and prints a HashScan link; Sentinel blocks it at B1–B3. Sentinel then runs a clean payment and prints a pass for B1–B5 before settling it. The poisoned transfer is a real testnet USDC transaction by design. Results are written to `data/contrast-demo.json`.

## Architecture

```
agent  --GET /credits-->  resource server (Express, @x402/express)
                              |  402 Payment Required (exact, hedera:testnet, USDC)
agent  --PAYMENT-SIGNATURE--> resource server
                              |  POST /verify then POST /settle
                              v
                         Sentinel facilitator
                              |  1. official exact-scheme checks (@x402/hedera)
                              |  2. Behavioral Safety Profile (B1–B7)
                              |  3. sqlite paymentId dedup and behavior history
                              |  4. co-sign as fee payer and submit
                              v
                         Hedera testnet + one HCS topic
```

`paymentId` is `sha256(payer | payTo | amount | asset | nonce)` where `nonce` is the Hedera transaction id. A second `POST /settle` for the same id returns `REPLAY_DETECTED` and does not submit again.

The allowlist ships with one merchant, for `buy-credits`. `swap` has no configured DEX router, so an unknown recipient is blocked by B1–B3. The original fixture block reason remains `INTENT_MISMATCH,UNAUTHORIZED_RECIPIENT`.

## Payment flow

1. Facilitator `GET /supported` advertises `exact` on `hedera:testnet` and its fee-payer account.
2. Resource server `GET /credits` returns 402 with `payTo` set to the registered merchant and `extra.feePayer` set to the facilitator.
3. The agent SDK builds a partially signed HTS transfer of `PAYMENT_AMOUNT` base units (default `10000`, which is 0.01 USDC at 6 decimals). The transaction id account is the fee payer. The agent signs. The facilitator has not signed yet.
4. The resource server forwards `x-intent` and `x-recipient` to the facilitator.
5. Facilitator verifies layout, fee-payer safety, amount exactness, payer signature, and balance/association, then runs the Behavioral Safety Profile.
6. On approve, the facilitator signs as fee payer, submits, waits for a `SUCCESS` receipt, stores `paymentId` and behavioral history in SQLite, and submits an HCS message `{paymentId, agentId, decision, reason, txHash, timestamp}`.

Sentinel also rejects stale or excessively long-lived signed transactions and enforces a configurable maximum transaction fee before the SDK verifies or submits them. Defaults are 120 seconds for transaction validity and 2 HBAR for the fee cap (`SENTINEL_MAX_TX_VALID_DURATION_SECONDS`, `SENTINEL_MAX_TX_FEE_TINYBARS`).

## Accounts

Bootstrap creates three ECDSA accounts from the facilitator (agent, merchant, attacker), one HTS fungible token with symbol `USDC` and 6 decimals, associations for every party, a 5 USDC balance on the agent, and the audit topic. The facilitator account itself must already hold testnet HBAR. Create one at https://portal.hedera.com/faucet (the anonymous faucet creates a hollow account for an EVM address) or set `HEDERA_PAT` so bootstrap can call `POST /api/disbursement/cli`.

To settle Circle's testnet USDC instead of the bootstrapped token, put `USDC_TOKEN_ID=0.0.429274` in `.env` before bootstrap and fund the agent from the Circle testnet faucet. Bootstrap will not mint that token.

## Settled transactions

The latest clean settlement is printed by `demo/run-demo.sh` and stored in `data/last-clean-payment.json`. Paste the HashScan URL here after the first green run.

## Not in this build

Post-settlement invariant re-checks, ENS identity, World ID escalation, a second fixture, and a dashboard are out of scope until the demo above is stable. There is no AMM, no LLM intent matcher, and no mainnet deployment.

## Video script

Record only after `bash demo/run-demo.sh` passes three times in a row.

- 0:00–0:20 — x402 lets agents pay autonomously. In May 2026 a Morse-code prompt injection led Grok and Bankrbot to transfer tokens worth an estimated $150K–$200K. That was not an x402 payment; it shows how poisoned context can drive an unauthorized transfer. Protocol checks alone do not establish that a payment matches the agent's intent.
- 0:20–0:60 — poisoned agent, blocked, `INTENT_MISMATCH` + `UNAUTHORIZED_RECIPIENT` on screen, HCS entry.
- 0:60–1:30 — clean agent settles, HashScan link, HCS settlement entry.
- 1:30–2:00 — replay rejected. Replay protection, anchored permanently on HCS.
- 2:00–2:30 — Sentinel: the safety layer for agent payments. Valid is not the same as safe.

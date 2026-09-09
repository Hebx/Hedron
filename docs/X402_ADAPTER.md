# x402 Adapter (Hedera-native)

> Status: **implemented and proven end-to-end on Hedera testnet.** `src/settlement/x402/` ships a working `PaymentAdapter`, wire codec, facilitator client, and client-side payer. 31 offline unit tests (incl. drift guards against the real `@x402/hedera@2.20.0` constants) plus `npm run e2e:x402:testnet`, which passes **12/12 including real on-chain settlement** against Blocky402's testnet facilitator — a real `TransferTransaction` verified, settled, and confirmed SUCCESS on the mirror node.

x402 is the HTTP-native pay-per-request standard built on the `402 Payment Required` status code. Hedera ships a native **`exact` scheme**: the client builds a *partially signed* `TransferTransaction` (HBAR or HTS), the facilitator sponsors the fee and submits it, and settlement is confirmed on-chain.

Hedron treats x402 as a first-class settlement rail (`x402`) alongside `hedera-hbar` and `hedera-hts`. Rail selection happens per quote from `quote.pricing` plus policy.

**Hedron custodies nothing on this rail.** The client signs the transfer with its own key, the facilitator pays fees and submits. Hedron's job is to bind the payment to a *verified quote* and anchor the on-chain result into a receipt.

## Canonical sources

Pinned during implementation — earlier drafts of this doc cited the wrong repo.

- Spec repo: <https://github.com/x402-foundation/x402> (`specs/schemes/exact/scheme_exact_hedera.md`). `coinbase/x402` also resolves but `x402-foundation` is canonical.
- Packages: `@x402/hedera@2.20.0`, `@x402/core@2.20.0` (both optional peer deps). The unscoped `x402` package is a stale v1 line — do not use it.
- Hedera docs: <https://docs.hedera.com/solutions/ai/x402>
- Networks are CAIP-2 (`hedera:testnet`, `hedera:mainnet`), not short names, on the wire.

## Module layout

| File | Responsibility | Keys / network |
| --- | --- | --- |
| `wire.ts` | x402 v2 wire types + `X-PAYMENT` base64 encode/decode | none |
| `mapping.ts` | Hedron ⇄ x402 mapping, CAIP-2 conversion, requirement matching | none (pure) |
| `facilitator.ts` | Facilitator HTTP client — `/supported`, `/verify`, `/settle` | network only |
| `adapter.ts` | `PaymentAdapter` implementation (`X402HederaAdapter`) | network only |
| `client.ts` | Client-side payer (`X402HederaPayer`) | **only module touching a private key** |

The key-handling surface is deliberately confined to `client.ts` so the adapter, mapping, and facilitator client all stay key-free and testable without credentials.

## Rails table

| Rail id | Scheme | Network | Status |
| --- | --- | --- | --- |
| `hedera-hbar` | native HBAR transfer | testnet | type surface only, mock settles |
| `hedera-hts` | HTS fungible token transfer | testnet | type surface only, mock settles |
| `x402` | x402 exact scheme via configured facilitator | testnet | **HBAR proven on live facilitator; HTS unproven; not yet wired through Broker + HCS** |
| `evm-usdc` | direct ERC-20 transfer | EVM | optional, not implemented |

## Client payer contract

`X402HederaPayer.buildPaymentHeader()` follows the scheme spec exactly:

1. Build a **direct** `TransferTransaction` — never `ScheduleCreate`-wrapped.
2. Debit self and credit `payTo` by exactly `amount` of `asset`.
3. Set the transaction id's account to `extra.feePayer` so the *facilitator* is the network-level fee payer. This is the counter-intuitive step: the transaction id belongs to the facilitator even though the payer is the one sending value.
4. Freeze and sign — yielding a *partially* signed transaction, missing the fee payer's signature.
5. Base64 the serialized bytes into `payload.transaction`.

Amounts stay in base units end to end. HBAR goes through `Hbar.fromTinybars(string)` and HTS amounts are passed to `addTokenTransfer` as `bigint`; nothing round-trips through a float, since that is a silent way to pay the wrong amount.

## Adapter behaviour

`X402HederaAdapter` is deliberately asymmetric with `MockPaymentAdapter`: **it cannot fabricate a settlement.**

- `createPaymentRequirement` requires fixed pricing (`fixed-hbar` or `fixed-hts`); anything else throws `X402MappingError('unsupported_pricing')`.
- `feePayer` is preferred from config and otherwise discovered from the facilitator's `/supported` response.
- `settlePayment` rejects a repeated `paymentId` with `ReplayDetectedError`, decodes the `X-PAYMENT` header, asserts the wire requirements match Hedron's requirement (`assertRequirementsMatch`), then calls `/settle`. It returns only what the facilitator actually confirmed.
- A failed settlement raises `X402FacilitatorError` carrying the facilitator's own `errorReason`.
- `settlementHash` binds scheme, network, transaction, payer, amount, asset, `payTo`, `quoteHash`, `actionHash`, and `correlationId` — so a receipt cannot be re-pointed at a different payment.

## Facilitator configuration

The facilitator is **swappable**. Hedron assumes no single operator; any facilitator implementing the published exact scheme works.

```
HEDRON_X402_FACILITATOR_URL=
HEDRON_X402_FACILITATOR_API_KEY=
HEDRON_X402_NETWORK=testnet
```

When `HEDRON_X402_FACILITATOR_URL` is empty the `x402` rail is disabled.

### Known-good testnet facilitator

Blocky402 runs an open-access Hedera **testnet** facilitator — no API key. Verified live 2026-07-31:

| | Value |
| --- | --- |
| Base URL | `https://api.testnet.blocky402.com` |
| Advertised fee payer | `0.0.7162784` |
| Networks | `hedera:testnet` (also `eip155:80002`, a Solana devnet) |

**Watch the host.** `https://api.blocky402.com` (no `testnet.`) also answers `200` but advertises **`hedera:mainnet`** with a *different* fee payer (`0.0.10571514`). Pointing a testnet run at the mainnet host is a silent misconfiguration — `/supported` succeeds, then every payload is rejected for the wrong network. Mainnet requires an API key. Two other plausible hostnames (`facilitator.blocky402.com`, `x402.blocky402.com`) do not resolve.

## Live verification

```bash
npm run e2e:x402:testnet
```

Two tiers, so the credential-free part is always runnable:

**Tier A (no credentials, 6 checks, currently 6/6 green)** — `/supported` reachable and advertising `hedera:testnet`; our `feePayerFor()` and `supportsHederaNetwork()` agree with it; the mirror node confirms the advertised fee-payer account exists; the adapter builds a `PaymentRequirement` off the discovered fee payer; and the facilitator **rejects a malformed payload** (`invalid_exact_hedera_payload_transaction_could_not_be_decoded`). That last check is the important one — it proves `/verify` is genuinely round-tripping rather than being stubbed out.

**Tier B (needs `HEDERA_OPERATOR_ID` + `HEDERA_OPERATOR_KEY`, funded testnet — 6/6 green)** — builds and signs a real `TransferTransaction` via `X402HederaPayer`, asserts the tx-id account is the fee payer, `/verify`s it, settles it on-chain through the adapter, polls the mirror node for consensus, runs `verifySettlementReceipt` against the real settlement, and asserts a replay is rejected *by Hedron* before reaching the facilitator. Amount is 100 tinybar (0.000001 HBAR), so a real run costs ~nothing.

A confirmed run's on-chain transfers, read back from the mirror node — note the facilitator paying the fee while the payer moves only the quoted amount:

```
payer      0.0.9050506    -100 tinybar
payTo      0.0.98         +100 tinybar
feePayer   0.0.7162784  -292737 tinybar   (network fee, sponsored)
node       0.0.802      +292737 tinybar
result: SUCCESS
```

### Three failure modes this probe caught

All three were found only by real execution — the 31 unit tests pass regardless.

1. **`tx.freeze()` is not sufficient.** Freezing needs real node account ids; a bare `freeze()` throws `"transaction must have been frozen before calculating the hash"` at signing time even with the transaction id already set. Use `freezeWith(client)` — it supplies the address book, submits nothing, and needs no operator, so offline construction still works. The reference `@x402/hedera` client does the same. Hence `X402PayerOptions.network`.
2. **Self-payment reads as an amount mismatch.** If `payTo` equals the payer, the two transfers net to zero and the facilitator rejects with `invalid_exact_hedera_payload_amount_mismatch`. Pay a distinct recipient.
3. **Sign the adapter's own wire requirements, never a hand-rolled copy.** `maxTimeoutSeconds` is derived from quote expiry *relative to now*, so any hardcoded value drifts and `/settle` fails with `accepted_payment_requirements_mismatch`. The payload's `accepted` block must match what the adapter presents. Use `adapter.toWireRequirements(requirement)`.

Also worth knowing: `settlement.settlementHash` and `receipt.record` are **deliberately different hashes** — the former binds the full quote/action/correlation context, the latter is the narrow cross-rail settlement identity. Passing one where the other belongs makes `recordMatches` fail correctly. Get a receipt from `produceSettlementReceipt()` rather than assembling one.

## Verification invariants

- The on-chain transfer amount, asset, and recipient MUST match the `paymentRequirement`. Any mismatch fails the verifier and aborts the flow.
- `verifySettlementReceipt` runs `railMatches`, `recordShape`, `known`, `recordMatches`, and `networkMatches`. An unrecognised `settlementId` fails closed with `known: false`.
- The receipt's `settlementRef` carries the on-chain tx id and the facilitator id; both are independently auditable.

## Known gaps

- The adapter has no mirror-node read-back of its own, so `receipt.verification.mirrorHints` stays empty and confirmation depends on the facilitator's response. The probe polls the mirror node directly and proves the data is there; the adapter should do so itself. This is what blocks the Audit-Trail-v1 "explorer-verifiable" bullet.
- HBAR is proven on-chain; **HTS settlement is not.** The code path exists and is unit-tested, but no live HTS run has happened (needs an associated token). Nothing suggests it is broken — it is simply unproven.
- Refund/dispute hooks are not implemented on this rail.
- No mainnet path. Testnet-only per the repo charter.

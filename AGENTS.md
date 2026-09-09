# AGENTS.md — Hedron (agent harness)

*Implementation agent bootstrap for the Hedron SDK. Deep design: `docs/ARCHITECTURE.md`.*

## Role

**Hedron** = Hedera-native agentic commerce SDK + Router/Broker runtime.

Canonical loop: `discover → quote → policy → pay → execute → receipt`

HCS is the source of truth — do not claim success without verifiable receipts.

## Tooling

- **Runtime:** Node 20+, npm 10+
- **Tests:** Vitest — `npm test` (unit under `tests/unit/`)
- **Lint:** `npm run lint` · **Build:** `npm run build`
- **Demo:** `demo/local.ts`, `demo/testnet.ts`

## Codebase map

See **`docs/CODEBASE.md`** before broad grep. Unconventional Hedera/x402 surface — map first.

## Module guide

| Path | Responsibility |
|------|----------------|
| `src/router/` | Intent routing, quote fan-out (no settle/execute) |
| `src/broker/` | Flow lifecycle, idempotency, receipt issuance |
| `src/policy/` | Default-deny policy engine |
| `src/settlement/` | HBAR / HTS / x402 / EVM rails |
| `src/receipts/` | Verifiable receipt schema + verifier |
| `src/hcs/` | HCS audit topic emit/query |
| `src/registry/` | Agent cards / capability index |
| `src/adapters/` | Daydreams, Hedera Agent Kit, MCP |

## Harness rules

- **Simplicity first** — match existing module boundaries; adapters stay at edges.
- **Verify before done** — `npm test` + affected unit path; report output.
- **Surgical edits** — v0.2 APIs may change until tagged; update docs when behavior shifts.
- **No mainnet claims** — testnet-first unless explicitly chartered.

## Navigation

- Filesystem tools for code in `src/` and `tests/`
- Architecture truth: `docs/ARCHITECTURE.md`, `docs/ROUTER_BROKER.md`, `docs/HCS_RECEIPTS.md`
- Private hackathon notes: `docs/internal/` (if present)

## Security

- Never commit `.env`, keys, or operator credentials
- Smart contracts unaudited — no mainnet value without explicit review

## Definition of done

1. Change matches scope; tests pass for touched modules
2. Summary lists files, commands run, receipt/HCS implications if any
3. Durable lessons → this file § Learned or `docs/internal/`

## Learned

*(Append one-line bullets when corrected.)*

- **HAK v4 API: trust the tarball, not GitHub docs.** Upstream `main` markdown is ahead of published `4.0.0` and wrong in 4 ways: hooks/policies are NOT on the root export (use `/hooks`, `/policies` subpaths), hook signature is 2-arg `(params, method)` not 3-arg, `BaseTransactionTool` does not exist in 4.0.0, and `HederaLangchainToolkit` is a separate package. Full verified reference: `~/clawd/memory/2026-07-31-hak-v4-api-research.md`.
- HAK v4 tool fields are `method` (not `id`) and `parameters` (not `schema`); `Plugin.tools` is a **function** `(ctx) => Tool[]` and `Plugin` has no `id`/`policies`. Policies register on `configuration.context.hooks`.
- `BaseTool.shouldSecondaryAction()` **defaults to `true`** — always override to `false` for non-transaction tools, and never override `execute()` (it drives the hooks).
- Do NOT add a blanket `protobufjs` override. The old conflict (legacy `@hashgraph/sdk` v2 exact-pinning 7.5.4 vs `@hiero-ledger/sdk` resolving 8.6.6) was fixed properly by **removing `@hashgraph/sdk`** — see the bullet below. An override was always the wrong lever; it breaks `npm ls`.
- **`tx.freeze()` cannot be signed — use `freezeWith(client)`.** Freezing needs real node account ids, so a bare `freeze()` throws `"transaction must have been frozen before calculating the hash"` at `.sign()` even when `transactionId` is already set. `freezeWith(Client.forTestnet())` supplies the address book, submits nothing, and needs no operator, so offline payload construction still works. Only live execution catches this; unit tests never froze a real tx.
- **Live x402 settlement failure decoder.** `invalid_exact_hedera_payload_amount_mismatch` ⇒ payer and `payTo` are the same account, so the transfers net to zero — pay a distinct recipient. `accepted_payment_requirements_mismatch` ⇒ the signed `accepted` block differs from what the adapter sends to `/settle`; `maxTimeoutSeconds` is derived from expiry relative to *now*, so never hardcode it — sign `adapter.toWireRequirements(requirement)`.
- **`settlementHash` ≠ `receipt.record`.** Two deliberately different hashes: `settlementHash` binds the full quote/action/correlation context, `receipt.record` is the narrow cross-rail settlement identity. Use `produceSettlementReceipt()`; hand-building a receipt from `settlementHash` makes `recordMatches` fail (correctly).
- **`@hashgraph/sdk` was dead weight** — imported nowhere (comments only) while pulling the critical `protobufjs` and high `@grpc/grpc-js` chains. Removing it cleared ~12 advisories and fixed the `npm ls` protobuf conflict. Live code uses `@hiero-ledger/sdk`. Do not reintroduce it; see `docs/DEPENDENCY_AUDIT.md`.
- **`@hiero-ledger/sdk` `addTokenTransfer` takes `bigint` directly** — `amount: number | Long | BigNumber | bigint` on `AbstractTokenTransferTransaction`. Do NOT reach for `Long.fromString()`: `Long` is a UMD global in the SDK's type surface and referencing it in an ESM module is a `TS2686` build error that tests will not catch (vitest transpiles without typecheck — always run `npm run build` too).
- Quote trust boundary lives in `src/quotes/`. `BrokerDeps.quoteVerifier` is **required** by design so no broker can skip the gate. Two distinct checks needed: `quoteHashBinding` (identity) and `requirementConsistent` (terms) — the core hash excludes `paymentRequirement`, so binding alone cannot catch a price contradiction between `pricing` and `paymentRequirement`.

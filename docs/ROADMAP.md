# Roadmap

Versioned milestones. Each milestone has a tag and a definition of done. Until a tag exists in `git tag`, the milestone is in progress.

This roadmap tracks Hedron against the current Hedera surface area (May 2026):

- **Hedera Agent Kit v4** — modular packages from `@hashgraph/hedera-agent-kit/plugins`, `BaseTool` lifecycle, first-class hooks and policies. See [`HEDERA_AGENT_KIT_PLUGIN.md`](HEDERA_AGENT_KIT_PLUGIN.md).
- **Hedera x402** — native `exact` scheme: partially signed `TransferTransaction` (HBAR or HTS), facilitator pays gas and submits, on-chain settlement. See [`X402_ADAPTER.md`](X402_ADAPTER.md).
- **HCS-10 / OpenConvAI** — production discovery and messaging standard for Hedera-resident agents.
- **Hiero SDKs** — forward-looking SDK target; the legacy `@hashgraph/sdk` migrates into `@hiero-ledger/sdk`. See [`DEPENDENCY_HARDENING.md`](DEPENDENCY_HARDENING.md).

Hedron tracks these surfaces rather than wrapping them, so every milestone maps to one external surface plus the corresponding Hedron interface.

---

## `v0.2.0-alpha.0` — cleanup + skeleton ✅

Hedron's v0.2 foundations are in place.

- Public repo is review-friendly: no generated artifacts, no clutter, no leaked secrets.
- Type surface (`src/types/`), errors (`src/errors/`), and config loader (`src/config/`) are landed.
- Router and Broker run the canonical loop end-to-end against in-memory mocks: discover → quote → policy → pay → execute → receipt → verify.
- Policy engine: pure evaluator + auditable decision events, stable hash of decisions.
- HCS receipt schema v1 + verifier. Six checks: schema, signature, chain integrity, anchoring, policy + settlement consistency, terminal status.
- Adapter interfaces defined for Daydreams, Hedera Agent Kit v4, x402.
- 27/27 unit tests green; CI runs typecheck, lint, mocked end-to-end demo, build, gitleaks (working tree + full history), `npm audit` (warn-only).

DoD: tag `v0.2.0-alpha.0`. Released as PR #6 on 2026-05-19.

---

## `v0.2.0-alpha.1` — quote-verification + HAK v4 plugin ✅

Defensive slice plus the first real ecosystem integration. Locks the contract between Router and Broker so a quote cannot be silently swapped or accepted after expiry, and lands the Hedera Agent Kit v4 plugin against the real published API.

Quote verification (`src/quotes/`):

- `Broker.runFlow` verifies `quote.signature` against the registered agent identity before policy. Mismatched signatures fail closed with a typed `QuoteSignatureError`. The verifier is a **required** `BrokerDeps` field, so a broker cannot be constructed that skips the gate.
- `Broker.runFlow` checks `quote.expiresAt` and `paymentRequirement.expiresAt` against `now()`. Expired quotes fail closed with `QuoteExpiredError`.
- Router stamps `paymentRequirement.quoteHash` **before** signing the quote, so the quote signature binds the payment requirement to the action.
- A `requirementConsistent` check rejects a requirement whose `rail`, `amount`, `actionHash` or `correlationId` contradicts the quote — the core hash pins quote *identity*, this pins quote *terms*, so a signing agent cannot advertise one price to the policy engine and demand another from settlement.
- `QUOTE_VERIFIED` HCS event carries the per-check outcome and is emitted **even on failure**, so a rejected quote still leaves an auditable trace. Its hash is anchored into the receipt as `quoteVerificationHash` and enforced by a 7th verifier check (`quoteVerified`) that also requires `QUOTE_RECEIVED → QUOTE_VERIFIED → POLICY_EVALUATED` ordering.

Hedera Agent Kit v4 plugin (`src/adapters/hedera-agent-kit/`):

- Six `BaseTool` subclasses (`hedron_list_agents`, `hedron_get_quote`, `hedron_approve_quote`, `hedron_pay`, `hedron_verify_receipt`, `hedron_get_audit_trail`) built against the shipped `@hashgraph/hedera-agent-kit@4.0.0` surface.
- Policy bridge exposing Hedron's engine through HAK's four lifecycle stages, registered on `configuration.context.hooks` (HAK v4 has no plugin-level `policies` field).
- `HedronCommercePort` seam with an in-process implementation driving the real Router + Broker, so `hedron_pay` runs the full verified flow rather than settling directly.
- HAK, `@hiero-ledger/sdk` and zod are **optional peer dependencies**. Live Hedera I/O uses `@hiero-ledger/sdk`. Do not reintroduce `@hashgraph/sdk`.
- `npm run example:hak` runs the loop offline (no credentials) including a policy-deny path.

Also in this slice (not originally in the alpha.1 sketch): Hedera x402 exact HBAR rail proven against a live testnet facilitator (`npm run e2e:x402:testnet`). That is a rail probe — it does not yet run through `Broker.runFlow` or write HCS.

Verified on `main` (PR #11): unit tests green, lint clean, build clean, `demo:local` reports all receipt checks passing, `npm audit` 0 critical. Docs: [`ROUTER_BROKER.md`](ROUTER_BROKER.md), [`HEDERA_AGENT_KIT_PLUGIN.md`](HEDERA_AGENT_KIT_PLUGIN.md), [`X402_ADAPTER.md`](X402_ADAPTER.md).

Breaking change: `VerifiableReceipt` gains a required `quoteVerificationHash`, so alpha.0 receipts do not validate against the new verifier.

DoD: tag `v0.2.0-alpha.1`. Code is on `main`; the git tag is still pending.

---

## `v0.2.0-alpha.2` — Hedera surface bring-up on testnet

Replace the mock HCS emitter and the first real settlement adapter with testnet implementations. This is the first milestone that touches the network.

- **Real HCS emission**: drop-in `HieroHcsEmitter` publishes commerce-loop events to a configured audit topic. The audit topic is provisioned at first boot when missing and pinned afterwards.
- **HBAR settlement adapter** (`src/settlement/hedera/`): partially signed `TransferTransaction` builder + verifier helper. Operator key never leaves the broker process. Per-quote cap and per-window spend cap enforced via the policy engine.
- **Mirror-node verification**: the receipt verifier reads the configured Hedera public mirror node (overridable via `HEDERA_MIRROR_NODE_URL`) and confirms each commerce-loop event is on-chain before the receipt is issued.
- **HAK v4 policy bridge**: Hedron's policy decisions are exposed as a HAK v4 policy object so a HAK-driven agent uses the same allow / deny / approval semantics across the four BaseTool lifecycle stages.
- **`npm run demo:testnet`** runs end-to-end against Hedera testnet using a HAK v4 agent, emits a verifiable receipt, and prints a public mirror-node URL for the audit topic.

DoD: tag `v0.2.0-beta.0`. `demo:testnet` succeeds; the receipt verifier confirms each event against the mirror; HAK v4 policy hooks observably gate one allow and one deny case.

---

## `v0.2.0-beta.1` — x402 through the Broker

The exact-scheme adapter and live HBAR probe already exist (see alpha.1). This milestone is the missing product loop: a paywalled Hedron endpoint settled through `Broker.runFlow` with an HCS-anchored receipt.

- One metered Hedron HTTP route returns `402`; a HAK v4 agent pays via `X402HederaPayer`.
- `Broker.runFlow` binds the verified quote, policy decision, on-chain settlement, and HCS event range into one receipt.
- Adapter `verifySettlement` reads the transfer from the public mirror (not only the facilitator response). `receipt.settlementRef` carries the tx id and facilitator id.
- Facilitator URL stays per-environment (`HEDRON_X402_FACILITATOR_URL`). Hedron does not assume a single operator.

DoD: tag `v0.2.0-beta.1`. End-to-end x402 metered fetch succeeds on Hedera testnet; the receipt verifier confirms the transfer against the mirror; a HashScan link for the settlement tx is printed.

---

## `v0.2.0` — production-grade testnet release

Hedron is publicly usable on Hedera testnet without operator hand-holding.

- Router HTTP service runs from a published Docker image with structured logs and a documented deployment recipe.
- Operator-key rotation procedure is documented; receipts survive rotation via the `policyDecisionHash` and `agentId` chain.
- `p95` latency target met for the canonical loop against testnet: `< 4 s` for the mock-execute happy path; `< 8 s` for an x402 paywalled fetch.
- HCS-10 / OpenConvAI discovery: agents in the registry are addressable by their HCS-10 inbox; the loop emits one HCS-10 message per stage so external observers can subscribe.
- Public showcase: one Hedera Agent Kit v4 plugin example and one Daydreams adapter example run the same loop and produce identical verifiable receipts.

DoD: tag `v0.2.0`. The deployed Router handles 100 sequential and 20 concurrent commerce loops on Hedera testnet, all with verifiable receipts and a public mirror trail.

---

## `v0.3.0` — adapter expansion

- **MCP server** exposing the Hedron tool surface (`discover` / `quote` / `pay` / `verify`) over the Model Context Protocol so MCP-aware agent runtimes can consume Hedron directly. MCP is now a widely adopted standard for connecting AI agents to tools (2026).
- **Daydreams runtime** sandbox integration tests against the Lucid Agents Commerce SDK (Daydreams' SDK already speaks x402, A2A, and ERC-8004 natively, so the adapter bridges those into Hedron's HCS-anchored receipt flow).
- **ERC-8004 identity**: optional attestation reference attached to receipts for cross-chain agent flows.

DoD: tag `v0.3.0`. MCP server reachable from at least one MCP-aware host, Daydreams adapter passes the integration suite, an ERC-8004-attested receipt verifies end-to-end.

---

## `v0.4.0` — governance + trust

- Policy registry on HCS: policies are **published**, not just executed; a `POLICY_REGISTERED` event makes the policy auditable independently of any flow.
- Operator-key rotation events on a dedicated HCS topic; the verifier walks rotations transparently.
- Trust / reputation primitives on Hedera, consumed by Hedron's policy engine as an external input. The TrustScore Oracle (`Hebx/trustscore-oracle`) is one such input, kept as a separate project.

DoD: tag `v0.4.0`. Three policies published through the registry; one rotation walked end-to-end; one third-party trust input wired into a policy rule.

---

## `v0.5.0` — verifiable compute

- Optional verifiable-compute adapter: TEE attestation or ZK-attached proof on selected adapters.
- Receipts include attestation references when the adapter is enabled.
- Plug-in seam for Hedera-side or external attestation services.

DoD: tag `v0.5.0`. One attestation path runs end-to-end and produces a receipt whose verifier reports the attestation as part of `chain integrity`.

---

## More to come

Further phases are being researched (registry depth, broader chain support, and a public agent marketplace UI consuming Hedron). Each new phase will be added here only once the corresponding external surface is stable enough to commit to.

---

## Sources referenced by this roadmap

- Hedera Agent Kit v4 release: <https://hedera.com/blog/hedera-agent-kit-v4-policies-modular-packages-and-plugin-updates/>
- Hedera Agent Kit v4 source: <https://github.com/hashgraph/hedera-agent-kit-js>
- Hedera x402 announcement (Feb 2026): <https://hedera.com/blog/hedera-and-the-x402-payment-standard/>
- x402 specs (Coinbase): <https://github.com/coinbase/x402>
- HCS-10 / OpenConvAI — Hashgraph Online standards: <https://github.com/hashgraph-online/standards-agent-kit>, <https://hashgraphonline.com/>
- Hedera native developer path: <https://docs.hedera.com/hedera/getting-started-hedera-native-developers>
- Hedera Agent Lab: <https://portal.hedera.com/agent-lab>
- Lucid Agents (Daydreams) Commerce SDK: <https://github.com/daydreamsai/lucid-agents>, <https://docs.daydreams.systems/>

Each milestone has a tag and a definition of done. Until a tag exists in `git tag`, the milestone is in progress.

# Hedera Agent Kit v4 Plugin

> Status: **implemented** in `src/adapters/hedera-agent-kit/`. Six `BaseTool` subclasses + a policy bridge, exercised by 16 tests and a runnable example (`npm run example:hak`).

Hedron's plugin exposes the commerce loop as HAK v4 tools, with policy hooks that mirror Hedron's own policy engine. A HAK agent gains the discover → quote → policy → pay → execute → receipt loop with a small tool surface and automatic guardrails.

## API accuracy note

Every API shape below was verified against the **shipped `@hashgraph/hedera-agent-kit@4.0.0` type declarations plus a runtime smoke test**. Do not "fix" this document against the upstream markdown docs on GitHub `main` — that documentation is ahead of the published 4.0.0 release and is wrong in at least four specific ways, listed in [Upstream doc traps](#upstream-doc-traps). An earlier revision of this file guessed the API from those docs and was wrong on 6 of 8 points.

## Installation

HAK is an **optional peer dependency**. Importing `hedron` does not pull HAK in. Live Hedera I/O uses `@hiero-ledger/sdk`. Do not reintroduce `@hashgraph/sdk`.

```json
{
  "peerDependencies": {
    "@hashgraph/hedera-agent-kit": "^4.0.0",
    "@hiero-ledger/sdk": "^2.81.0",
    "zod": "^3.25.76"
  }
}
```

`zod` must be **3.x** — HAK 4.0.0 pins `zod@3.25.76`. Zod 4 schemas will not work in tool `parameters`.

## Tool surface (intentionally minimal)

Six tools, named with `snake_case` `method` ids (the strings an agent dispatches on):

| `method` | Purpose | Moves value |
| --- | --- | --- |
| `hedron_list_agents` | List provider agents matching a capability filter. | no |
| `hedron_get_quote` | Request a signed quote; reports whether it passed verification. | no |
| `hedron_approve_quote` | Record a HITL approval for a policy-gated quote. | no |
| `hedron_pay` | Run the full broker flow and issue a receipt. | **yes** |
| `hedron_verify_receipt` | Verify a receipt against the HCS chain (7 checks). | no |
| `hedron_get_audit_trail` | Read the ordered HCS event chain for a flow. | no |

`hedron_pay` deliberately does not settle directly — it calls `Broker.runFlow`, so quote verification, policy evaluation, settlement and receipt issuance all apply unchanged.

## Architecture

```
HAK v4 host (LangChain / MCP / ai-sdk / ElizaOS)
        │  configuration = { plugins: [hedronPlugin], context: { hooks } }
        ▼
src/adapters/hedera-agent-kit/
  index.ts       buildHedronPlugin() · buildHedronHooks() · buildHedronConfiguration()
  tools.ts       6 BaseTool subclasses
  policies.ts    AbstractPolicy / AbstractHook bridge onto Hedron's policy engine
  deps.ts        HedronCommercePort — the narrow port the tools talk to
  localPort.ts   in-process port backed by a live Router + Broker
        ▼
Router · Broker · policy engine · quote verifier · HCS emitter
```

`HedronCommercePort` is the seam: `LocalHedronCommercePort` runs everything in-process today, and an HTTP-backed port can replace it without touching the tools.

## Defining a tool (real v4 shape)

```ts
import { BaseTool } from '@hashgraph/hedera-agent-kit'
import { z } from 'zod'   // 3.x

const params = z.object({ quoteId: z.string() })

class HedronPayTool extends BaseTool<z.infer<typeof params>, z.infer<typeof params>> {
  method = 'hedron_pay'      // identity field is `method`, NOT `id`
  name = 'Hedron Pay'
  description = 'Runs the Hedron commerce flow for a quote.'
  parameters = params        // zod schema field is `parameters`, NOT `schema`

  async normalizeParams(p) { return p }                  // stage 2
  async coreAction(np) { /* real work here */ }          // stage 4
  async shouldSecondaryAction() { return false }         // DEFAULT IS TRUE — must override
  async secondaryAction(r) { return r }                  // abstract; required even if unused
}
```

Key constraints:

- **`execute()` is implemented by `BaseTool`** and drives the hook lifecycle. Overriding it loses hooks and policies. Implement `normalizeParams` / `coreAction` / `secondaryAction` instead.
- **`shouldSecondaryAction()` defaults to `true`.** Every Hedron tool completes its work in `coreAction`, so all six override it to `false` via a shared `HedronTool` base. Forgetting this runs the secondary stage against a bogus request object.
- **Errors never escape `execute()`.** `BaseTool.handleError` converts a throw into `{ raw: { error }, humanMessage }`. That is why each Hedron tool returns an explicit `ok` flag in `raw` rather than relying on exceptions.
- `BaseTransactionTool` **does not exist in 4.0.0** despite upstream `PLUGINS.md` telling you to extend it. For a transaction tool, extend `BaseTool` and use the exported `handleTransaction` inside `secondaryAction`.

## Building and registering the plugin

```ts
import { ToolDiscovery, AgentMode } from '@hashgraph/hedera-agent-kit'
import { buildHedronPlugin, buildHedronHooks } from 'hedron/adapters/hedera-agent-kit'

const plugin = buildHedronPlugin(deps)

// Hooks AND policies both go here — there is NO plugin-level `policies` field.
const context = {
  mode: AgentMode.AUTONOMOUS,
  hooks: buildHedronHooks(deps, { allowedRoles: ['user'], maxAmountTinybar: '500000000' }),
}

const configuration = { plugins: [plugin], context }   // plugins are explicit in v4
const tools = ToolDiscovery.createFromConfiguration(configuration).getAllTools(context, configuration)
```

The real `Plugin` type is:

```ts
type Plugin = {
  name: string                              // identity field — NOT `id`
  version?: string
  description?: string
  tools: (context: Context) => Tool[]       // a FUNCTION — not an array
}
```

For a LangChain host, the toolkit lives in a **separate npm package**:

```ts
import { HederaLangchainToolkit } from '@hashgraph/hedera-agent-kit-langchain'  // v1.0.0
const toolkit = new HederaLangchainToolkit({ client, configuration: { plugins: [plugin], context } })
```

`configuration.tools` is an optional **allowlist of `method` strings**; omit it to expose everything from the listed plugins.

## Policies (HAK hooks → Hedron policy engine)

Hedron's policy engine remains the single source of truth. The bridge classes translate HAK lifecycle calls into Hedron policy questions.

The full lifecycle is 7 steps, of which **4 are hookable**. There is **no enum** — stages are identified by method name only:

| # | Hook method | Policy block method | Hedron use |
| --- | --- | --- | --- |
| 1 | `preToolExecutionHook` | `shouldBlockPreToolExecution` | reject disallowed `caller.role` |
| 3 | `postParamsNormalizationHook` | `shouldBlockPostParamsNormalization` | per-call spend cap; block unverified quotes |
| 5 | `postCoreActionHook` | `shouldBlockPostCoreAction` | available; unused today |
| 7 | `postToolExecutionHook` | `shouldBlockPostSecondaryAction` | append spend-tracking entries |

Note the asymmetry in upstream naming: the stage-7 hook is `postToolExecutionHook` but its policy counterpart is `shouldBlock**PostSecondaryAction**`, and its params type is `PostSecondaryActionParams`.

Hedron ships:

- `HedronCallerRolePolicy` — stage 1 role gate.
- `HedronSpendCapPolicy` — stage 3 per-call cap; **fails closed** on an unknown quote id.
- `HedronQuoteVerifiedPolicy` — stage 3 mirror of the broker's `QUOTE_VERIFIED` gate.
- `HedronSpendTrackingHook` — observes all four stages, never blocks.

Registration rules that differ from the old design:

- Hooks and policies both go in **`configuration.context.hooks: AbstractHook[]`**, because `AbstractPolicy extends AbstractHook`. Nothing is registered on the plugin.
- Hook methods take **two arguments, `(params, method)`**. The `context` is *inside* `params`.
- Every hook is called for **every** tool; filtering on `relevantTools` is the hook's own responsibility. Hedron's classes all do this filtering.
- A policy returns `true` from `shouldBlock*` to **block**. Do not override the `*Hook` methods on a policy — the base class calls your `shouldBlock*` and throws.
- Concrete built-ins are **not** on the root export: use `@hashgraph/hedera-agent-kit/hooks` (`HcsAuditTrailHook`, `HolAuditTrailHook`) and `@hashgraph/hedera-agent-kit/policies` (`MaxRecipientsPolicy`, `RejectToolPolicy`).

### Known 4.0.0 inconsistency

The built-in core plugin tools are **not `BaseTool` instances at runtime** in 4.0.0 (`instanceof BaseTool === false`), which implies they do **not** fire hooks or policies. Hedron's own tools do extend `BaseTool` and demonstrably fire all four stages (asserted in `tests/unit/adapters/hedera-agent-kit.test.ts`). **Do not assume these policies cover core Hedera tools** — verify before relying on hook coverage for anything outside the Hedron surface.

## Upstream doc traps

Four places where GitHub `main` docs disagree with the shipped 4.0.0 package:

1. Hooks/policies imported from the package root — they are **only** on the `/hooks` and `/policies` subpaths; the root import yields `undefined`.
2. A 3-arg hook signature `(context, params, method)` — the real signature is **2-arg `(params, method)`**.
3. `extend BaseTransactionTool` — **that class is not in the 4.0.0 tarball.**
4. `HederaLangchainToolkit` imported from the core package — it is in **`@hashgraph/hedera-agent-kit-langchain`**.

## Example

`npm run example:hak` (`examples/hak-v4-buyer/index.ts`) runs offline — no credentials, no network. It registers the plugin explicitly, walks discover → quote → pay → verify → audit, prints the 11-event HCS chain and all 7 receipt checks, then demonstrates a policy **deny** by capping spend at 0.5 HBAR against a 1 HBAR quote.

## Tests

`tests/unit/adapters/hedera-agent-kit.test.ts` (16 tests) executes tools through the **real** HAK runtime via `ToolDiscovery`, asserting: the v4 plugin shape (`name`, `tools` as a function, no `id`/`policies`), `BaseTool` instance identity, the `configuration.tools` allowlist, all four lifecycle stages firing in order, spend-cap allow **and** deny, the role gate, and fail-closed on an unknown quote id.

## Status

- v0.2.0-alpha.1: six `BaseTool` tools + policy bridge + local port, 16 tests, offline example. ✅
- v0.2.0: same loop against Hedera testnet with a real HCS emitter and HBAR settlement.
- M6–M9 grant (Integrations v1): published as a versioned package with docs and examples, plus third-party HAK host compatibility tests and the MCP tool surface.

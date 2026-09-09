/**
 * Hedron policy engine ↔ HAK v4 hooks/policies bridge.
 *
 * Hedron's policy engine stays the single source of truth; these classes are
 * thin translators so a HAK-driven agent inherits the same default-deny
 * posture without re-implementing rules.
 *
 * API notes verified against `@hashgraph/hedera-agent-kit@4.0.0`:
 *
 *  - Hooks AND policies are both registered on `configuration.context.hooks`
 *    (an `AbstractHook[]`), because `AbstractPolicy extends AbstractHook`.
 *    There is NO plugin-level `policies` field and no separate config key.
 *  - Hook methods take TWO args: `(params, method)`. `context` lives inside
 *    `params`, not as a separate first argument. Upstream markdown showing a
 *    3-arg `(context, params, method)` form is wrong for 4.0.0.
 *  - Every hook is invoked for every tool; filtering on `relevantTools` is the
 *    hook's own responsibility.
 *  - A policy returns `true` from `shouldBlock*` to BLOCK. Do not override the
 *    `*Hook` methods on a policy — the base class calls your `shouldBlock*`
 *    and throws on true.
 *  - The four stages are identified by method name only; no enum exists.
 *    Policy side: shouldBlockPreToolExecution, shouldBlockPostParamsNormalization,
 *    shouldBlockPostCoreAction, shouldBlockPostSecondaryAction.
 *
 * Caveat worth knowing: in 4.0.0 the built-in core plugin tools are not
 * `BaseTool` instances at runtime, so they appear not to fire hooks at all.
 * Hedron's own tools DO extend `BaseTool`, so these policies apply to the
 * Hedron surface. Do not assume they cover core Hedera tools.
 */

import { AbstractHook, AbstractPolicy } from '@hashgraph/hedera-agent-kit'
import type {
  PostCoreActionParams,
  PostParamsNormalizationParams,
  PostSecondaryActionParams,
  PreToolExecutionParams,
} from '@hashgraph/hedera-agent-kit'
import {
  HEDRON_SPENDING_TOOL_METHODS,
  HEDRON_TOOL_METHODS,
  hedronToolNames,
} from './tools'

/** The four hookable HAK v4 lifecycle stages, by their literal method names. */
export const HAK_LIFECYCLE_STAGES = [
  'preToolExecutionHook',
  'postParamsNormalizationHook',
  'postCoreActionHook',
  'postToolExecutionHook',
] as const

export type HakLifecycleStage = (typeof HAK_LIFECYCLE_STAGES)[number]

/**
 * Stage 1 — reject a tool call when the caller's role is not allowed.
 *
 * Mirrors Hedron's principle that the caller identity gates the loop before
 * any pricing or transaction shape is considered.
 */
export class HedronCallerRolePolicy extends AbstractPolicy {
  name = 'Hedron Caller Role Policy'
  description = 'Blocks Hedron tool calls from disallowed caller roles'
  relevantTools: string[]

  constructor(
    private readonly opts: {
      allowedRoles: Array<'user' | 'app' | 'agent'>
      relevantTools?: string[]
    },
  ) {
    super()
    this.relevantTools = opts.relevantTools ?? [...HEDRON_TOOL_METHODS]
  }

  protected override shouldBlockPreToolExecution(
    params: PreToolExecutionParams,
    method: string,
  ): boolean {
    if (!this.relevantTools.includes(method)) return false
    const caller = (params.rawParams as { caller?: { role?: string } } | undefined)?.caller
    // No caller on the call → nothing to reject here; the Hedron policy engine
    // still evaluates the configured default caller inside the broker flow.
    if (caller?.role === undefined) return false
    return !this.opts.allowedRoles.includes(caller.role as 'user' | 'app' | 'agent')
  }
}

/**
 * Stage 2 — cap spend before a transaction is formed.
 *
 * Reads the normalized params of a spending tool. Because Hedron's own broker
 * re-evaluates the full rule set during `pay`, this is defence in depth: it
 * stops an over-cap call from reaching the broker at all, which keeps the
 * agent's tool transcript honest about what it was allowed to attempt.
 */
export class HedronSpendCapPolicy extends AbstractPolicy {
  name = 'Hedron Spend Cap Policy'
  description = 'Blocks Hedron payment tool calls above the configured per-call cap'
  relevantTools: string[]

  constructor(
    private readonly opts: {
      maxAmountTinybar: string
      /** Resolves a quote id to its amount; the plugin wires this to the port. */
      resolveAmountTinybar: (quoteId: string) => Promise<string | undefined> | string | undefined
      relevantTools?: string[]
    },
  ) {
    super()
    this.relevantTools = opts.relevantTools ?? [...HEDRON_SPENDING_TOOL_METHODS]
  }

  protected override async shouldBlockPostParamsNormalization(
    params: PostParamsNormalizationParams,
    method: string,
  ): Promise<boolean> {
    if (!this.relevantTools.includes(method)) return false
    const quoteId = (params.normalisedParams as { quoteId?: string } | undefined)?.quoteId
    if (quoteId === undefined) return false
    const amount = await this.opts.resolveAmountTinybar(quoteId)
    // Unknown quote → fail closed on a spending tool.
    if (amount === undefined) return true
    return BigInt(amount) > BigInt(this.opts.maxAmountTinybar)
  }
}

/**
 * Stage 3 — last check before the value-moving stage completes.
 *
 * Blocks a payment whose quote is not currently verifiable (bad signature,
 * unbound requirement, expired). This is the HAK-side mirror of the broker's
 * `QUOTE_VERIFIED` gate.
 */
export class HedronQuoteVerifiedPolicy extends AbstractPolicy {
  name = 'Hedron Quote Verified Policy'
  description = 'Blocks payment for a quote that does not pass Hedron quote verification'
  relevantTools: string[]

  constructor(
    private readonly opts: {
      isQuoteVerified: (quoteId: string) => Promise<boolean> | boolean
      relevantTools?: string[]
    },
  ) {
    super()
    this.relevantTools = opts.relevantTools ?? [...HEDRON_SPENDING_TOOL_METHODS]
  }

  protected override async shouldBlockPostParamsNormalization(
    params: PostParamsNormalizationParams,
    method: string,
  ): Promise<boolean> {
    if (!this.relevantTools.includes(method)) return false
    const quoteId = (params.normalisedParams as { quoteId?: string } | undefined)?.quoteId
    if (quoteId === undefined) return true
    return !(await this.opts.isQuoteVerified(quoteId))
  }
}

/** A single recorded lifecycle observation. */
export interface HedronSpendTrackEntry {
  stage: HakLifecycleStage
  method: string
  at: string
  detail?: Record<string, unknown>
}

/**
 * Stage 4 (and all stages) — spend tracking / audit hook.
 *
 * A plain `AbstractHook`, not a policy: it observes and never blocks. Records
 * an entry per stage so the agent's Hedron activity is auditable even when the
 * flow never reaches a receipt.
 */
export class HedronSpendTrackingHook extends AbstractHook {
  name = 'Hedron Spend Tracking Hook'
  description = 'Appends Hedron tool lifecycle entries to an in-memory audit log'
  relevantTools: string[]

  private readonly entries: HedronSpendTrackEntry[] = []

  constructor(opts: { relevantTools?: string[] } = {}) {
    super()
    this.relevantTools = opts.relevantTools ?? [...HEDRON_TOOL_METHODS]
  }

  log(): readonly HedronSpendTrackEntry[] {
    return this.entries
  }

  private record(stage: HakLifecycleStage, method: string, detail?: Record<string, unknown>): void {
    if (!this.relevantTools.includes(method)) return
    this.entries.push({
      stage,
      method,
      at: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  override async preToolExecutionHook(
    _params: PreToolExecutionParams,
    method: string,
  ): Promise<void> {
    this.record('preToolExecutionHook', method)
  }

  override async postParamsNormalizationHook(
    _params: PostParamsNormalizationParams,
    method: string,
  ): Promise<void> {
    this.record('postParamsNormalizationHook', method)
  }

  override async postCoreActionHook(
    _params: PostCoreActionParams,
    method: string,
  ): Promise<void> {
    this.record('postCoreActionHook', method)
  }

  override async postToolExecutionHook(
    params: PostSecondaryActionParams,
    method: string,
  ): Promise<void> {
    const raw = (params.toolResult as { raw?: Record<string, unknown> } | undefined)?.raw
    this.record('postToolExecutionHook', method, {
      ...(raw?.['ok'] !== undefined ? { ok: raw['ok'] } : {}),
      ...(method === hedronToolNames.PAY && raw?.['receiptId'] !== undefined
        ? { receiptId: raw['receiptId'], amount: raw['amount'] }
        : {}),
    })
  }
}

/**
 * The default Hedron hook set, ready for `configuration.context.hooks`.
 *
 * Order matters: hooks run sequentially in array order, so the tracking hook
 * goes last to observe whatever the policies allowed through.
 */
export function buildHedronPolicies(opts: {
  allowedRoles?: Array<'user' | 'app' | 'agent'>
  maxAmountTinybar?: string
  resolveAmountTinybar?: (quoteId: string) => Promise<string | undefined> | string | undefined
  isQuoteVerified?: (quoteId: string) => Promise<boolean> | boolean
}): AbstractHook[] {
  const hooks: AbstractHook[] = []
  if (opts.allowedRoles !== undefined) {
    hooks.push(new HedronCallerRolePolicy({ allowedRoles: opts.allowedRoles }))
  }
  if (opts.maxAmountTinybar !== undefined && opts.resolveAmountTinybar !== undefined) {
    hooks.push(
      new HedronSpendCapPolicy({
        maxAmountTinybar: opts.maxAmountTinybar,
        resolveAmountTinybar: opts.resolveAmountTinybar,
      }),
    )
  }
  if (opts.isQuoteVerified !== undefined) {
    hooks.push(new HedronQuoteVerifiedPolicy({ isQuoteVerified: opts.isQuoteVerified }))
  }
  hooks.push(new HedronSpendTrackingHook())
  return hooks
}

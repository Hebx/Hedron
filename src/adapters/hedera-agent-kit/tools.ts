/**
 * Hedron commerce tools as Hedera Agent Kit v4 `BaseTool` subclasses.
 *
 * API notes verified against the shipped `@hashgraph/hedera-agent-kit@4.0.0`
 * type declarations and a runtime smoke test — NOT from the upstream markdown
 * docs, which are ahead of the release in several places:
 *
 *  - identity field is `method` (not `id`); zod schema field is `parameters`
 *    (not `schema`)
 *  - `execute()` is implemented BY `BaseTool` and drives the hook lifecycle;
 *    subclasses implement `normalizeParams` / `coreAction` / `secondaryAction`
 *  - `shouldSecondaryAction()` DEFAULTS TO TRUE. Every Hedron tool completes
 *    its work in `coreAction`, so each one overrides it to `false`; forgetting
 *    this would run the secondary stage with a bogus request object.
 *  - `secondaryAction` is abstract, so it must be declared even when unused.
 *  - zod must be 3.x (HAK pins 3.25.76).
 *
 * Errors never escape `execute()` — `BaseTool.handleError` converts a throw
 * into `{ raw: { error }, humanMessage }`. Hedron's typed errors therefore
 * surface to the agent as text, which is why each tool returns an explicit
 * `ok` flag in `raw` rather than relying on exceptions.
 */

import { BaseTool } from '@hashgraph/hedera-agent-kit'
import { z } from 'zod'
import type { Client } from '@hiero-ledger/sdk'
import type { Context } from '@hashgraph/hedera-agent-kit'
import type { HedronPluginDeps } from './deps'

/** Tool `method` names — the strings an agent dispatches on. */
export const hedronToolNames = {
  LIST_AGENTS: 'hedron_list_agents',
  GET_QUOTE: 'hedron_get_quote',
  APPROVE_QUOTE: 'hedron_approve_quote',
  PAY: 'hedron_pay',
  VERIFY_RECEIPT: 'hedron_verify_receipt',
  GET_AUDIT_TRAIL: 'hedron_get_audit_trail',
} as const

export type HedronToolName = (typeof hedronToolNames)[keyof typeof hedronToolNames]

/** Every Hedron tool `method`, for hook/policy `relevantTools` wiring. */
export const HEDRON_TOOL_METHODS: readonly HedronToolName[] = Object.values(hedronToolNames)

/** Tools that move value — the ones a spend policy must gate. */
export const HEDRON_SPENDING_TOOL_METHODS: readonly HedronToolName[] = [
  hedronToolNames.PAY,
] as const

const RAIL = z.enum(['hedera-hbar', 'hedera-hts', 'x402', 'evm-usdc', 'mpp'])

const CALLER = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'app', 'agent']),
  })
  .optional()
  .describe('Identity the call is attributed to; defaults to the configured caller.')

/**
 * Base for Hedron tools: they are all single-stage (work happens in
 * `coreAction`), so the secondary stage is switched off in one place.
 */
abstract class HedronTool<TParams, TNormalised> extends BaseTool<TParams, TNormalised> {
  constructor(protected readonly deps: HedronPluginDeps) {
    super()
  }

  /** All Hedron tools finish in `coreAction`; never run the secondary stage. */
  override async shouldSecondaryAction(): Promise<boolean> {
    return false
  }

  /** Required abstract member. Unreachable while `shouldSecondaryAction` is false. */
  async secondaryAction(request: unknown): Promise<unknown> {
    return request
  }
}

// -----------------------------------------------------------------------------

const listAgentsParams = z.object({
  name: z.string().optional().describe('Exact capability name, e.g. "invoice.analyze".'),
  tags: z.array(z.string()).optional().describe('Capability must carry all of these tags.'),
  rails: z.array(RAIL).optional().describe('Only capabilities settling on one of these rails.'),
})

export class HedronListAgentsTool extends HedronTool<
  z.infer<typeof listAgentsParams>,
  z.infer<typeof listAgentsParams>
> {
  method = hedronToolNames.LIST_AGENTS
  name = 'Hedron List Agents'
  description =
    'List Hedron provider agents and their priced capabilities, optionally filtered by capability name, tags, or payment rail. Read-only; moves no value.'
  parameters = listAgentsParams

  async normalizeParams(params: z.infer<typeof listAgentsParams>) {
    return params
  }

  async coreAction(params: z.infer<typeof listAgentsParams>) {
    const { capabilities } = await this.deps.port.listAgents({
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.rails !== undefined ? { rails: params.rails } : {}),
    })
    const rows = capabilities.map((c) => ({
      capabilityId: c.id,
      agentId: c.agentId,
      name: c.name,
      description: c.description,
      tags: c.tags,
      pricing: c.pricing,
      allowedRails: c.allowedRails,
      adapterId: c.adapterId,
    }))
    return {
      raw: { ok: true, count: rows.length, capabilities: rows },
      humanMessage:
        rows.length === 0
          ? 'No Hedron capabilities matched that filter.'
          : `Found ${rows.length} capability/capabilities: ${rows
              .map((r) => `${r.name} (${r.capabilityId}) from ${r.agentId}`)
              .join('; ')}`,
    }
  }
}

// -----------------------------------------------------------------------------

const getQuoteParams = z.object({
  capabilityId: z.string().describe('Capability to be quoted, from hedron_list_agents.'),
  agentId: z.string().describe('Provider agent offering the capability.'),
  action: z.unknown().describe('The canonical action request the provider will execute.'),
  caller: CALLER,
})

export class HedronGetQuoteTool extends HedronTool<
  z.infer<typeof getQuoteParams>,
  z.infer<typeof getQuoteParams>
> {
  method = hedronToolNames.GET_QUOTE
  name = 'Hedron Get Quote'
  description =
    'Request a signed price quote from a Hedron provider agent for a capability. Returns the quote id, price, rail, expiry, and whether the quote passed Hedron verification. Moves no value.'
  parameters = getQuoteParams

  async normalizeParams(params: z.infer<typeof getQuoteParams>) {
    return params
  }

  async coreAction(params: z.infer<typeof getQuoteParams>) {
    const result = await this.deps.port.getQuote({
      capabilityId: params.capabilityId,
      agentId: params.agentId,
      action: params.action,
      ...(params.caller !== undefined ? { caller: params.caller } : {}),
    })
    const q = result.quote
    return {
      raw: {
        ok: result.verified,
        verified: result.verified,
        ...(result.failedCheck !== undefined ? { failedCheck: result.failedCheck } : {}),
        quoteId: q.quoteId,
        agentId: q.agentId,
        capabilityId: q.capabilityId,
        pricing: q.pricing,
        expiresAt: q.expiresAt,
        actionHash: q.actionHash,
        paymentRequirement: q.paymentRequirement,
      },
      humanMessage: result.verified
        ? `Quote ${q.quoteId} from ${q.agentId}: ${JSON.stringify(q.pricing)} on ${q.pricing.rail}, expires ${q.expiresAt}.`
        : `Quote ${q.quoteId} from ${q.agentId} FAILED verification (${result.failedCheck ?? 'unknown check'}) and must not be paid.`,
    }
  }
}

// -----------------------------------------------------------------------------

const approveQuoteParams = z.object({
  quoteId: z.string().describe('Quote to approve.'),
  approverId: z.string().describe('Identity granting the approval.'),
})

export class HedronApproveQuoteTool extends HedronTool<
  z.infer<typeof approveQuoteParams>,
  z.infer<typeof approveQuoteParams>
> {
  method = hedronToolNames.APPROVE_QUOTE
  name = 'Hedron Approve Quote'
  description =
    'Record a human-in-the-loop approval for a Hedron quote that policy gated behind an approval threshold. Does not itself pay.'
  parameters = approveQuoteParams

  async normalizeParams(params: z.infer<typeof approveQuoteParams>) {
    return params
  }

  async coreAction(params: z.infer<typeof approveQuoteParams>) {
    const out = await this.deps.port.approveQuote(params)
    return {
      raw: { ok: true, ...out },
      humanMessage: `Approval ${out.approvalId} recorded for quote ${out.quoteId}.`,
    }
  }
}

// -----------------------------------------------------------------------------

const payParams = z.object({
  quoteId: z.string().describe('Quote to pay. Must be verified and unexpired.'),
})

export class HedronPayTool extends HedronTool<
  z.infer<typeof payParams>,
  z.infer<typeof payParams>
> {
  method = hedronToolNames.PAY
  name = 'Hedron Pay'
  description =
    'Run the Hedron commerce flow for a quote: verify the quote, evaluate policy, settle payment, execute the capability, and issue a verifiable receipt. THIS MOVES VALUE.'
  parameters = payParams

  async normalizeParams(params: z.infer<typeof payParams>) {
    return params
  }

  async coreAction(params: z.infer<typeof payParams>) {
    const out = await this.deps.port.pay(params)
    return {
      raw: {
        ok: out.verification.ok,
        flowId: out.flowId,
        receiptId: out.receipt.receiptId,
        status: out.receipt.status,
        amount: out.receipt.amount,
        rail: out.receipt.rail,
        recipient: out.receipt.recipient,
        quoteVerificationHash: out.receipt.quoteVerificationHash,
        policyDecisionHash: out.receipt.policyDecisionHash,
        settlementHash: out.receipt.settlementHash,
        hcsTopicId: out.receipt.hcsTopicId,
        verification: out.verification,
      },
      humanMessage: `Flow ${out.flowId} ${out.receipt.status}; receipt ${out.receipt.receiptId} ${
        out.verification.ok ? 'verified' : 'FAILED verification'
      }.`,
    }
  }
}

// -----------------------------------------------------------------------------

const verifyReceiptParams = z.object({
  receiptId: z.string().describe('Receipt to verify against the HCS event chain.'),
})

export class HedronVerifyReceiptTool extends HedronTool<
  z.infer<typeof verifyReceiptParams>,
  z.infer<typeof verifyReceiptParams>
> {
  method = hedronToolNames.VERIFY_RECEIPT
  name = 'Hedron Verify Receipt'
  description =
    'Verify a Hedron receipt against its HCS event chain: schema, signature, chain integrity, anchoring, quote verification, policy/settlement consistency, and terminal status. Read-only.'
  parameters = verifyReceiptParams

  async normalizeParams(params: z.infer<typeof verifyReceiptParams>) {
    return params
  }

  async coreAction(params: z.infer<typeof verifyReceiptParams>) {
    const result = await this.deps.port.verifyReceipt(params)
    const failed = Object.entries(result.checks)
      .filter(([, c]) => !c.ok)
      .map(([n]) => n)
    return {
      raw: { ok: result.ok, receiptId: result.receiptId, checks: result.checks },
      humanMessage: result.ok
        ? `Receipt ${result.receiptId} verified: all ${Object.keys(result.checks).length} checks passed.`
        : `Receipt ${result.receiptId} FAILED verification on: ${failed.join(', ')}.`,
    }
  }
}

// -----------------------------------------------------------------------------

const auditTrailParams = z.object({
  correlationId: z.string().describe('Correlation id whose HCS event chain should be read.'),
})

export class HedronGetAuditTrailTool extends HedronTool<
  z.infer<typeof auditTrailParams>,
  z.infer<typeof auditTrailParams>
> {
  method = hedronToolNames.GET_AUDIT_TRAIL
  name = 'Hedron Get Audit Trail'
  description =
    'Read the ordered HCS audit event chain for a Hedron flow by correlation id. Read-only.'
  parameters = auditTrailParams

  async normalizeParams(params: z.infer<typeof auditTrailParams>) {
    return params
  }

  async coreAction(params: z.infer<typeof auditTrailParams>) {
    const events = await this.deps.port.getAuditTrail(params)
    return {
      raw: {
        ok: true,
        count: events.length,
        events: events.map((e) => ({
          eventType: e.eventType,
          timestamp: e.timestamp,
          flowId: e.flowId,
          ...(e.quoteId !== undefined ? { quoteId: e.quoteId } : {}),
          ...(e.paymentId !== undefined ? { paymentId: e.paymentId } : {}),
        })),
      },
      humanMessage:
        events.length === 0
          ? `No audit events for correlation ${params.correlationId}.`
          : `${events.length} events: ${events.map((e) => e.eventType).join(' → ')}`,
    }
  }
}

// -----------------------------------------------------------------------------

/** All Hedron tools, in the order they appear in the commerce loop. */
export function buildHedronTools(deps: HedronPluginDeps): BaseTool[] {
  return [
    new HedronListAgentsTool(deps),
    new HedronGetQuoteTool(deps),
    new HedronApproveQuoteTool(deps),
    new HedronPayTool(deps),
    new HedronVerifyReceiptTool(deps),
    new HedronGetAuditTrailTool(deps),
  ]
}

export type { Client, Context }

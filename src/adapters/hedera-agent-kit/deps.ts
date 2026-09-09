/**
 * The port the HAK v4 plugin needs from a Hedron runtime.
 *
 * Deliberately narrow: the plugin is an edge adapter, so it talks to Hedron
 * through this interface rather than reaching into Router/Broker internals.
 * A local in-process implementation and a future HTTP client both satisfy it.
 */

import type { AgentRegistry } from '../../registry'
import type { RuleSet } from '../../policy'
import type { HcsEmitter } from '../../hcs'
import type { VerificationResult } from '../../receipts'
import type {
  AgentCapability,
  HcsAuditEvent,
  IntentRequest,
  PaymentRail,
  QuoteResponse,
  VerifiableReceipt,
} from '../../types'

export interface HedronListAgentsResult {
  capabilities: AgentCapability[]
}

export interface HedronQuoteResult {
  quote: QuoteResponse
  /** Quote verification outcome, so an agent can see *why* a quote is usable. */
  verified: boolean
  failedCheck?: string
}

export interface HedronPayResult {
  flowId: string
  receipt: VerifiableReceipt
  verification: VerificationResult
}

/**
 * Commerce operations the plugin exposes as tools.
 *
 * Implementations MUST NOT weaken Hedron's guarantees: `pay` runs the full
 * broker flow (quote verification → policy → settle → execute → receipt),
 * it does not settle directly.
 */
export interface HedronCommercePort {
  listAgents(filter: {
    name?: string
    tags?: string[]
    rails?: PaymentRail[]
  }): Promise<HedronListAgentsResult>

  getQuote(input: {
    capabilityId: string
    agentId: string
    action: unknown
    caller?: { id: string; role: 'user' | 'app' | 'agent' }
  }): Promise<HedronQuoteResult>

  /** Record an approval for a quote that policy gated behind HITL. */
  approveQuote(input: { quoteId: string; approverId: string }): Promise<{
    approvalId: string
    quoteId: string
  }>

  pay(input: { quoteId: string }): Promise<HedronPayResult>

  verifyReceipt(input: { receiptId: string }): Promise<VerificationResult>

  getAuditTrail(input: { correlationId: string }): Promise<HcsAuditEvent[]>
}

/** Everything the plugin builder needs. */
export interface HedronPluginDeps {
  port: HedronCommercePort
  /** Used by the policy bridge to evaluate Hedron rules inside HAK hooks. */
  rules: RuleSet
  registry: AgentRegistry
  emitter: HcsEmitter
  /** Caller identity attributed to tool calls that do not specify one. */
  defaultCaller?: { id: string; role: 'user' | 'app' | 'agent' }
}

export type { AgentCapability, IntentRequest, QuoteResponse, VerifiableReceipt }

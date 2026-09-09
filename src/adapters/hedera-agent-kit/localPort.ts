/**
 * In-process `HedronCommercePort` backed by a live Router + Broker.
 *
 * This is what makes the HAK plugin real rather than descriptive: the tools
 * drive the same `Broker.runFlow` as `demo:local`, so quote verification,
 * policy, settlement and receipt issuance all apply unchanged. An HTTP-backed
 * port can replace it without touching the tools.
 */

import { AgentRegistry } from '../../registry'
import { Router } from '../../router'
import { Broker } from '../../broker'
import type { HcsEmitter } from '../../hcs'
import type { RuleSet } from '../../policy'
import type { PaymentAdapter } from '../../settlement'
import type { QuoteVerifier } from '../../quotes'
import type { VerificationResult } from '../../receipts'
import { verifyReceipt } from '../../receipts'
import { newCorrelationId, newPaymentId } from '../../utils/ids'
import type {
  HcsAuditEvent,
  IntentRequest,
  PaymentRail,
  QuoteResponse,
  VerifiableReceipt,
} from '../../types'
import type {
  HedronCommercePort,
  HedronListAgentsResult,
  HedronPayResult,
  HedronQuoteResult,
} from './deps'

export interface LocalCommercePortDeps {
  registry: AgentRegistry
  router: Router
  broker: Broker
  emitter: HcsEmitter
  quoteVerifier: QuoteVerifier
  rules: RuleSet
  paymentAdapter: PaymentAdapter
  defaultCaller?: { id: string; role: 'user' | 'app' | 'agent' }
  /** Provider execution. Defaults to a mock result. */
  execute?: (action: unknown) => Promise<unknown>
}

interface QuoteEntry {
  quote: QuoteResponse
  intent: IntentRequest
  verified: boolean
  approvals: Array<{ approvalId: string; approverId: string }>
}

/**
 * Keeps issued quotes in memory so `pay` can be called with just a quoteId,
 * which is the ergonomics an LLM-driven agent needs (it should not have to
 * round-trip the whole signed quote object through the model).
 */
export class LocalHedronCommercePort implements HedronCommercePort {
  private readonly quotes = new Map<string, QuoteEntry>()
  private readonly receipts = new Map<string, VerifiableReceipt>()

  constructor(private readonly deps: LocalCommercePortDeps) {}

  async listAgents(filter: {
    name?: string
    tags?: string[]
    rails?: PaymentRail[]
  }): Promise<HedronListAgentsResult> {
    return { capabilities: this.deps.registry.findCapabilities(filter) }
  }

  async getQuote(input: {
    capabilityId: string
    agentId: string
    action: unknown
    caller?: { id: string; role: 'user' | 'app' | 'agent' }
  }): Promise<HedronQuoteResult> {
    const card = this.deps.registry.get(input.agentId)
    if (!card) throw new Error(`agent ${input.agentId} is not registered`)
    const cap = card.capabilities.find((c) => c.id === input.capabilityId)
    if (!cap) {
      throw new Error(`capability ${input.capabilityId} not found on agent ${input.agentId}`)
    }

    const caller = input.caller ??
      this.deps.defaultCaller ?? { id: 'hak-agent', role: 'agent' as const }
    const intent: IntentRequest = {
      intentId: `intent_${newPaymentId().slice(4)}`,
      correlationId: newCorrelationId(),
      caller,
      capabilityFilter: { name: cap.name },
      action: input.action,
    }
    const quoteReq = this.deps.router.buildQuoteRequest(intent, cap)
    const quote = this.deps.router.mockQuoteFromCapability(quoteReq, card)

    const verification = this.deps.quoteVerifier.verify(quote, { now: new Date() })
    this.quotes.set(quote.quoteId, {
      quote,
      intent,
      verified: verification.ok,
      approvals: [],
    })
    return {
      quote,
      verified: verification.ok,
      ...(verification.failedCheck !== undefined ? { failedCheck: verification.failedCheck } : {}),
    }
  }

  async approveQuote(input: { quoteId: string; approverId: string }): Promise<{
    approvalId: string
    quoteId: string
  }> {
    const entry = this.quotes.get(input.quoteId)
    if (!entry) throw new Error(`unknown quoteId ${input.quoteId}`)
    const approvalId = `apv_${newPaymentId().slice(4)}`
    entry.approvals.push({ approvalId, approverId: input.approverId })
    return { approvalId, quoteId: input.quoteId }
  }

  async pay(input: { quoteId: string }): Promise<HedronPayResult> {
    const entry = this.quotes.get(input.quoteId)
    if (!entry) throw new Error(`unknown quoteId ${input.quoteId}`)

    const approval = entry.approvals[0]
    const out = await this.deps.broker.runFlow({
      intent: entry.intent,
      quote: entry.quote,
      ...(approval !== undefined
        ? { approver: async () => approval }
        : {}),
      execute:
        this.deps.execute ??
        (async (action: unknown) => ({ ok: true, action, via: 'hak-v4-plugin' })),
    })
    this.receipts.set(out.receipt.receiptId, out.receipt)
    return { flowId: out.flowId, receipt: out.receipt, verification: out.verification }
  }

  async verifyReceipt(input: { receiptId: string }): Promise<VerificationResult> {
    const receipt = this.receipts.get(input.receiptId)
    if (!receipt) throw new Error(`unknown receiptId ${input.receiptId}`)
    return verifyReceipt(receipt, this.deps.emitter)
  }

  async getAuditTrail(input: { correlationId: string }): Promise<HcsAuditEvent[]> {
    return this.deps.emitter.readByCorrelation(input.correlationId)
  }

  // --- helpers used by the policy bridge -------------------------------------

  /** Amount in tinybar for a known quote, or undefined when unknown. */
  amountTinybarFor(quoteId: string): string | undefined {
    const entry = this.quotes.get(quoteId)
    if (!entry) return undefined
    const p = entry.quote.pricing
    if (p.kind === 'fixed-hbar') return p.amountTinybar
    if (p.kind === 'fixed-hts' || p.kind === 'fixed-evm-erc20') return p.amount
    return undefined
  }

  /** Whether a known quote passed verification when it was issued. */
  isQuoteVerified(quoteId: string): boolean {
    return this.quotes.get(quoteId)?.verified === true
  }
}

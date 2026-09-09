import type { AgentRegistry } from '../registry'
import type {
  AgentCard,
  AgentCapability,
  IntentRequest,
  QuoteRequest,
  QuoteResponse,
} from '../types'
import { newQuoteId, newPaymentId } from '../utils/ids'
import { canonicalHash } from '../utils/canonical'
import {
  mockQuoteSignature,
  quoteCoreHash,
  type QuoteCore,
  type UnsignedQuote,
} from '../quotes'

/**
 * Router — read-only path. Discovery + quote dispatch.
 */
export class Router {
  constructor(private readonly registry: AgentRegistry) {}

  discover(intent: IntentRequest): AgentCapability[] {
    return this.registry.findCapabilities({
      ...(intent.capabilityFilter.name !== undefined
        ? { name: intent.capabilityFilter.name }
        : {}),
      ...(intent.capabilityFilter.tags !== undefined
        ? { tags: intent.capabilityFilter.tags }
        : {}),
      ...(intent.capabilityFilter.allowedRails !== undefined
        ? { rails: intent.capabilityFilter.allowedRails }
        : {}),
    })
  }

  buildQuoteRequest(intent: IntentRequest, cap: AgentCapability): QuoteRequest {
    return {
      quoteRequestId: `qreq_${newPaymentId().slice(4)}`,
      intentId: intent.intentId,
      correlationId: intent.correlationId,
      agentId: cap.agentId,
      capabilityId: cap.id,
      action: intent.action,
      expiresAt: intent.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    }
  }

  /**
   * Mock provider: produce a deterministic signed quote from a capability.
   * Real adapters reach out to the agent runtime to get a real signed quote,
   * but MUST follow the same ordering invariant:
   *
   *   1. build the quote core (identity, pricing, action, expiry)
   *   2. compute `quoteCoreHash` and stamp it into
   *      `paymentRequirement.quoteHash`  ← before signing
   *   3. sign the whole unsigned quote, payment requirement included
   *
   * Signing before the stamp would leave the payment requirement unbound and
   * swappable; the Broker's `QUOTE_VERIFIED` check rejects that.
   */
  mockQuoteFromCapability(
    req: QuoteRequest,
    card: AgentCard,
    opts: { ttlMs?: number; now?: Date } = {},
  ): QuoteResponse {
    const cap = card.capabilities.find((c) => c.id === req.capabilityId)
    if (!cap) throw new Error(`capability ${req.capabilityId} not found on agent ${req.agentId}`)
    const pricing = { ...cap.pricing, rail: cap.allowedRails[0] ?? 'hedera-hbar' } as const
    const actionHash = canonicalHash(req.action)
    const now = opts.now ?? new Date()
    const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? 60_000)).toISOString()
    const quoteId = newQuoteId()

    // 1) quote identity core — everything except the payment requirement.
    const core: QuoteCore = {
      quoteId,
      quoteRequestId: req.quoteRequestId,
      intentId: req.intentId,
      correlationId: req.correlationId,
      agentId: req.agentId,
      capabilityId: req.capabilityId,
      pricing,
      actionHash,
      policyRequirements: {},
      expiresAt,
    }

    // 2) stamp the binding hash into the payment requirement BEFORE signing.
    const unsigned: UnsignedQuote = {
      ...core,
      paymentRequirement: {
        rail: pricing.rail,
        asset: { kind: 'hbar' as const },
        amount: pricing.kind === 'fixed-hbar' ? pricing.amountTinybar : '0',
        recipient: `mock:${req.agentId}`,
        expiresAt,
        actionHash,
        quoteHash: quoteCoreHash(core),
        correlationId: req.correlationId,
      },
    }

    // 3) sign the unsigned quote including the bound payment requirement.
    return {
      ...unsigned,
      signature: mockQuoteSignature(card.identity, unsigned),
    }
  }
}

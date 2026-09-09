/**
 * Hedron quote binding + verification.
 *
 * A quote is the only object in the commerce loop that crosses a trust
 * boundary: the provider agent produces it, the Broker spends money against
 * it. Two hashes make that safe:
 *
 *   1. `quoteCoreHash` — binds the payment requirement to the quote identity
 *      (what is bought, from whom, for how much, until when). The Router
 *      stamps it into `paymentRequirement.quoteHash` **before** signing.
 *   2. the quote `signature` — covers the whole unsigned quote *including*
 *      the stamped payment requirement, so a requirement cannot be swapped
 *      after the agent signed.
 *
 * The signature scheme here is the deterministic mock (`sha256` over
 * canonical JSON + identity material). It is a drop-in seam: a real
 * ed25519 / Hedera-key verifier implements the same `QuoteVerifier`
 * interface and the Broker does not change.
 */

import { canonicalHash } from '../utils/canonical'
import type { AgentIdentity, QuoteResponse } from '../types'

/** A quote before its signature is attached. */
export type UnsignedQuote = Omit<QuoteResponse, 'signature'>

/** Fields of a quote that fix its identity. Excludes `paymentRequirement`
 *  (which embeds this hash) and `signature` — so the hash is non-circular. */
export type QuoteCore = Omit<UnsignedQuote, 'paymentRequirement'>

export const QUOTE_HASH_SCHEME = 'hedron-quote-core-hash-v1'
export const QUOTE_SIGNATURE_SCHEME = 'hedron-mock-quote-sig-v1'

/**
 * Hash of the quote identity core. Deterministic and re-derivable by any
 * auditor holding the quote.
 */
export function quoteCoreHash(core: QuoteCore): string {
  return canonicalHash({
    scheme: QUOTE_HASH_SCHEME,
    quoteId: core.quoteId,
    quoteRequestId: core.quoteRequestId,
    intentId: core.intentId,
    correlationId: core.correlationId,
    agentId: core.agentId,
    capabilityId: core.capabilityId,
    pricing: core.pricing,
    actionHash: core.actionHash,
    policyRequirements: core.policyRequirements,
    expiresAt: core.expiresAt,
  })
}

/** Strip the payment requirement to obtain the signable identity core. */
export function toQuoteCore(quote: UnsignedQuote | QuoteResponse): QuoteCore {
  const {
    paymentRequirement: _pr,
    ...core
  } = quote as UnsignedQuote & { signature?: string }
  const { signature: _sig, ...clean } = core as QuoteCore & { signature?: string }
  return clean as QuoteCore
}

/**
 * Mock signature over the full unsigned quote, bound to the agent identity.
 *
 * Binding to `publicKey` means a quote signed with the wrong identity
 * material fails verification even when the agent id is right.
 */
export function mockQuoteSignature(identity: AgentIdentity, unsigned: UnsignedQuote): string {
  return canonicalHash({
    scheme: QUOTE_SIGNATURE_SCHEME,
    agentId: identity.id,
    publicKey: identity.publicKey ?? null,
    quote: unsigned,
  })
}

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

export interface QuoteCheck {
  ok: boolean
  detail?: string
}

export type QuoteCheckName =
  | 'agentKnown'
  | 'signature'
  | 'quoteHashBinding'
  | 'requirementConsistent'
  | 'quoteExpiry'
  | 'paymentRequirementExpiry'

/** Evaluation order is fixed so the first failure is deterministic. */
export const QUOTE_CHECK_ORDER: readonly QuoteCheckName[] = [
  'agentKnown',
  'signature',
  'quoteHashBinding',
  'requirementConsistent',
  'quoteExpiry',
  'paymentRequirementExpiry',
] as const

/**
 * Amount a quote's pricing implies, in the pricing asset's smallest unit.
 * `null` for metered pricing, where a single amount is not yet determined.
 */
export function pricedAmount(pricing: QuoteResponse['pricing']): string | null {
  switch (pricing.kind) {
    case 'fixed-hbar':
      return pricing.amountTinybar
    case 'fixed-hts':
    case 'fixed-evm-erc20':
      return pricing.amount
    case 'metered':
      return null
  }
}

/**
 * Checks that the payment requirement does not contradict the quote it is
 * attached to.
 *
 * This is separate from `quoteHashBinding` on purpose. The core hash pins the
 * quote *identity*; this check pins the quote *terms*. Without it, an agent
 * that can produce signatures could advertise one price in `pricing` (which
 * the policy engine reads) and demand another in `paymentRequirement` (which
 * settlement pays).
 */
export function checkRequirementConsistent(quote: QuoteResponse): QuoteCheck {
  const req = quote.paymentRequirement
  const mismatches: string[] = []
  if (req.rail !== quote.pricing.rail) {
    mismatches.push(`rail (${req.rail} vs pricing ${quote.pricing.rail})`)
  }
  if (req.actionHash !== quote.actionHash) {
    mismatches.push('actionHash')
  }
  if (req.correlationId !== quote.correlationId) {
    mismatches.push('correlationId')
  }
  const expected = pricedAmount(quote.pricing)
  if (expected !== null && req.amount !== expected) {
    mismatches.push(`amount (${req.amount} vs pricing ${expected})`)
  }
  return mismatches.length === 0
    ? { ok: true }
    : { ok: false, detail: `payment requirement contradicts quote: ${mismatches.join(', ')}` }
}

export interface QuoteVerificationResult {
  ok: boolean
  quoteId: string
  agentId: string
  scheme: string
  /** ISO timestamp the verification was evaluated at. */
  verifiedAt: string
  checks: Record<QuoteCheckName, QuoteCheck>
  /** First failing check in `QUOTE_CHECK_ORDER`, when `ok` is false. */
  failedCheck?: QuoteCheckName
}

export interface QuoteVerifier {
  verify(quote: QuoteResponse, opts: { now: Date }): QuoteVerificationResult
}

/** Minimal port the verifier needs from a registry. `AgentRegistry` satisfies it. */
export interface AgentIdentityPort {
  identity(agentId: string): AgentIdentity | undefined
}

/**
 * Verifies a quote against the identity registered for `quote.agentId`.
 *
 * Fails closed: an unregistered agent cannot be verified, so it is rejected.
 */
export class RegistryQuoteVerifier implements QuoteVerifier {
  constructor(private readonly port: AgentIdentityPort) {}

  verify(quote: QuoteResponse, opts: { now: Date }): QuoteVerificationResult {
    const nowMs = opts.now.getTime()
    const identity = this.port.identity(quote.agentId)

    const checks: Record<QuoteCheckName, QuoteCheck> = {
      agentKnown: identity
        ? { ok: true }
        : { ok: false, detail: `agent ${quote.agentId} is not registered` },
      signature: { ok: false, detail: 'not evaluated' },
      quoteHashBinding: { ok: false, detail: 'not evaluated' },
      requirementConsistent: checkRequirementConsistent(quote),
      quoteExpiry: { ok: false, detail: 'not evaluated' },
      paymentRequirementExpiry: { ok: false, detail: 'not evaluated' },
    }

    if (identity) {
      const { signature, ...unsigned } = quote
      const expected = mockQuoteSignature(identity, unsigned)
      checks.signature =
        signature === expected
          ? { ok: true }
          : { ok: false, detail: 'quote signature does not match registered agent identity' }

      const expectedHash = quoteCoreHash(toQuoteCore(quote))
      checks.quoteHashBinding =
        quote.paymentRequirement.quoteHash === expectedHash
          ? { ok: true }
          : {
              ok: false,
              detail: `paymentRequirement.quoteHash does not bind this quote (expected ${expectedHash})`,
            }
    }

    const quoteExpiresMs = Date.parse(quote.expiresAt)
    checks.quoteExpiry = Number.isNaN(quoteExpiresMs)
      ? { ok: false, detail: `unparseable quote.expiresAt: ${quote.expiresAt}` }
      : quoteExpiresMs > nowMs
        ? { ok: true }
        : { ok: false, detail: `quote expired at ${quote.expiresAt}` }

    const reqExpiresMs = Date.parse(quote.paymentRequirement.expiresAt)
    checks.paymentRequirementExpiry = Number.isNaN(reqExpiresMs)
      ? {
          ok: false,
          detail: `unparseable paymentRequirement.expiresAt: ${quote.paymentRequirement.expiresAt}`,
        }
      : reqExpiresMs > nowMs
        ? { ok: true }
        : {
            ok: false,
            detail: `payment requirement expired at ${quote.paymentRequirement.expiresAt}`,
          }

    const failedCheck = QUOTE_CHECK_ORDER.find((name) => !checks[name].ok)
    return {
      ok: failedCheck === undefined,
      quoteId: quote.quoteId,
      agentId: quote.agentId,
      scheme: QUOTE_SIGNATURE_SCHEME,
      verifiedAt: opts.now.toISOString(),
      checks,
      ...(failedCheck !== undefined ? { failedCheck } : {}),
    }
  }
}

/**
 * Escape hatch for tests and adapters that supply an already-trusted quote.
 * Never wire this into a Broker that spends real value.
 */
export class AlwaysTrustQuoteVerifier implements QuoteVerifier {
  verify(quote: QuoteResponse, opts: { now: Date }): QuoteVerificationResult {
    const ok: QuoteCheck = { ok: true, detail: 'trust-all verifier' }
    return {
      ok: true,
      quoteId: quote.quoteId,
      agentId: quote.agentId,
      scheme: 'hedron-trust-all-v1',
      verifiedAt: opts.now.toISOString(),
      checks: {
        agentKnown: ok,
        signature: ok,
        quoteHashBinding: ok,
        requirementConsistent: ok,
        quoteExpiry: ok,
        paymentRequirementExpiry: ok,
      },
    }
  }
}

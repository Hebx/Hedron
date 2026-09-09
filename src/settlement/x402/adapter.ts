/**
 * x402 Hedera `exact` settlement adapter.
 *
 * Implements Hedron's `PaymentAdapter` on top of an x402 facilitator, so the
 * Broker's flow (verify quote → policy → settle → execute → receipt) works
 * over x402 with no changes to the broker itself.
 *
 * Division of trust:
 *   - the **client agent** builds and signs the `TransferTransaction`; Hedron
 *     never touches the payer key
 *   - the **facilitator** signs as `feePayer`, pays gas, and submits; Hedron
 *     never holds the fee-payer key either
 *   - **Hedron** binds the payment to a verified quote, checks the wire
 *     requirements still match, and anchors the on-chain result in a receipt
 *
 * Hedron therefore never custodies funds on this rail. What it guarantees is
 * that what settled matches what was quoted and policy-approved.
 */

import { QuoteMismatchError, ReplayDetectedError } from '../../errors'
import { canonicalHash } from '../../utils/canonical'
import type {
  PaymentAdapter,
  PaymentPayload,
  PaymentRail,
  PaymentRequirement,
  QuoteResponse,
  SettlementReceipt,
  SettlementResult,
  SettlementStatus,
  SettlementVerification,
} from '../types'
import {
  assertRequirementsMatch,
  buildX402PaymentRequirements,
  fromCaip2Network,
  hashscanUrl,
  toCaip2Network,
  X402MappingError,
  X402_EXACT_SCHEME,
  X402_VERSION,
  type HederaX402Network,
} from './mapping'
import { X402FacilitatorClient, X402FacilitatorError } from './facilitator'
import { decodePaymentHeader, type X402PaymentPayload, type X402SettleResponse } from './wire'

export interface X402HederaAdapterOptions {
  facilitator: X402FacilitatorClient
  /** Hedera account receiving funds. */
  payTo: string
  /** Short network name; converted to CAIP-2 internally. */
  network: 'testnet' | 'mainnet'
  /**
   * Fee payer account. When omitted it is discovered from the facilitator's
   * `/supported` response, which is the more robust path.
   */
  feePayer?: string
  /** Resource URL advertised in the 402 body. */
  resourceUrl?: string
}

/**
 * Hedron `PaymentAdapter` for the x402 Hedera exact scheme.
 *
 * Note the deliberate asymmetry with `MockPaymentAdapter`: this adapter cannot
 * fabricate a settlement. `settlePayment` requires a real client-signed
 * transaction in `payload.signedPayload`, and returns only what the facilitator
 * actually confirmed on-chain.
 */
export class X402HederaAdapter implements PaymentAdapter {
  readonly rail: PaymentRail = 'x402'
  private readonly caip2: HederaX402Network
  private readonly seenPaymentIds = new Set<string>()
  private readonly settlements = new Map<string, X402SettleResponse>()
  private cachedFeePayer: string | undefined

  constructor(private readonly opts: X402HederaAdapterOptions) {
    this.caip2 = toCaip2Network(opts.network)
    this.cachedFeePayer = opts.feePayer
  }

  /** Resolve the fee payer, preferring config and falling back to discovery. */
  private async resolveFeePayer(): Promise<string> {
    if (this.cachedFeePayer !== undefined) return this.cachedFeePayer
    const discovered = await this.opts.facilitator.feePayerFor(this.caip2)
    if (discovered === undefined) {
      throw new X402MappingError(
        'no_fee_payer',
        `facilitator does not advertise a feePayer for ${this.caip2}; set feePayer explicitly`,
      )
    }
    this.cachedFeePayer = discovered
    return discovered
  }

  async createPaymentRequirement(opts: {
    quote: QuoteResponse
    correlationId: string
  }): Promise<PaymentRequirement> {
    const pricing = opts.quote.pricing
    const asset: PaymentRequirement['asset'] =
      pricing.kind === 'fixed-hts'
        ? { kind: 'hts', tokenId: pricing.tokenId }
        : { kind: 'hbar' }
    const amount =
      pricing.kind === 'fixed-hbar'
        ? pricing.amountTinybar
        : pricing.kind === 'fixed-hts'
          ? pricing.amount
          : (() => {
              throw new X402MappingError(
                'unsupported_pricing',
                `x402 exact scheme requires a fixed price, got ${pricing.kind}`,
              )
            })()

    const feePayer = await this.resolveFeePayer()
    const requirement: PaymentRequirement = {
      rail: this.rail,
      asset,
      amount,
      recipient: this.opts.payTo,
      expiresAt: opts.quote.expiresAt,
      actionHash: opts.quote.actionHash,
      quoteHash: canonicalHash(opts.quote),
      correlationId: opts.correlationId,
      metadata: {
        scheme: X402_EXACT_SCHEME,
        network: this.caip2,
        feePayer,
        x402Version: String(X402_VERSION),
      },
    }
    // Fail fast if the requirement cannot be expressed on the wire at all
    // (bad asset, non-positive amount, already-expired quote).
    buildX402PaymentRequirements({
      requirement,
      payTo: this.opts.payTo,
      feePayer,
      network: this.caip2,
    })
    return requirement
  }

  /** Build the x402 402-response requirements for a Hedron requirement. */
  async toWireRequirements(requirement: PaymentRequirement, now?: Date) {
    const feePayer = await this.resolveFeePayer()
    return buildX402PaymentRequirements({
      requirement,
      payTo: this.opts.payTo,
      feePayer,
      network: this.caip2,
      ...(now !== undefined ? { now } : {}),
    })
  }

  /**
   * Validate a client payment payload with the facilitator's `/verify`.
   *
   * `payload.signedPayload` carries the base64 `X-PAYMENT` header value. This
   * asks the facilitator to run the spec's MUST-level checks (fee-payer safety,
   * exact amount, payer signature, replay) *before* anything is submitted.
   */
  async validatePaymentPayload(opts: {
    requirement: PaymentRequirement
    payload: PaymentPayload
  }): Promise<SettlementVerification> {
    const checks: Record<string, { ok: boolean; detail?: string }> = {}
    checks['rail'] = {
      ok: opts.payload.rail === this.rail,
      detail: `payload.rail=${opts.payload.rail}`,
    }
    checks['expiry'] = {
      ok: Date.parse(opts.requirement.expiresAt) > Date.now(),
      detail: `expires ${opts.requirement.expiresAt}`,
    }

    let wire: X402PaymentPayload | undefined
    try {
      wire = decodePaymentHeader(opts.payload.signedPayload)
      checks['payloadDecodes'] = { ok: true }
    } catch (err) {
      checks['payloadDecodes'] = {
        ok: false,
        detail: `X-PAYMENT is not valid base64 JSON: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    if (wire !== undefined) {
      checks['x402Version'] = {
        ok: wire.x402Version === X402_VERSION,
        detail: `got ${wire.x402Version}, expected ${X402_VERSION}`,
      }
      checks['scheme'] = {
        ok: wire.accepted?.scheme === X402_EXACT_SCHEME,
        detail: `got ${wire.accepted?.scheme}`,
      }
      checks['network'] = {
        ok: wire.accepted?.network === this.caip2,
        detail: `got ${wire.accepted?.network}, expected ${this.caip2}`,
      }
      checks['transactionPresent'] = {
        ok: typeof wire.payload?.['transaction'] === 'string',
      }
      // The payload's own `accepted` block must match what Hedron quoted.
      try {
        assertRequirementsMatch(opts.requirement, wire.accepted, { payTo: this.opts.payTo })
        checks['requirementsMatch'] = { ok: true }
      } catch (err) {
        checks['requirementsMatch'] = {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        }
      }

      if (Object.values(checks).every((c) => c.ok)) {
        try {
          const requirements = await this.toWireRequirements(opts.requirement)
          const verify = await this.opts.facilitator.verify({ payload: wire, requirements })
          checks['facilitatorVerify'] = {
            ok: verify.isValid,
            ...(verify.isValid
              ? {}
              : {
                  detail: `${verify.invalidReason ?? 'unknown'}${
                    verify.invalidMessage ? `: ${verify.invalidMessage}` : ''
                  }`,
                }),
          }
        } catch (err) {
          checks['facilitatorVerify'] = {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          }
        }
      }
    }

    const ok = Object.values(checks).every((c) => c.ok)
    return { ok, checks }
  }

  /**
   * Settle via the facilitator.
   *
   * No retries: a retried `/settle` risks a double submission. Replay is
   * rejected locally on `paymentId`, and the facilitator enforces its own
   * replay protection per the spec.
   */
  async settlePayment(opts: {
    requirement: PaymentRequirement
    payload: PaymentPayload
    idempotencyKey: string
  }): Promise<SettlementResult> {
    if (this.seenPaymentIds.has(opts.payload.paymentId)) {
      throw new ReplayDetectedError(opts.payload.paymentId, opts.requirement.correlationId)
    }
    if (opts.payload.quoteId.length === 0) {
      throw new QuoteMismatchError('quoteId', opts.requirement.correlationId)
    }

    const wire = decodePaymentHeader(opts.payload.signedPayload)
    assertRequirementsMatch(opts.requirement, wire.accepted, { payTo: this.opts.payTo })
    const requirements = await this.toWireRequirements(opts.requirement)

    this.seenPaymentIds.add(opts.payload.paymentId)
    const settled = await this.opts.facilitator.settle({ payload: wire, requirements })

    if (!settled.success) {
      throw new X402FacilitatorError(
        settled.errorReason ?? 'settle_failed',
        `x402 settlement failed: ${settled.errorReason ?? 'unknown'}${
          settled.errorMessage ? ` — ${settled.errorMessage}` : ''
        }`,
      )
    }

    const settlementId = settled.transaction
    this.settlements.set(settlementId, settled)
    return {
      ok: true,
      paymentId: opts.payload.paymentId,
      settlementId,
      rail: this.rail,
      settlementHash: canonicalHash({
        scheme: X402_EXACT_SCHEME,
        network: settled.network,
        transaction: settled.transaction,
        payer: settled.payer ?? null,
        amount: settled.amount ?? opts.requirement.amount,
        asset: requirements.asset,
        payTo: requirements.payTo,
        quoteHash: opts.requirement.quoteHash,
        actionHash: opts.requirement.actionHash,
        correlationId: opts.requirement.correlationId,
      }),
    }
  }

  async getSettlementStatus(settlementId: string): Promise<SettlementStatus> {
    const settled = this.settlements.get(settlementId)
    if (!settled) {
      return { settlementId, state: 'failed', detail: 'no settlement recorded by this adapter' }
    }
    return {
      settlementId,
      state: settled.success ? 'confirmed' : 'failed',
      detail: settled.transaction,
    }
  }

  async produceSettlementReceipt(settlementId: string): Promise<SettlementReceipt> {
    const settled = this.settlements.get(settlementId)
    if (!settled) {
      throw new X402MappingError('unknown_settlement', `no settlement recorded for ${settlementId}`)
    }
    return {
      settlementId,
      rail: this.rail,
      record: canonicalHash({
        kind: 'x402-hedera-exact',
        transaction: settled.transaction,
        network: settled.network,
        payer: settled.payer ?? null,
      }),
    }
  }

  /**
   * Human/auditor-facing detail for a settlement, including the HashScan link.
   *
   * Kept off `SettlementReceipt` because that type is a narrow cross-rail
   * contract (`record` is the canonical anchor); this is x402-specific colour.
   */
  settlementDetail(settlementId: string):
    | { transactionId: string; network: string; hashscanUrl: string; payer?: string }
    | undefined {
    const settled = this.settlements.get(settlementId)
    if (!settled) return undefined
    return {
      transactionId: settled.transaction,
      network: settled.network,
      hashscanUrl: hashscanUrl(settled.network, settled.transaction),
      ...(settled.payer !== undefined ? { payer: settled.payer } : {}),
    }
  }

  /**
   * Independently re-check a settlement receipt.
   *
   * Confirms the recorded anchor still matches and that the network is one we
   * are configured for — a receipt naming a different network is not ours.
   */
  async verifySettlementReceipt(receipt: SettlementReceipt): Promise<SettlementVerification> {
    const settled = this.settlements.get(receipt.settlementId)
    const checks: Record<string, { ok: boolean; detail?: string }> = {
      railMatches: { ok: receipt.rail === this.rail },
      recordShape: {
        ok: typeof receipt.record === 'string' && receipt.record.length === 64,
      },
      known: {
        ok: settled !== undefined,
        ...(settled === undefined ? { detail: 'settlement not recorded by this adapter' } : {}),
      },
    }
    if (settled !== undefined) {
      checks['recordMatches'] = {
        ok:
          receipt.record ===
          canonicalHash({
            kind: 'x402-hedera-exact',
            transaction: settled.transaction,
            network: settled.network,
            payer: settled.payer ?? null,
          }),
      }
      checks['networkMatches'] = {
        ok: settled.network === this.caip2,
        detail: `settled on ${fromCaip2Network(settled.network)}`,
      }
    }
    const ok = Object.values(checks).every((c) => c.ok)
    return { ok, checks }
  }
}

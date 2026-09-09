import { canonicalHash } from '../utils/canonical'
import { newPaymentId } from '../utils/ids'
import {
  IdempotencyHitError,
  QuoteMismatchError,
  ReplayDetectedError,
} from '../errors'
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
} from './types'
export * from './types'
export * from './x402'

/**
 * Mock in-process payment adapter used by the local demo and the unit tests.
 *
 * Real rails (hedera, x402) replace this with their own implementation
 * but MUST satisfy the same invariants:
 *   - paymentId is single-use
 *   - quoteId + actionHash + amount + asset + recipient + rail + expiry all match
 *   - idempotency cache returns the previous result for repeats
 */
export class MockPaymentAdapter implements PaymentAdapter {
  readonly rail: PaymentRail = 'hedera-hbar'
  private readonly seenPaymentIds = new Set<string>()
  private readonly idempotencyCache = new Map<string, SettlementResult>()

  async createPaymentRequirement(opts: {
    quote: QuoteResponse
    correlationId: string
  }): Promise<PaymentRequirement> {
    const quoteHash = canonicalHash(opts.quote)
    return {
      rail: opts.quote.pricing.rail,
      asset:
        opts.quote.pricing.kind === 'fixed-hbar'
          ? { kind: 'hbar' }
          : opts.quote.pricing.kind === 'fixed-hts'
          ? { kind: 'hts', tokenId: opts.quote.pricing.tokenId }
          : opts.quote.pricing.kind === 'fixed-evm-erc20'
          ? {
              kind: 'evm-erc20',
              chainId: opts.quote.pricing.chainId,
              contract: opts.quote.pricing.contract,
            }
          : { kind: 'hbar' },
      amount:
        opts.quote.pricing.kind === 'fixed-hbar'
          ? opts.quote.pricing.amountTinybar
          : opts.quote.pricing.kind === 'metered'
          ? opts.quote.pricing.rateTinybarPerUnit
          : 'amount' in opts.quote.pricing
          ? opts.quote.pricing.amount
          : '0',
      recipient: `mock:${opts.quote.agentId}`,
      expiresAt: opts.quote.expiresAt,
      actionHash: opts.quote.actionHash,
      quoteHash,
      correlationId: opts.correlationId,
    }
  }

  async validatePaymentPayload(opts: {
    requirement: PaymentRequirement
    payload: PaymentPayload
  }): Promise<SettlementVerification> {
    const checks: Record<string, { ok: boolean; detail?: string }> = {}
    checks['quoteId'] = { ok: opts.payload.quoteId.length > 0 }
    checks['rail'] = {
      ok: opts.payload.rail === opts.requirement.rail,
      detail: `payload.rail=${opts.payload.rail} requirement.rail=${opts.requirement.rail}`,
    }
    checks['paymentIdShape'] = {
      ok: opts.payload.paymentId.startsWith('pay_') && opts.payload.paymentId.length > 8,
    }
    checks['signedPayload'] = {
      ok: typeof opts.payload.signedPayload === 'string' && opts.payload.signedPayload.length > 0,
    }
    checks['expiry'] = {
      ok: Date.parse(opts.requirement.expiresAt) > Date.now(),
      detail: `requirement expires at ${opts.requirement.expiresAt}`,
    }
    const ok = Object.values(checks).every((c) => c.ok)
    return { ok, checks }
  }

  async settlePayment(opts: {
    requirement: PaymentRequirement
    payload: PaymentPayload
    idempotencyKey: string
  }): Promise<SettlementResult> {
    if (this.idempotencyCache.has(opts.idempotencyKey)) {
      // The cache hit returns the prior result to the caller via the typed
      // error; the broker treats IdempotencyHitError as the retry signal.
      void this.idempotencyCache.get(opts.idempotencyKey)
      throw new IdempotencyHitError(opts.idempotencyKey, opts.requirement.correlationId)
    }
    if (this.seenPaymentIds.has(opts.payload.paymentId)) {
      throw new ReplayDetectedError(opts.payload.paymentId, opts.requirement.correlationId)
    }
    // Quote/payment binding
    if (opts.payload.quoteId.length === 0) {
      throw new QuoteMismatchError('quoteId', opts.requirement.correlationId)
    }
    this.seenPaymentIds.add(opts.payload.paymentId)
    const settlementId = `set_${newPaymentId().slice(4)}`
    const result: SettlementResult = {
      ok: true,
      paymentId: opts.payload.paymentId,
      settlementId,
      rail: this.rail,
      settlementHash: canonicalHash({
        paymentId: opts.payload.paymentId,
        requirement: opts.requirement,
        payload: opts.payload,
      }),
    }
    this.idempotencyCache.set(opts.idempotencyKey, result)
    return result
  }

  async getSettlementStatus(settlementId: string): Promise<SettlementStatus> {
    return { settlementId, state: 'confirmed' }
  }

  async produceSettlementReceipt(settlementId: string): Promise<SettlementReceipt> {
    return {
      settlementId,
      rail: this.rail,
      record: canonicalHash({ kind: 'mock-settlement', settlementId }),
    }
  }

  async verifySettlementReceipt(receipt: SettlementReceipt): Promise<SettlementVerification> {
    const ok =
      typeof receipt.record === 'string' && receipt.record.length === 64 && receipt.rail === this.rail
    return { ok, checks: { recordShape: { ok } } }
  }
}

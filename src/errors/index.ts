/**
 * Hedron v0.2 — typed error surface.
 *
 * Use these instead of `throw new Error(string)` so callers can branch on kind.
 */

export class HedronError extends Error {
  readonly code: string
  readonly correlationId?: string
  constructor(code: string, message: string, opts: { correlationId?: string; cause?: unknown } = {}) {
    super(message)
    this.name = 'HedronError'
    this.code = code
    if (opts.correlationId !== undefined) this.correlationId = opts.correlationId
    if (opts.cause !== undefined) (this as unknown as { cause?: unknown }).cause = opts.cause
  }
}

export class ConfigError extends HedronError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super('hedron/config', message, opts)
    this.name = 'ConfigError'
  }
}

export class PolicyDeniedError extends HedronError {
  readonly reason: string
  constructor(reason: string, correlationId?: string) {
    super('hedron/policy/denied', `policy denied: ${reason}`, { correlationId: correlationId ?? '' })
    this.name = 'PolicyDeniedError'
    this.reason = reason
  }
}

export class ApprovalRequiredError extends HedronError {
  readonly approverScope: 'operator' | 'user' | 'custom'
  constructor(approverScope: 'operator' | 'user' | 'custom', correlationId?: string) {
    super('hedron/policy/approval-required', `approval required (${approverScope})`, {
      correlationId: correlationId ?? '',
    })
    this.name = 'ApprovalRequiredError'
    this.approverScope = approverScope
  }
}

export class QuoteMismatchError extends HedronError {
  constructor(field: string, correlationId?: string) {
    super('hedron/quote/mismatch', `quote mismatch on field: ${field}`, {
      correlationId: correlationId ?? '',
    })
    this.name = 'QuoteMismatchError'
  }
}

/**
 * The quote signature does not match the identity registered for the agent
 * (or the payment requirement is not bound to the signed quote).
 */
export class QuoteSignatureError extends HedronError {
  readonly quoteId: string
  readonly agentId: string
  readonly check: string
  constructor(
    opts: { quoteId: string; agentId: string; check: string; detail?: string },
    correlationId?: string,
  ) {
    super(
      'hedron/quote/signature',
      `quote ${opts.quoteId} failed verification check '${opts.check}' for agent ${opts.agentId}` +
        (opts.detail !== undefined ? `: ${opts.detail}` : ''),
      { correlationId: correlationId ?? '' },
    )
    this.name = 'QuoteSignatureError'
    this.quoteId = opts.quoteId
    this.agentId = opts.agentId
    this.check = opts.check
  }
}

/** The quote or its payment requirement is past its expiry at evaluation time. */
export class QuoteExpiredError extends HedronError {
  readonly quoteId: string
  readonly expiredAt: string
  readonly check: string
  constructor(
    opts: { quoteId: string; expiredAt: string; check: string; detail?: string },
    correlationId?: string,
  ) {
    super(
      'hedron/quote/expired',
      `quote ${opts.quoteId} expired (${opts.check}, expiresAt=${opts.expiredAt})` +
        (opts.detail !== undefined ? `: ${opts.detail}` : ''),
      { correlationId: correlationId ?? '' },
    )
    this.name = 'QuoteExpiredError'
    this.quoteId = opts.quoteId
    this.expiredAt = opts.expiredAt
    this.check = opts.check
  }
}

export class ReplayDetectedError extends HedronError {
  constructor(paymentId: string, correlationId?: string) {
    super('hedron/payment/replay', `replay detected for paymentId=${paymentId}`, {
      correlationId: correlationId ?? '',
    })
    this.name = 'ReplayDetectedError'
  }
}

export class IdempotencyHitError extends HedronError {
  constructor(key: string, correlationId?: string) {
    super('hedron/idempotency/hit', `idempotent retry for key=${key}`, {
      correlationId: correlationId ?? '',
    })
    this.name = 'IdempotencyHitError'
  }
}

export class SignatureError extends HedronError {
  constructor(message: string, correlationId?: string) {
    super('hedron/signature/invalid', message, { correlationId: correlationId ?? '' })
    this.name = 'SignatureError'
  }
}

export class AdapterError extends HedronError {
  readonly adapterId: string
  constructor(adapterId: string, message: string, cause?: unknown) {
    super('hedron/adapter', `[${adapterId}] ${message}`, { cause })
    this.name = 'AdapterError'
    this.adapterId = adapterId
  }
}

export class ReceiptVerificationError extends HedronError {
  readonly check: string
  constructor(check: string, message: string) {
    super('hedron/receipt/verification', `verification check '${check}' failed: ${message}`)
    this.name = 'ReceiptVerificationError'
    this.check = check
  }
}

/**
 * x402 v2 wire types (structural mirrors).
 *
 * These are transcribed verbatim from the shipped `@x402/core@2.20.0`
 * declarations (`x402Client-*.d.ts`, lines 1205-1285). They are redeclared here
 * rather than imported because `@x402/core` publishes its types only through an
 * `exports` map subpath (`@x402/core/types`), which requires
 * `moduleResolution: node16`/`bundler`. Hedron core builds with
 * `moduleResolution: node`, and changing that project-wide to satisfy one edge
 * adapter would risk every other import in the package.
 *
 * Because these are structural types, values produced by `@x402/hedera` remain
 * assignable to them — the adapter tests assert exactly that against the real
 * package, so drift cannot go unnoticed.
 *
 * Source of truth: x402-foundation/x402 `specs/` + `@x402/core` types.
 * Do not "simplify" these shapes; field names are protocol.
 */

/** CAIP-2 style identifier, e.g. `hedera:testnet`. */
export type X402Network = `${string}:${string}`

export interface X402ResourceInfo {
  url: string
  description?: string
  mimeType?: string
  serviceName?: string
  tags?: string[]
  iconUrl?: string
}

/** Flat requirements object. `amount` is a decimal string in the asset's smallest unit. */
export interface X402PaymentRequirements {
  scheme: string
  network: X402Network
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

/** Body of an HTTP 402 response. */
export interface X402PaymentRequired {
  x402Version: number
  error?: string
  resource: X402ResourceInfo
  accepts: X402PaymentRequirements[]
  extensions?: Record<string, unknown>
}

/** Decoded `X-PAYMENT` header content. */
export interface X402PaymentPayload {
  x402Version: number
  resource?: X402ResourceInfo
  accepted: X402PaymentRequirements
  payload: Record<string, unknown>
  extensions?: Record<string, unknown>
}

/** Hedera `exact` scheme payload: a base64 partially-signed TransferTransaction. */
export interface ExactHederaPayload {
  transaction: string
}

export interface X402VerifyRequest {
  x402Version: number
  paymentPayload: X402PaymentPayload
  paymentRequirements: X402PaymentRequirements
}

/** NOTE: the success flag is `isValid`, not `success`. */
export interface X402VerifyResponse {
  isValid: boolean
  invalidReason?: string
  invalidMessage?: string
  payer?: string
  extensions?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export interface X402SettleRequest {
  x402Version: number
  paymentPayload: X402PaymentPayload
  paymentRequirements: X402PaymentRequirements
}

/**
 * NOTE: the tx id field is `transaction`, not `transactionId`.
 * The scheme markdown says `transactionId`; the shipped types say
 * `transaction`. The types are authoritative.
 */
export interface X402SettleResponse {
  success: boolean
  errorReason?: string
  errorMessage?: string
  payer?: string
  transaction: string
  network: X402Network
  amount?: string
  extensions?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export interface X402SupportedKind {
  x402Version: number
  scheme: string
  network: X402Network
  extra?: Record<string, unknown>
}

export interface X402SupportedResponse {
  kinds: X402SupportedKind[]
  extensions: string[]
}

/** Encode a payment payload for the `X-PAYMENT` header (base64 of canonical JSON). */
export function encodePaymentHeader(payload: X402PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** Decode an `X-PAYMENT` header value. Throws on malformed input. */
export function decodePaymentHeader(header: string): X402PaymentPayload {
  const json = Buffer.from(header, 'base64').toString('utf8')
  return JSON.parse(json) as X402PaymentPayload
}

export const X_PAYMENT_HEADER = 'X-PAYMENT'
export const X_PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE'

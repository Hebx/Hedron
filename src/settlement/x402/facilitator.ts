/**
 * x402 facilitator HTTP client.
 *
 * A facilitator is the only party that can settle a Hedera `exact` payment: it
 * verifies the client's partially-signed `TransferTransaction`, adds its own
 * signature as `feePayer`, pays the network fee, and submits. Hedron never
 * holds the fee-payer key, so this client is deliberately thin.
 *
 * Endpoints (per spec + Hedera docs):
 *   GET  /supported → { kinds, extensions }
 *   POST /verify    → VerifyResponse  (success flag is `isValid`)
 *   POST /settle    → SettleResponse  (tx id field is `transaction`)
 *
 * The client is transport-injectable (`fetchImpl`) so the adapter can be tested
 * against recorded facilitator responses without network access or credentials.
 */

import { X402_VERSION } from './mapping'
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettleResponse,
  X402SupportedResponse,
  X402VerifyResponse,
} from './wire'

export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

export class X402FacilitatorError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'X402FacilitatorError'
  }
}

export interface X402FacilitatorClientOptions {
  /** Base URL, no trailing slash. e.g. `https://facilitator.example.com` */
  baseUrl: string
  /** Optional bearer token; some facilitators are open-access and need none. */
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

/**
 * Minimal facilitator client.
 *
 * Deliberately does NOT retry: a settle retry could double-submit a payment.
 * Idempotency is the broker's job (keyed on `correlationId` + `quoteId`), and
 * the facilitator enforces its own replay protection per the spec.
 */
export class X402FacilitatorClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(private readonly opts: X402FacilitatorClientOptions) {
    // Trim trailing slashes without a regex. `/\/+$/` is a polynomial-ReDoS
    // footgun (CodeQL js/polynomial-redos): on a string ending in many slashes
    // followed by a non-slash, the engine retries the `+` from every position.
    // Measured on Node: 10k trailing slashes ~74ms, 50k ~1.8s, 200k ~29.5s.
    // baseUrl is caller-supplied config, so keep it linear and allocation-free.
    let end = opts.baseUrl.length
    while (end > 0 && opts.baseUrl.charCodeAt(end - 1) === 47 /* '/' */) end--
    this.baseUrl = opts.baseUrl.slice(0, end)
    this.timeoutMs = opts.timeoutMs ?? 20_000
    const fallback = (globalThis as { fetch?: FetchLike }).fetch
    const impl = opts.fetchImpl ?? fallback
    if (!impl) {
      throw new X402FacilitatorError(
        'no_fetch',
        'no fetch implementation available; pass fetchImpl explicitly',
      )
    }
    this.fetchImpl = impl
  }

  /** Payment kinds the facilitator supports, used to confirm Hedera coverage. */
  async supported(): Promise<X402SupportedResponse> {
    return this.request<X402SupportedResponse>('GET', '/supported')
  }

  /**
   * Ask the facilitator to validate a payload without submitting anything.
   *
   * A `false` result is a normal outcome, not an exception — the caller decides
   * whether to surface it as a Hedron settlement failure.
   */
  async verify(input: {
    payload: X402PaymentPayload
    requirements: X402PaymentRequirements
  }): Promise<X402VerifyResponse> {
    return this.request<X402VerifyResponse>('POST', '/verify', {
      x402Version: X402_VERSION,
      paymentPayload: input.payload,
      paymentRequirements: input.requirements,
    })
  }

  /**
   * Settle a verified payload on-chain. The facilitator signs as fee payer,
   * pays gas, and submits.
   */
  async settle(input: {
    payload: X402PaymentPayload
    requirements: X402PaymentRequirements
  }): Promise<X402SettleResponse> {
    return this.request<X402SettleResponse>('POST', '/settle', {
      x402Version: X402_VERSION,
      paymentPayload: input.payload,
      paymentRequirements: input.requirements,
    })
  }

  /** True when the facilitator advertises the given CAIP-2 network for `exact`. */
  async supportsHederaNetwork(network: string): Promise<boolean> {
    const res = await this.supported()
    return res.kinds.some(
      (k) => k.scheme === 'exact' && k.network === network && k.x402Version === X402_VERSION,
    )
  }

  /**
   * Fee-payer account the facilitator advertises for a network, needed for
   * `PaymentRequirements.extra.feePayer`.
   */
  async feePayerFor(network: string): Promise<string | undefined> {
    const res = await this.supported()
    const kind = res.kinds.find((k) => k.scheme === 'exact' && k.network === network)
    const feePayer = kind?.extra?.['feePayer']
    return typeof feePayer === 'string' ? feePayer : undefined
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (this.opts.apiKey !== undefined) {
        headers['authorization'] = `Bearer ${this.opts.apiKey}`
      }
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new X402FacilitatorError(
          'facilitator_http_error',
          `facilitator ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`,
          res.status,
        )
      }
      try {
        return JSON.parse(text) as T
      } catch {
        throw new X402FacilitatorError(
          'facilitator_bad_json',
          `facilitator ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`,
          res.status,
        )
      }
    } catch (err) {
      if (err instanceof X402FacilitatorError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new X402FacilitatorError(
          'facilitator_timeout',
          `facilitator ${method} ${path} timed out after ${this.timeoutMs}ms`,
        )
      }
      throw new X402FacilitatorError(
        'facilitator_unreachable',
        `facilitator ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * x402 Hedera `exact` scheme settlement rail.
 *
 * Implemented against the published spec and packages:
 *   - spec: x402-foundation/x402 `specs/schemes/exact/scheme_exact_hedera.md`
 *   - packages: `@x402/hedera@2.20.0`, `@x402/core@2.20.0`
 *   - docs: https://docs.hedera.com/solutions/ai/x402
 *
 * Layout:
 *   wire.ts        x402 v2 wire types + X-PAYMENT encode/decode
 *   mapping.ts     Hedron ⇄ x402 mapping (pure, no network/keys)
 *   facilitator.ts facilitator HTTP client (/supported, /verify, /settle)
 *   adapter.ts     PaymentAdapter implementation
 *   client.ts      client-side payer helper (needs @x402/hedera + a key)
 *
 * Hedron custodies nothing on this rail: the client signs the transfer, the
 * facilitator sponsors fees and submits. Hedron's job is to bind the payment to
 * a verified quote and anchor the on-chain result into a receipt.
 */

import type { PaymentAdapter, PaymentRail } from '../types'

export const X402_RAIL: PaymentRail = 'x402'

/** Options accepted by the x402 rail. `facilitatorUrl` empty ⇒ rail disabled. */
export interface X402AdapterOptions {
  facilitatorUrl?: string
  network: 'testnet' | 'mainnet'
  payTo?: string
  feePayer?: string
  apiKey?: string
}

export interface X402Adapter extends PaymentAdapter {
  readonly rail: Extract<PaymentRail, 'x402'>
}

export * from './wire'
export * from './mapping'
export * from './facilitator'
export * from './adapter'

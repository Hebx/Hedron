/**
 * Hedron ⇄ x402 wire-format mapping for the Hedera `exact` scheme.
 *
 * Verified against the published `@x402/hedera@2.20.0` / `@x402/core@2.20.0`
 * type declarations and the official scheme spec
 * (`specs/schemes/exact/scheme_exact_hedera.md` in x402-foundation/x402).
 *
 * Facts that differ from Hedron's earlier design sketch, all load-bearing:
 *
 *  - Networks are **CAIP-2**: `hedera:testnet` / `hedera:mainnet`. A bare
 *    `testnet` is not a valid x402 network.
 *  - `x402Version` is **2**.
 *  - `PaymentRequirements` is flat: `{ scheme, network, asset, amount, payTo,
 *    maxTimeoutSeconds, extra }`. `amount` is a **string in the asset's
 *    smallest unit** (tinybar for HBAR), and `asset` is a Hedera entity id —
 *    **`"0.0.0"` means native HBAR**, not a separate asset kind.
 *  - The Hedera scheme requires **`extra.feePayer`** (the facilitator's
 *    account). Without it a client cannot build a valid transaction.
 *  - `VerifyResponse` uses **`isValid`** (not `success`), and `SettleResponse`
 *    carries **`transaction`** (not `transactionId`). The spec markdown shows
 *    `transactionId`; the shipped types say `transaction`. Types win.
 *
 * This module is pure: no network, no SDK client, no keys. That keeps the
 * mapping unit-testable without credentials.
 */

import type { PaymentRequirement } from '../../types'
import type { X402Network, X402PaymentRequirements } from './wire'

export const X402_VERSION = 2
export const X402_EXACT_SCHEME = 'exact'

/**
 * Protocol constants, mirrored from `@x402/hedera@2.20.0`.
 *
 * Redeclared (not imported) so Hedron core stays buildable without the x402
 * packages installed; `tests/unit/settlement-x402.test.ts` asserts each value
 * against the real package so drift fails CI rather than shipping.
 */
export const HBAR_ASSET_ID = '0.0.0'
export const HEDERA_MAINNET_CAIP2 = 'hedera:mainnet'
export const HEDERA_TESTNET_CAIP2 = 'hedera:testnet'
export const HEDERA_MAINNET_USDC = '0.0.456858'
export const HEDERA_TESTNET_USDC = '0.0.429274'
export const HEDERA_USDC_DECIMALS = 6
export const HEDERA_MAINNET_MIRROR_NODE_URL = 'https://mainnet-public.mirrornode.hedera.com'
export const HEDERA_TESTNET_MIRROR_NODE_URL = 'https://testnet.mirrornode.hedera.com'

/** Hedera account/token entity id, e.g. `0.0.1234`. */
const HEDERA_ENTITY_ID_REGEX = /^\d+\.\d+\.\d+$/

export function isValidHederaEntityId(entityId: string): boolean {
  return HEDERA_ENTITY_ID_REGEX.test(entityId)
}

/** Hedera networks Hedron will talk to over x402. */
export type HederaX402Network = typeof HEDERA_TESTNET_CAIP2 | typeof HEDERA_MAINNET_CAIP2

/** Map Hedron's config-friendly short name to the CAIP-2 identifier x402 requires. */
export function toCaip2Network(network: 'testnet' | 'mainnet'): HederaX402Network {
  return network === 'mainnet' ? HEDERA_MAINNET_CAIP2 : HEDERA_TESTNET_CAIP2
}

/** Reverse of `toCaip2Network`, for logging and receipts. */
export function fromCaip2Network(network: string): 'testnet' | 'mainnet' | 'unknown' {
  if (network === HEDERA_MAINNET_CAIP2) return 'mainnet'
  if (network === HEDERA_TESTNET_CAIP2) return 'testnet'
  return 'unknown'
}

export class X402MappingError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message)
    this.name = 'X402MappingError'
  }
}

/**
 * Resolve a Hedron asset descriptor to an x402 Hedera `asset` entity id.
 *
 * HBAR maps to the sentinel `"0.0.0"`. HTS maps to the token id. EVM ERC-20
 * has no representation in the Hedera exact scheme and is rejected rather
 * than silently coerced.
 */
export function toX402Asset(asset: PaymentRequirement['asset']): string {
  switch (asset.kind) {
    case 'hbar':
      return HBAR_ASSET_ID
    case 'hts':
      if (!isValidHederaEntityId(asset.tokenId)) {
        throw new X402MappingError(
          'invalid_asset',
          `HTS token id ${asset.tokenId} is not a valid Hedera entity id`,
        )
      }
      return asset.tokenId
    case 'evm-erc20':
      throw new X402MappingError(
        'unsupported_asset',
        'the Hedera exact scheme cannot settle EVM ERC-20 assets; use the evm rail',
      )
  }
}

/** Inverse mapping, for reconstructing a Hedron asset from x402 requirements. */
export function fromX402Asset(asset: string): PaymentRequirement['asset'] {
  if (asset === HBAR_ASSET_ID) return { kind: 'hbar' }
  if (!isValidHederaEntityId(asset)) {
    throw new X402MappingError('invalid_asset', `asset ${asset} is not a valid Hedera entity id`)
  }
  return { kind: 'hts', tokenId: asset }
}

/**
 * Seconds a client has to produce a payment, derived from the quote expiry.
 *
 * x402 expresses the window as a duration (`maxTimeoutSeconds`); Hedron
 * expresses it as an absolute instant (`expiresAt`). Converting at build time
 * means the two never disagree.
 */
export function maxTimeoutSecondsFrom(expiresAt: string, now: Date): number {
  const ms = Date.parse(expiresAt)
  if (Number.isNaN(ms)) {
    throw new X402MappingError('invalid_expiry', `unparseable expiresAt: ${expiresAt}`)
  }
  const seconds = Math.floor((ms - now.getTime()) / 1000)
  if (seconds <= 0) {
    throw new X402MappingError('expired', `quote already expired at ${expiresAt}`)
  }
  return seconds
}

export interface BuildRequirementsInput {
  /** Hedron's own requirement, already bound to a verified quote. */
  requirement: PaymentRequirement
  /** Hedera account id receiving funds (`payTo`). */
  payTo: string
  /** Facilitator account that sponsors fees (`extra.feePayer`). */
  feePayer: string
  network: HederaX402Network
  now?: Date
}

/**
 * Build x402 `PaymentRequirements` from a Hedron `PaymentRequirement`.
 *
 * Hedron's `correlationId`, `actionHash` and `quoteHash` are carried through
 * `extra` so the on-the-wire requirement stays traceable back to the HCS audit
 * chain. `extra.feePayer` is mandatory for the Hedera scheme.
 */
export function buildX402PaymentRequirements(
  input: BuildRequirementsInput,
): X402PaymentRequirements {
  const { requirement, payTo, feePayer, network } = input
  const now = input.now ?? new Date()

  if (!isValidHederaEntityId(payTo)) {
    throw new X402MappingError('invalid_pay_to', `payTo ${payTo} is not a valid Hedera account id`)
  }
  if (!isValidHederaEntityId(feePayer)) {
    throw new X402MappingError(
      'invalid_fee_payer',
      `feePayer ${feePayer} is not a valid Hedera account id`,
    )
  }
  if (!/^\d+$/.test(requirement.amount)) {
    throw new X402MappingError(
      'invalid_amount',
      `amount must be a whole number in the asset's smallest unit, got ${requirement.amount}`,
    )
  }
  if (BigInt(requirement.amount) <= 0n) {
    throw new X402MappingError('invalid_amount', `amount must be positive, got ${requirement.amount}`)
  }

  return {
    scheme: X402_EXACT_SCHEME,
    network: network as X402Network,
    asset: toX402Asset(requirement.asset),
    amount: requirement.amount,
    payTo,
    maxTimeoutSeconds: maxTimeoutSecondsFrom(requirement.expiresAt, now),
    extra: {
      feePayer,
      // Hedron audit linkage — opaque to x402, meaningful to our verifier.
      hedronCorrelationId: requirement.correlationId,
      hedronActionHash: requirement.actionHash,
      hedronQuoteHash: requirement.quoteHash,
    },
  }
}

/**
 * Assert that x402 requirements returned by a counterparty still match the
 * Hedron requirement we intended to pay.
 *
 * This is the x402 analogue of the broker's `requirementConsistent` quote
 * check: a resource server could advertise one price in the 402 body and a
 * different one in the requirements it hands the facilitator.
 */
export function assertRequirementsMatch(
  expected: PaymentRequirement,
  actual: X402PaymentRequirements,
  opts: { payTo: string },
): void {
  const mismatches: string[] = []
  if (actual.scheme !== X402_EXACT_SCHEME) mismatches.push(`scheme=${actual.scheme}`)
  if (actual.amount !== expected.amount) {
    mismatches.push(`amount=${actual.amount} expected=${expected.amount}`)
  }
  const expectedAsset = toX402Asset(expected.asset)
  if (actual.asset !== expectedAsset) {
    mismatches.push(`asset=${actual.asset} expected=${expectedAsset}`)
  }
  if (actual.payTo !== opts.payTo) {
    mismatches.push(`payTo=${actual.payTo} expected=${opts.payTo}`)
  }
  if (typeof actual.extra?.['feePayer'] !== 'string') {
    mismatches.push('extra.feePayer missing')
  }
  if (mismatches.length > 0) {
    throw new X402MappingError(
      'requirements_mismatch',
      `x402 requirements do not match the Hedron requirement: ${mismatches.join(', ')}`,
    )
  }
}

/** HashScan URL for a settled transaction, for receipts and audit trails. */
export function hashscanUrl(network: string, transactionId: string): string {
  const net = fromCaip2Network(network)
  const segment = net === 'mainnet' ? 'mainnet' : 'testnet'
  return `https://hashscan.io/${segment}/transaction/${encodeURIComponent(transactionId)}`
}

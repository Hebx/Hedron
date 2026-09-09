/**
 * x402 Hedera `exact` scheme adapter tests.
 *
 * Two kinds of assertion here:
 *
 *  1. DRIFT GUARDS — Hedron mirrors x402 protocol constants and wire types
 *     locally (see `wire.ts` / `mapping.ts` for why). These tests import the
 *     REAL `@x402/hedera` package and assert the mirrors still agree, so an
 *     upstream change breaks CI instead of shipping a silently wrong rail.
 *
 *  2. BEHAVIOUR — mapping, facilitator client, and adapter logic against a
 *     stub facilitator. No credentials, no network, no on-chain transactions.
 */

import { describe, it, expect } from 'vitest'
import {
  HBAR_ASSET_ID as PKG_HBAR,
  HEDERA_MAINNET_CAIP2 as PKG_MAINNET,
  HEDERA_TESTNET_CAIP2 as PKG_TESTNET,
  HEDERA_MAINNET_USDC as PKG_MAINNET_USDC,
  HEDERA_TESTNET_USDC as PKG_TESTNET_USDC,
  HEDERA_USDC_DECIMALS as PKG_USDC_DECIMALS,
  SUPPORTED_HEDERA_NETWORKS,
  isValidHederaEntityId as pkgIsValidEntityId,
  isHbarAsset as pkgIsHbarAsset,
} from '@x402/hedera'

import {
  HBAR_ASSET_ID,
  HEDERA_MAINNET_CAIP2,
  HEDERA_TESTNET_CAIP2,
  HEDERA_MAINNET_USDC,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
  X402_EXACT_SCHEME,
  X402_VERSION,
  X402MappingError,
  assertRequirementsMatch,
  buildX402PaymentRequirements,
  fromCaip2Network,
  fromX402Asset,
  hashscanUrl,
  isValidHederaEntityId,
  maxTimeoutSecondsFrom,
  toCaip2Network,
  toX402Asset,
} from '../../src/settlement/x402/mapping'
import {
  decodePaymentHeader,
  encodePaymentHeader,
  X_PAYMENT_HEADER,
  type X402PaymentPayload,
  type X402SettleResponse,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from '../../src/settlement/x402/wire'
import {
  X402FacilitatorClient,
  X402FacilitatorError,
  type FetchLike,
} from '../../src/settlement/x402/facilitator'
import { X402HederaAdapter } from '../../src/settlement/x402/adapter'
import { ReplayDetectedError } from '../../src/errors'
import type { PaymentPayload, PaymentRequirement, QuoteResponse } from '../../src/types'

const FEE_PAYER = '0.0.1235'
const PAY_TO = '0.0.1234'
const FUTURE = new Date(Date.now() + 120_000).toISOString()

function requirement(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    rail: 'x402',
    asset: { kind: 'hbar' },
    amount: '100000000',
    recipient: PAY_TO,
    expiresAt: FUTURE,
    actionHash: 'a'.repeat(64),
    quoteHash: 'b'.repeat(64),
    correlationId: 'corr_1',
    ...overrides,
  }
}

/** Stub facilitator. Records calls so ordering can be asserted. */
function stubFacilitator(opts: {
  verify?: X402VerifyResponse
  settle?: X402SettleResponse
  supported?: X402SupportedResponse
  failStatus?: number
} = {}) {
  const calls: string[] = []
  const supported: X402SupportedResponse =
    opts.supported ??
    {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'hedera:testnet',
          extra: { feePayer: FEE_PAYER },
        },
      ],
      extensions: [],
    }
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (opts.failStatus !== undefined) {
      return { ok: false, status: opts.failStatus, text: async () => 'upstream boom' }
    }
    const body =
      path === '/supported'
        ? supported
        : path === '/verify'
          ? (opts.verify ?? { isValid: true, payer: '0.0.9999' })
          : path === '/settle'
            ? (opts.settle ?? {
                success: true,
                transaction: '0.0.1235@1700000000.000000000',
                network: 'hedera:testnet',
                payer: FEE_PAYER,
              })
            : {}
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  const client = new X402FacilitatorClient({ baseUrl: 'https://facilitator.test', fetchImpl })
  return { client, calls }
}

function adapter(f = stubFacilitator()) {
  return {
    adapter: new X402HederaAdapter({
      facilitator: f.client,
      payTo: PAY_TO,
      network: 'testnet',
      feePayer: FEE_PAYER,
    }),
    calls: f.calls,
  }
}

/** A well-formed X-PAYMENT header for the given requirement. */
async function header(
  a: X402HederaAdapter,
  req: PaymentRequirement,
  mutate: (p: X402PaymentPayload) => X402PaymentPayload = (p) => p,
): Promise<string> {
  const accepted = await a.toWireRequirements(req)
  const payload: X402PaymentPayload = {
    x402Version: X402_VERSION,
    accepted,
    payload: { transaction: Buffer.from('fake-signed-tx').toString('base64') },
  }
  return encodePaymentHeader(mutate(payload))
}

function payment(signedPayload: string, overrides: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    rail: 'x402',
    quoteId: 'quote_1',
    paymentId: `pay_${Math.random().toString(36).slice(2)}`,
    signedPayload,
    ...overrides,
  }
}

// -----------------------------------------------------------------------------

describe('x402 drift guards (against real @x402/hedera@2.20.0)', () => {
  it('mirrors the protocol constants exactly', () => {
    expect(HBAR_ASSET_ID).toBe(PKG_HBAR)
    expect(HEDERA_TESTNET_CAIP2).toBe(PKG_TESTNET)
    expect(HEDERA_MAINNET_CAIP2).toBe(PKG_MAINNET)
    expect(HEDERA_TESTNET_USDC).toBe(PKG_TESTNET_USDC)
    expect(HEDERA_MAINNET_USDC).toBe(PKG_MAINNET_USDC)
    expect(HEDERA_USDC_DECIMALS).toBe(PKG_USDC_DECIMALS)
  })

  it('uses CAIP-2 networks that the package declares supported', () => {
    expect([...SUPPORTED_HEDERA_NETWORKS]).toEqual(['hedera:mainnet', 'hedera:testnet'])
    expect(SUPPORTED_HEDERA_NETWORKS).toContain(toCaip2Network('testnet'))
    expect(SUPPORTED_HEDERA_NETWORKS).toContain(toCaip2Network('mainnet'))
  })

  it('agrees with the package on entity-id and HBAR-asset validation', () => {
    for (const id of ['0.0.0', '0.0.1234', '1.2.3']) {
      expect(isValidHederaEntityId(id)).toBe(pkgIsValidEntityId(id))
    }
    for (const bad of ['', 'abc', '0.0', '0.0.x', 'hedera:testnet']) {
      expect(isValidHederaEntityId(bad)).toBe(pkgIsValidEntityId(bad))
    }
    expect(pkgIsHbarAsset(HBAR_ASSET_ID)).toBe(true)
  })

  it('builds requirements that satisfy the package validators', () => {
    const wire = buildX402PaymentRequirements({
      requirement: requirement(),
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      network: 'hedera:testnet',
    })
    expect(wire.scheme).toBe('exact')
    expect(pkgIsValidEntityId(wire.payTo)).toBe(true)
    expect(pkgIsValidEntityId(String(wire.extra['feePayer']))).toBe(true)
    expect(pkgIsHbarAsset(wire.asset)).toBe(true)
    expect(SUPPORTED_HEDERA_NETWORKS).toContain(wire.network)
  })
})

describe('x402 mapping', () => {
  it('maps HBAR to the 0.0.0 sentinel and HTS to its token id', () => {
    expect(toX402Asset({ kind: 'hbar' })).toBe('0.0.0')
    expect(toX402Asset({ kind: 'hts', tokenId: '0.0.429274' })).toBe('0.0.429274')
    expect(fromX402Asset('0.0.0')).toEqual({ kind: 'hbar' })
    expect(fromX402Asset('0.0.429274')).toEqual({ kind: 'hts', tokenId: '0.0.429274' })
  })

  it('refuses to coerce EVM ERC-20 onto the Hedera exact scheme', () => {
    expect(() =>
      toX402Asset({ kind: 'evm-erc20', chainId: 1, contract: '0xabc' }),
    ).toThrowError(X402MappingError)
  })

  it('rejects a malformed HTS token id', () => {
    expect(() => toX402Asset({ kind: 'hts', tokenId: 'not-an-id' })).toThrowError(X402MappingError)
  })

  it('converts an absolute expiry into a positive maxTimeoutSeconds', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const exp = new Date(now.getTime() + 180_000).toISOString()
    expect(maxTimeoutSecondsFrom(exp, now)).toBe(180)
  })

  it('rejects an already-expired or unparseable expiry', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(() => maxTimeoutSecondsFrom(now.toISOString(), now)).toThrowError(X402MappingError)
    expect(() => maxTimeoutSecondsFrom('nope', now)).toThrowError(X402MappingError)
  })

  it('rejects non-integer, zero, or negative amounts', () => {
    for (const amount of ['0', '-5', '1.5', 'abc', '']) {
      expect(() =>
        buildX402PaymentRequirements({
          requirement: requirement({ amount }),
          payTo: PAY_TO,
          feePayer: FEE_PAYER,
          network: 'hedera:testnet',
        }),
      ).toThrowError(X402MappingError)
    }
  })

  it('requires valid payTo and feePayer account ids', () => {
    expect(() =>
      buildX402PaymentRequirements({
        requirement: requirement(),
        payTo: 'bogus',
        feePayer: FEE_PAYER,
        network: 'hedera:testnet',
      }),
    ).toThrowError(X402MappingError)
    expect(() =>
      buildX402PaymentRequirements({
        requirement: requirement(),
        payTo: PAY_TO,
        feePayer: 'bogus',
        network: 'hedera:testnet',
      }),
    ).toThrowError(X402MappingError)
  })

  it('carries Hedron audit linkage through extra without disturbing feePayer', () => {
    const wire = buildX402PaymentRequirements({
      requirement: requirement(),
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      network: 'hedera:testnet',
    })
    expect(wire.extra['feePayer']).toBe(FEE_PAYER)
    expect(wire.extra['hedronCorrelationId']).toBe('corr_1')
    expect(wire.extra['hedronActionHash']).toBe('a'.repeat(64))
    expect(wire.extra['hedronQuoteHash']).toBe('b'.repeat(64))
  })

  it('detects requirements that contradict the Hedron requirement', () => {
    const good = buildX402PaymentRequirements({
      requirement: requirement(),
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      network: 'hedera:testnet',
    })
    expect(() => assertRequirementsMatch(requirement(), good, { payTo: PAY_TO })).not.toThrow()

    // swapped amount — the classic "advertise cheap, charge dear" attack
    expect(() =>
      assertRequirementsMatch(requirement(), { ...good, amount: '999' }, { payTo: PAY_TO }),
    ).toThrowError(X402MappingError)
    // redirected recipient
    expect(() =>
      assertRequirementsMatch(requirement(), { ...good, payTo: '0.0.6666' }, { payTo: PAY_TO }),
    ).toThrowError(X402MappingError)
    // swapped asset
    expect(() =>
      assertRequirementsMatch(requirement(), { ...good, asset: '0.0.429274' }, { payTo: PAY_TO }),
    ).toThrowError(X402MappingError)
    // missing feePayer
    expect(() =>
      assertRequirementsMatch(requirement(), { ...good, extra: {} }, { payTo: PAY_TO }),
    ).toThrowError(X402MappingError)
  })

  it('round-trips the X-PAYMENT header as base64 JSON', () => {
    const payload: X402PaymentPayload = {
      x402Version: 2,
      accepted: buildX402PaymentRequirements({
        requirement: requirement(),
        payTo: PAY_TO,
        feePayer: FEE_PAYER,
        network: 'hedera:testnet',
      }),
      payload: { transaction: 'AAAA' },
    }
    const encoded = encodePaymentHeader(payload)
    expect(encoded).not.toContain('{')
    expect(decodePaymentHeader(encoded)).toEqual(payload)
    expect(X_PAYMENT_HEADER).toBe('X-PAYMENT')
  })

  it('builds HashScan links per network', () => {
    expect(hashscanUrl('hedera:testnet', '0.0.1@2.3')).toContain('hashscan.io/testnet/transaction/')
    expect(hashscanUrl('hedera:mainnet', '0.0.1@2.3')).toContain('hashscan.io/mainnet/transaction/')
    expect(fromCaip2Network('hedera:testnet')).toBe('testnet')
    expect(fromCaip2Network('eip155:1')).toBe('unknown')
  })
})

describe('x402 facilitator client', () => {
  it('reads /supported and detects Hedera coverage + fee payer', async () => {
    const { client } = stubFacilitator()
    expect(await client.supportsHederaNetwork('hedera:testnet')).toBe(true)
    expect(await client.supportsHederaNetwork('hedera:mainnet')).toBe(false)
    expect(await client.feePayerFor('hedera:testnet')).toBe(FEE_PAYER)
  })

  it('surfaces HTTP failures as X402FacilitatorError', async () => {
    const { client } = stubFacilitator({ failStatus: 502 })
    await expect(client.supported()).rejects.toBeInstanceOf(X402FacilitatorError)
  })

  it('sends the x402Version in verify and settle bodies', async () => {
    const bodies: string[] = []
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init?.body ?? '')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ isValid: true }),
      }
    }
    const client = new X402FacilitatorClient({ baseUrl: 'https://f.test', fetchImpl })
    const reqs = buildX402PaymentRequirements({
      requirement: requirement(),
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      network: 'hedera:testnet',
    })
    await client.verify({
      payload: { x402Version: 2, accepted: reqs, payload: { transaction: 'AA' } },
      requirements: reqs,
    })
    expect(JSON.parse(bodies[0]!).x402Version).toBe(2)
  })
})

describe('x402 adapter', () => {
  const quote = {
    quoteId: 'quote_1',
    expiresAt: FUTURE,
    actionHash: 'a'.repeat(64),
    pricing: { kind: 'fixed-hbar', amountTinybar: '100000000', rail: 'x402' },
  } as unknown as QuoteResponse

  it('creates a requirement carrying scheme, network and feePayer metadata', async () => {
    const { adapter: a } = adapter()
    const req = await a.createPaymentRequirement({ quote, correlationId: 'corr_1' })
    expect(req.rail).toBe('x402')
    expect(req.amount).toBe('100000000')
    expect(req.recipient).toBe(PAY_TO)
    expect(req.metadata?.['scheme']).toBe(X402_EXACT_SCHEME)
    expect(req.metadata?.['network']).toBe('hedera:testnet')
    expect(req.metadata?.['feePayer']).toBe(FEE_PAYER)
  })

  it('discovers the fee payer from /supported when not configured', async () => {
    const f = stubFacilitator()
    const a = new X402HederaAdapter({ facilitator: f.client, payTo: PAY_TO, network: 'testnet' })
    const req = await a.createPaymentRequirement({ quote, correlationId: 'corr_1' })
    expect(req.metadata?.['feePayer']).toBe(FEE_PAYER)
    expect(f.calls).toContain('GET /supported')
  })

  it('rejects metered pricing, which has no exact amount', async () => {
    const { adapter: a } = adapter()
    const metered = { ...quote, pricing: { kind: 'metered', rail: 'x402' } } as unknown as QuoteResponse
    await expect(
      a.createPaymentRequirement({ quote: metered, correlationId: 'c' }),
    ).rejects.toBeInstanceOf(X402MappingError)
  })

  it('validates a well-formed payload through the facilitator', async () => {
    const { adapter: a, calls } = adapter()
    const req = requirement()
    const v = await a.validatePaymentPayload({
      requirement: req,
      payload: payment(await header(a, req)),
    })
    expect(v.ok).toBe(true)
    expect(v.checks['facilitatorVerify']?.ok).toBe(true)
    expect(calls).toContain('POST /verify')
  })

  it('fails validation on a malformed X-PAYMENT header without calling the facilitator', async () => {
    const f = stubFacilitator()
    const a = new X402HederaAdapter({
      facilitator: f.client,
      payTo: PAY_TO,
      network: 'testnet',
      feePayer: FEE_PAYER,
    })
    const v = await a.validatePaymentPayload({
      requirement: requirement(),
      payload: payment('!!!not-base64-json!!!'),
    })
    expect(v.ok).toBe(false)
    expect(v.checks['payloadDecodes']?.ok).toBe(false)
    expect(f.calls).not.toContain('POST /verify')
  })

  it('fails validation when the payload amount does not match the requirement', async () => {
    const { adapter: a } = adapter()
    const req = requirement()
    const tampered = await header(a, req, (p) => ({
      ...p,
      accepted: { ...p.accepted, amount: '1' },
    }))
    const v = await a.validatePaymentPayload({ requirement: req, payload: payment(tampered) })
    expect(v.ok).toBe(false)
    expect(v.checks['requirementsMatch']?.ok).toBe(false)
  })

  it('fails validation when the payload targets a different network', async () => {
    const { adapter: a } = adapter()
    const req = requirement()
    const wrongNet = await header(a, req, (p) => ({
      ...p,
      accepted: { ...p.accepted, network: 'hedera:mainnet' },
    }))
    const v = await a.validatePaymentPayload({ requirement: req, payload: payment(wrongNet) })
    expect(v.ok).toBe(false)
    expect(v.checks['network']?.ok).toBe(false)
  })

  it('propagates a facilitator verify rejection with its reason', async () => {
    const f = stubFacilitator({
      verify: { isValid: false, invalidReason: 'invalid_exact_hedera_payload_signature_invalid' },
    })
    const a = new X402HederaAdapter({
      facilitator: f.client,
      payTo: PAY_TO,
      network: 'testnet',
      feePayer: FEE_PAYER,
    })
    const req = requirement()
    const v = await a.validatePaymentPayload({
      requirement: req,
      payload: payment(await header(a, req)),
    })
    expect(v.ok).toBe(false)
    expect(v.checks['facilitatorVerify']?.detail).toContain('signature_invalid')
  })

  it('settles and anchors the on-chain transaction id', async () => {
    const { adapter: a, calls } = adapter()
    const req = requirement()
    const result = await a.settlePayment({
      requirement: req,
      payload: payment(await header(a, req)),
      idempotencyKey: 'idem_1',
    })
    expect(result.ok).toBe(true)
    expect(result.rail).toBe('x402')
    expect(result.settlementId).toBe('0.0.1235@1700000000.000000000')
    expect(result.settlementHash).toMatch(/^[0-9a-f]{64}$/)
    expect(calls).toContain('POST /settle')

    const status = await a.getSettlementStatus(result.settlementId)
    expect(status.state).toBe('confirmed')

    const receipt = await a.produceSettlementReceipt(result.settlementId)
    const verified = await a.verifySettlementReceipt(receipt)
    expect(verified.ok).toBe(true)

    const detail = a.settlementDetail(result.settlementId)
    expect(detail?.hashscanUrl).toContain('hashscan.io/testnet/transaction/')
    expect(detail?.payer).toBe(FEE_PAYER)
  })

  it('rejects a replayed paymentId before contacting the facilitator', async () => {
    const f = stubFacilitator()
    const a = new X402HederaAdapter({
      facilitator: f.client,
      payTo: PAY_TO,
      network: 'testnet',
      feePayer: FEE_PAYER,
    })
    const req = requirement()
    const pay = payment(await header(a, req))
    await a.settlePayment({ requirement: req, payload: pay, idempotencyKey: 'i1' })
    const settleCalls = f.calls.filter((c) => c === 'POST /settle').length
    await expect(
      a.settlePayment({ requirement: req, payload: pay, idempotencyKey: 'i1' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError)
    expect(f.calls.filter((c) => c === 'POST /settle').length).toBe(settleCalls)
  })

  it('throws when the facilitator reports settlement failure', async () => {
    const f = stubFacilitator({
      settle: {
        success: false,
        errorReason: 'insufficient_funds',
        errorMessage: 'payer balance too low',
        transaction: '',
        network: 'hedera:testnet',
      },
    })
    const a = new X402HederaAdapter({
      facilitator: f.client,
      payTo: PAY_TO,
      network: 'testnet',
      feePayer: FEE_PAYER,
    })
    const req = requirement()
    await expect(
      a.settlePayment({
        requirement: req,
        payload: payment(await header(a, req)),
        idempotencyKey: 'i1',
      }),
    ).rejects.toThrowError(/insufficient_funds/)
  })

  it('refuses to settle a payload whose requirements were swapped after quoting', async () => {
    const { adapter: a } = adapter()
    const req = requirement()
    const tampered = await header(a, req, (p) => ({
      ...p,
      accepted: { ...p.accepted, payTo: '0.0.6666' },
    }))
    await expect(
      a.settlePayment({ requirement: req, payload: payment(tampered), idempotencyKey: 'i1' }),
    ).rejects.toBeInstanceOf(X402MappingError)
  })

  it('does not retry settle (a retry could double-submit)', async () => {
    let attempts = 0
    const fetchImpl: FetchLike = async (url) => {
      const path = url.replace(/^https?:\/\/[^/]+/, '')
      if (path === '/settle') {
        attempts += 1
        return { ok: false, status: 500, text: async () => 'boom' }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            kinds: [
              { x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: FEE_PAYER } },
            ],
            extensions: [],
          }),
      }
    }
    const client = new X402FacilitatorClient({ baseUrl: 'https://f.test', fetchImpl })
    const a = new X402HederaAdapter({
      facilitator: client,
      payTo: PAY_TO,
      network: 'testnet',
      feePayer: FEE_PAYER,
    })
    const req = requirement()
    await expect(
      a.settlePayment({
        requirement: req,
        payload: payment(await header(a, req)),
        idempotencyKey: 'i1',
      }),
    ).rejects.toBeInstanceOf(X402FacilitatorError)
    expect(attempts).toBe(1)
  })
})

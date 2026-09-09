/**
 * v0.2.0-alpha.1 DoD tests — the Router/Broker quote contract.
 *
 * Covers: signature mismatch, quote→requirement binding, both expiry paths,
 * unregistered agent, and QUOTE_VERIFIED event ordering in the HCS chain.
 */

import { describe, it, expect } from 'vitest'
import { AgentRegistry } from '../../src/registry'
import { Router } from '../../src/router'
import { Broker } from '../../src/broker'
import { MockHcsEmitter } from '../../src/hcs'
import { MockPaymentAdapter } from '../../src/settlement'
import {
  AlwaysTrustQuoteVerifier,
  RegistryQuoteVerifier,
  mockQuoteSignature,
  quoteCoreHash,
  toQuoteCore,
} from '../../src/quotes'
import { policy } from '../../src/policy'
import { QuoteExpiredError, QuoteSignatureError } from '../../src/errors'
import { newCorrelationId } from '../../src/utils/ids'
import type { RuleSet } from '../../src/policy'
import type { AgentCard, IntentRequest, QuoteResponse } from '../../src/types'

const CARD: AgentCard = {
  identity: { id: 'agent-x', publicKey: 'pk-agent-x' },
  manifest: { id: 'm', kind: 'agent-runtime', version: '0' },
  capabilities: [
    {
      id: 'cap-x',
      agentId: 'agent-x',
      name: 'invoice.analyze',
      description: '',
      tags: ['demo'],
      pricing: { kind: 'fixed-hbar', amountTinybar: '100000000' },
      allowedRails: ['hedera-hbar'],
      adapterId: 'demo',
    },
  ],
}

function world(opts: { ttlMs?: number; now?: Date } = {}) {
  const registry = new AgentRegistry()
  registry.register(CARD)
  const router = new Router(registry)
  const intent: IntentRequest = {
    intentId: 'i1',
    correlationId: newCorrelationId(),
    caller: { id: 'u1', role: 'user' },
    capabilityFilter: { name: 'invoice.analyze' },
    action: { hello: 'world' },
  }
  const caps = router.discover(intent)
  const quoteReq = router.buildQuoteRequest(intent, caps[0]!)
  const quote = router.mockQuoteFromCapability(quoteReq, CARD, opts)
  return { registry, router, intent, quote }
}

function broker(
  registry: AgentRegistry,
  rules: RuleSet = policy.compose([policy.allow({ description: 'allow all' })]),
) {
  const emitter = new MockHcsEmitter()
  return {
    emitter,
    broker: new Broker({
      emitter,
      paymentAdapter: new MockPaymentAdapter(),
      rules,
      operatorId: 'op',
      topicId: '0.0.test',
      quoteVerifier: new RegistryQuoteVerifier(registry),
    }),
  }
}

describe('Router quote construction', () => {
  it('stamps paymentRequirement.quoteHash BEFORE signing', () => {
    const { quote } = world()
    // The stamped hash equals the hash of the quote core...
    expect(quote.paymentRequirement.quoteHash).toBe(quoteCoreHash(toQuoteCore(quote)))
    expect(quote.paymentRequirement.quoteHash).toMatch(/^[0-9a-f]{64}$/)
    // ...and the signature covers the payment requirement that carries it,
    // so recomputing the signature over the signed quote reproduces it.
    const { signature, ...unsigned } = quote
    expect(mockQuoteSignature(CARD.identity, unsigned)).toBe(signature)
  })

  it('binds the signature to agent identity material, not just the agent id', () => {
    const { quote } = world()
    const { signature, ...unsigned } = quote
    const imposter = { id: 'agent-x', publicKey: 'pk-imposter' }
    expect(mockQuoteSignature(imposter, unsigned)).not.toBe(signature)
  })
})

describe('RegistryQuoteVerifier', () => {
  it('accepts a well-formed quote', () => {
    const { registry, quote } = world()
    const result = new RegistryQuoteVerifier(registry).verify(quote, { now: new Date() })
    expect(result.ok).toBe(true)
    expect(result.failedCheck).toBeUndefined()
  })

  it('rejects an unregistered agent (fails closed)', () => {
    const { quote } = world()
    const empty = new AgentRegistry()
    const result = new RegistryQuoteVerifier(empty).verify(quote, { now: new Date() })
    expect(result.ok).toBe(false)
    expect(result.failedCheck).toBe('agentKnown')
  })

  it('detects a tampered payment requirement (swapped recipient)', () => {
    const { registry, quote } = world()
    const tampered: QuoteResponse = {
      ...quote,
      paymentRequirement: { ...quote.paymentRequirement, recipient: 'mock:attacker' },
    }
    const result = new RegistryQuoteVerifier(registry).verify(tampered, { now: new Date() })
    expect(result.ok).toBe(false)
    expect(result.failedCheck).toBe('signature')
  })

  it('detects a re-signed quote that demands a different amount than it priced', () => {
    const { registry, quote } = world()
    // An agent able to produce signatures could try to advertise one price in
    // `pricing` (what the policy engine reads) while demanding another in
    // `paymentRequirement` (what settlement pays). The core hash alone does
    // not catch this — `requirementConsistent` does.
    const rest = (() => {
      const { signature: _drop, ...r } = {
        ...quote,
        paymentRequirement: { ...quote.paymentRequirement, amount: '999999999' },
      }
      return r as Omit<QuoteResponse, 'signature'>
    })()
    const resigned: QuoteResponse = {
      ...rest,
      signature: mockQuoteSignature(CARD.identity, rest),
    }
    const result = new RegistryQuoteVerifier(registry).verify(resigned, { now: new Date() })
    expect(result.ok).toBe(false)
    expect(result.failedCheck).toBe('requirementConsistent')
    expect(result.checks.signature.ok).toBe(true)
    expect(result.checks.quoteHashBinding.ok).toBe(true)
  })

  it('detects a requirement whose rail or actionHash contradicts the quote', () => {
    const { registry, quote } = world()
    const swappedRail: QuoteResponse = {
      ...quote,
      paymentRequirement: { ...quote.paymentRequirement, rail: 'x402' },
    }
    expect(
      new RegistryQuoteVerifier(registry).verify(swappedRail, { now: new Date() })
        .checks.requirementConsistent.ok,
    ).toBe(false)

    const swappedAction: QuoteResponse = {
      ...quote,
      paymentRequirement: { ...quote.paymentRequirement, actionHash: 'a'.repeat(64) },
    }
    expect(
      new RegistryQuoteVerifier(registry).verify(swappedAction, { now: new Date() })
        .checks.requirementConsistent.ok,
    ).toBe(false)
  })

  it('still catches an unbound requirement via the core hash', () => {
    const { registry, quote } = world()
    const unbound: QuoteResponse = {
      ...quote,
      paymentRequirement: { ...quote.paymentRequirement, quoteHash: 'b'.repeat(64) },
    }
    const rest = (() => {
      const { signature: _drop, ...r } = unbound
      return r as Omit<QuoteResponse, 'signature'>
    })()
    const resigned: QuoteResponse = { ...rest, signature: mockQuoteSignature(CARD.identity, rest) }
    const result = new RegistryQuoteVerifier(registry).verify(resigned, { now: new Date() })
    expect(result.ok).toBe(false)
    expect(result.failedCheck).toBe('quoteHashBinding')
  })

  it('rejects an expired quote', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const { registry, quote } = world({ ttlMs: 1_000, now })
    const later = new Date(now.getTime() + 60_000)
    const result = new RegistryQuoteVerifier(registry).verify(quote, { now: later })
    expect(result.ok).toBe(false)
    expect(result.failedCheck).toBe('quoteExpiry')
  })

  it('rejects an expired paymentRequirement even when the quote is still live', () => {
    const { registry, quote } = world()
    const stale: QuoteResponse = {
      ...quote,
      paymentRequirement: {
        ...quote.paymentRequirement,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    }
    // Re-stamp + re-sign so signature and binding both pass and expiry is
    // the only failing check.
    const core = toQuoteCore(stale)
    const rebound = {
      ...stale,
      paymentRequirement: { ...stale.paymentRequirement, quoteHash: quoteCoreHash(core) },
    }
    const { signature: _s, ...unsigned } = rebound
    const signed: QuoteResponse = {
      ...(unsigned as Omit<QuoteResponse, 'signature'>),
      signature: mockQuoteSignature(CARD.identity, unsigned as Omit<QuoteResponse, 'signature'>),
    }
    const result = new RegistryQuoteVerifier(registry).verify(signed, { now: new Date() })
    expect(result.ok).toBe(false)
    expect(result.failedCheck).toBe('paymentRequirementExpiry')
  })

  it('rejects an unparseable expiry rather than treating it as valid', () => {
    const { registry, quote } = world()
    const bad: QuoteResponse = { ...quote, expiresAt: 'not-a-date' }
    const result = new RegistryQuoteVerifier(registry).verify(bad, { now: new Date() })
    expect(result.ok).toBe(false)
  })
})

describe('Broker quote gate', () => {
  it('throws QuoteSignatureError on signature mismatch and never pays', async () => {
    const { registry, intent, quote } = world()
    const { emitter, broker: b } = broker(registry)
    const tampered: QuoteResponse = {
      ...quote,
      paymentRequirement: { ...quote.paymentRequirement, recipient: 'mock:attacker' },
    }
    await expect(
      b.runFlow({ intent, quote: tampered, execute: async () => ({ ok: true }) }),
    ).rejects.toBeInstanceOf(QuoteSignatureError)

    const events = await emitter.readByCorrelation(intent.correlationId)
    const verified = events.find((e) => e.eventType === 'QUOTE_VERIFIED')
    expect(verified).toBeDefined()
    expect((verified!.payload as { ok: boolean }).ok).toBe(false)
    expect((verified!.payload as { failedCheck: string }).failedCheck).toBe('signature')
    // fails closed: nothing downstream of the gate ran
    expect(events.find((e) => e.eventType === 'POLICY_EVALUATED')).toBeUndefined()
    expect(events.find((e) => e.eventType === 'PAYMENT_REQUIRED')).toBeUndefined()
    expect(events.find((e) => e.eventType === 'EXECUTION_STARTED')).toBeUndefined()
  })

  it('throws QuoteExpiredError on an expired quote and never pays', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const { registry, intent, quote } = world({ ttlMs: 1_000, now })
    const { emitter, broker: b } = broker(registry)
    await expect(
      b.runFlow({
        intent,
        quote,
        execute: async () => ({ ok: true }),
        now: () => new Date(now.getTime() + 60_000),
      }),
    ).rejects.toBeInstanceOf(QuoteExpiredError)

    const events = await emitter.readByCorrelation(intent.correlationId)
    const verified = events.find((e) => e.eventType === 'QUOTE_VERIFIED')
    expect((verified!.payload as { failedCheck: string }).failedCheck).toBe('quoteExpiry')
    expect(events.find((e) => e.eventType === 'PAYMENT_REQUIRED')).toBeUndefined()
  })

  it('rejects a quote from an agent that is not in the registry', async () => {
    const { intent, quote } = world()
    const { broker: b } = broker(new AgentRegistry())
    await expect(
      b.runFlow({ intent, quote, execute: async () => ({ ok: true }) }),
    ).rejects.toBeInstanceOf(QuoteSignatureError)
  })

  it('emits QUOTE_VERIFIED after QUOTE_RECEIVED and before POLICY_EVALUATED', async () => {
    const { registry, intent, quote } = world()
    const { emitter, broker: b } = broker(registry)
    await b.runFlow({ intent, quote, execute: async () => ({ ok: true }) })
    const order = (await emitter.readByCorrelation(intent.correlationId)).map((e) => e.eventType)
    expect(order).toEqual([
      'INTENT_CREATED',
      'AGENTS_DISCOVERED',
      'QUOTE_REQUESTED',
      'QUOTE_RECEIVED',
      'QUOTE_VERIFIED',
      'POLICY_EVALUATED',
      'PAYMENT_REQUIRED',
      'PAYMENT_VERIFIED',
      'EXECUTION_STARTED',
      'EXECUTION_COMPLETED',
      'RECEIPT_ISSUED',
    ])
  })

  it('anchors the QUOTE_VERIFIED hash into the receipt and the verifier checks it', async () => {
    const { registry, intent, quote } = world()
    const { emitter, broker: b } = broker(registry)
    const out = await b.runFlow({ intent, quote, execute: async () => ({ ok: true }) })
    const events = await emitter.readByCorrelation(intent.correlationId)
    const verified = events.find((e) => e.eventType === 'QUOTE_VERIFIED')!
    expect((verified.payload as { quoteVerificationHash: string }).quoteVerificationHash).toBe(
      out.receipt.quoteVerificationHash,
    )
    expect(out.verification.checks.quoteVerified.ok).toBe(true)
  })

  it('receipt verification fails when the QUOTE_VERIFIED anchor is swapped', async () => {
    const { registry, intent, quote } = world()
    const { emitter, broker: b } = broker(registry)
    const out = await b.runFlow({ intent, quote, execute: async () => ({ ok: true }) })
    const { verifyReceipt } = await import('../../src/receipts')
    const forged = { ...out.receipt, quoteVerificationHash: 'f'.repeat(64) }
    const result = await verifyReceipt(forged, emitter)
    expect(result.ok).toBe(false)
    expect(result.checks.quoteVerified.ok).toBe(false)
  })

  it('a trust-all verifier still produces a chain that fails no ordering check', async () => {
    // Guards the escape hatch: it must not skip the event, only the checks.
    const { registry: _r, intent, quote } = world()
    const emitter = new MockHcsEmitter()
    const b = new Broker({
      emitter,
      paymentAdapter: new MockPaymentAdapter(),
      rules: policy.compose([policy.allow({ description: 'allow all' })]),
      operatorId: 'op',
      topicId: '0.0.test',
      quoteVerifier: new AlwaysTrustQuoteVerifier(),
    })
    const out = await b.runFlow({ intent, quote, execute: async () => ({ ok: true }) })
    expect(out.verification.ok).toBe(true)
    const events = await emitter.readByCorrelation(intent.correlationId)
    expect(events.find((e) => e.eventType === 'QUOTE_VERIFIED')).toBeDefined()
  })
})

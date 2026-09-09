/**
 * Hedron canonical local demo — mocked end-to-end.
 *
 * No credentials required. Walks the entire discover → quote → policy →
 * pay → execute → receipt loop against in-memory adapters, then verifies the
 * receipt against the mock HCS emitter chain.
 *
 *   npm run demo:local
 */

import { AgentRegistry } from '../src/registry'
import { Router } from '../src/router'
import { Broker } from '../src/broker'
import { MockHcsEmitter } from '../src/hcs'
import { MockPaymentAdapter } from '../src/settlement'
import { RegistryQuoteVerifier } from '../src/quotes'
import { policy } from '../src/policy'
import { newCorrelationId, newPaymentId } from '../src/utils/ids'
import type { AgentCard, IntentRequest } from '../src/types'

async function main(): Promise<number> {
  // 1. Registry + three example agents
  const registry = new AgentRegistry()

  const exampleAgents: AgentCard[] = [
    {
      identity: {
        id: 'agent-analyzer',
        displayName: 'Analyzer Agent',
        publicKey: 'pk-agent-analyzer',
      },
      manifest: {
        id: 'hedron/example-analyzer',
        kind: 'agent-runtime',
        version: '0.2.0-alpha.0',
      },
      capabilities: [
        {
          id: 'cap-analyze-invoice',
          agentId: 'agent-analyzer',
          name: 'invoice.analyze',
          description: 'Analyzes an invoice and returns structured fields + risk score',
          tags: ['invoice', 'analysis'],
          pricing: { kind: 'fixed-hbar', amountTinybar: '100000000' }, // 1 HBAR
          allowedRails: ['hedera-hbar'],
          adapterId: 'hedron/example-analyzer',
        },
      ],
    },
    {
      identity: {
        id: 'agent-verifier',
        displayName: 'Verifier Agent',
        publicKey: 'pk-agent-verifier',
      },
      manifest: {
        id: 'hedron/example-verifier',
        kind: 'agent-runtime',
        version: '0.2.0-alpha.0',
      },
      capabilities: [
        {
          id: 'cap-verify-invoice',
          agentId: 'agent-verifier',
          name: 'invoice.verify',
          description: 'Verifies invoice authenticity against business rules',
          tags: ['invoice', 'verification'],
          pricing: { kind: 'fixed-hbar', amountTinybar: '200000000' }, // 2 HBAR
          allowedRails: ['hedera-hbar', 'x402'],
          adapterId: 'hedron/example-verifier',
        },
      ],
    },
    {
      identity: {
        id: 'agent-settler',
        displayName: 'Settlement Agent',
        publicKey: 'pk-agent-settler',
      },
      manifest: {
        id: 'hedron/example-settler',
        kind: 'agent-runtime',
        version: '0.2.0-alpha.0',
      },
      capabilities: [
        {
          id: 'cap-settle-invoice',
          agentId: 'agent-settler',
          name: 'invoice.settle',
          description: 'Settles an invoice via HBAR transfer',
          tags: ['invoice', 'settlement'],
          pricing: { kind: 'fixed-hbar', amountTinybar: '300000000' }, // 3 HBAR
          allowedRails: ['hedera-hbar'],
          adapterId: 'hedron/example-settler',
        },
      ],
    },
  ]

  for (const card of exampleAgents) registry.register(card)
  console.log(`✔ registry: ${registry.list().length} agents registered`)

  // 2. Router + intent
  const router = new Router(registry)

  const intent: IntentRequest = {
    intentId: `intent_${newPaymentId().slice(4)}`,
    correlationId: newCorrelationId(),
    caller: { id: 'demo-user', role: 'user' },
    capabilityFilter: { name: 'invoice.analyze' },
    action: { kind: 'analyze', payload: { invoiceId: 'INV-001', amountUsd: '120.00' } },
  }

  const caps = router.discover(intent)
  console.log(`✔ router.discover: ${caps.length} capability match(es)`)
  if (caps.length === 0) {
    console.error('✗ no capability matched the intent')
    return 1
  }

  const chosenCap = caps[0]!
  const card = registry.get(chosenCap.agentId)!
  const quoteReq = router.buildQuoteRequest(intent, chosenCap)
  const quote = router.mockQuoteFromCapability(quoteReq, card)
  console.log(`✔ quote: ${quote.quoteId} (rail=${quote.pricing.rail})`)

  // 3. Policy: deny > 5 HBAR, require approval > 2 HBAR
  const rules = policy.compose([
    policy.allowedRails({ rails: ['hedera-hbar', 'hedera-hts', 'x402'] }),
    policy.maxPricePerCall({ asset: 'hbar', maxAmountTinybar: '500000000' }), // 5 HBAR
    policy.approvalThreshold({
      asset: 'hbar',
      overTinybar: '200000000', // > 2 HBAR
      approverScope: 'operator',
    }),
    policy.allow({ description: 'default-allow after gates' }),
  ])

  // 4. Broker + mock HCS + mock payment
  const emitter = new MockHcsEmitter()
  const paymentAdapter = new MockPaymentAdapter()
  const broker = new Broker({
    emitter,
    paymentAdapter,
    rules,
    operatorId: 'demo-operator',
    topicId: '0.0.demo',
    quoteVerifier: new RegistryQuoteVerifier(registry),
  })

  const { receipt, verification } = await broker.runFlow({
    intent,
    quote,
    approver: async () => ({ approvalId: 'apv_demo', approverId: 'demo-operator' }),
    execute: async (action) => ({
      stub: true,
      action,
      message: 'mock execution result — replace with provider call',
    }),
  })

  console.log('\n--- Receipt ---')
  console.log(JSON.stringify(receipt, null, 2))
  console.log('\n--- Verification ---')
  for (const [name, c] of Object.entries(verification.checks)) {
    console.log(`${c.ok ? '✔' : '✗'} ${name.padEnd(20)}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log(verification.ok ? '\nReceipt verified ✅' : '\nVerification FAILED ❌')
  return verification.ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)

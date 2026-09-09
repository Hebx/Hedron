/**
 * Hedron × Hedera Agent Kit v4 — buyer agent example.
 *
 * Runs the full Hedron commerce loop through HAK v4 tools, with Hedron's
 * policy engine bridged onto HAK's four lifecycle stages. No credentials and
 * no network access required: the Hedera `Client` is never used by Hedron
 * tools, settlement is the in-memory mock adapter, and HCS is the mock emitter.
 *
 *   npx tsx examples/hak-v4-buyer/index.ts
 *
 * What it demonstrates:
 *   1. explicit plugin registration (HAK v4 requires an explicit `plugins` array)
 *   2. hooks/policies registered on `configuration.context.hooks`
 *   3. discover → quote → pay → verify → audit through the tool surface
 *   4. a policy DENY path that blocks a payment over the spend cap
 */

import { ToolDiscovery, AgentMode } from '@hashgraph/hedera-agent-kit'
import type { Context } from '@hashgraph/hedera-agent-kit'
import type { Client } from '@hiero-ledger/sdk'

import { AgentRegistry } from '../../src/registry'
import { Router } from '../../src/router'
import { Broker } from '../../src/broker'
import { MockHcsEmitter } from '../../src/hcs'
import { MockPaymentAdapter } from '../../src/settlement'
import { RegistryQuoteVerifier } from '../../src/quotes'
import { policy } from '../../src/policy'
import {
  LocalHedronCommercePort,
  buildHedronHooks,
  buildHedronPlugin,
  hedronToolNames,
} from '../../src/adapters/hedera-agent-kit'
import type { AgentCard } from '../../src/types'

/** Hedron tools never touch the Hedera client, so an empty stub is honest here. */
const OFFLINE_CLIENT = {} as Client

const PROVIDER: AgentCard = {
  identity: { id: 'agent-analyzer', publicKey: 'pk-analyzer', displayName: 'Analyzer Agent' },
  manifest: { id: 'hedron/example-analyzer', kind: 'agent-runtime', version: '0.2.0' },
  capabilities: [
    {
      id: 'cap-analyze',
      agentId: 'agent-analyzer',
      name: 'invoice.analyze',
      description: 'Analyzes an invoice and returns structured fields + risk score',
      tags: ['invoice', 'analysis'],
      pricing: { kind: 'fixed-hbar', amountTinybar: '100000000' }, // 1 HBAR
      allowedRails: ['hedera-hbar'],
      adapterId: 'hedron/example-analyzer',
    },
  ],
}

async function main(): Promise<number> {
  // --- 1. Hedron runtime -----------------------------------------------------
  const registry = new AgentRegistry()
  registry.register(PROVIDER)

  const router = new Router(registry)
  const emitter = new MockHcsEmitter()
  const quoteVerifier = new RegistryQuoteVerifier(registry)
  const paymentAdapter = new MockPaymentAdapter()
  const rules = policy.compose([
    policy.allowedRails({ rails: ['hedera-hbar'] }),
    policy.maxPricePerCall({ asset: 'hbar', maxAmountTinybar: '500000000' }), // 5 HBAR
    policy.allow({ description: 'default-allow after gates' }),
  ])
  const broker = new Broker({
    emitter,
    paymentAdapter,
    rules,
    operatorId: 'example-operator',
    topicId: '0.0.example',
    quoteVerifier,
  })

  const port = new LocalHedronCommercePort({
    registry,
    router,
    broker,
    emitter,
    quoteVerifier,
    rules,
    paymentAdapter,
    defaultCaller: { id: 'hak-buyer', role: 'agent' },
    execute: async (action) => ({
      riskScore: 0.12,
      fields: { invoiceId: (action as { invoiceId?: string }).invoiceId ?? 'unknown' },
    }),
  })

  const deps = { port, rules, registry, emitter }

  // --- 2. HAK v4 registration ------------------------------------------------
  // Plugins are explicit in v4: an empty array means zero tools.
  const plugin = buildHedronPlugin(deps)
  // Hooks AND policies both live on context.hooks — there is no plugin-level
  // `policies` field in HAK v4.
  const context: Context = {
    mode: AgentMode.AUTONOMOUS,
    hooks: buildHedronHooks(deps, {
      allowedRoles: ['user', 'app', 'agent'],
      maxAmountTinybar: '500000000', // 5 HBAR per call
    }),
  }
  const configuration = { plugins: [plugin], context }

  const discovery = ToolDiscovery.createFromConfiguration(configuration)
  const tools = discovery.getAllTools(context, configuration)
  const tool = (method: string) => {
    const t = tools.find((x) => x.method === method)
    if (!t) throw new Error(`tool ${method} not registered`)
    return t
  }

  console.log(`✔ HAK plugin "${plugin.name}" registered ${tools.length} tools:`)
  for (const t of tools) console.log(`    · ${t.method} — ${t.name}`)

  // --- 3. Happy path ---------------------------------------------------------
  console.log('\n--- discover ---')
  const listed = await tool(hedronToolNames.LIST_AGENTS).execute(OFFLINE_CLIENT, context, {
    name: 'invoice.analyze',
  })
  console.log(listed.humanMessage)

  console.log('\n--- quote ---')
  const quoted = await tool(hedronToolNames.GET_QUOTE).execute(OFFLINE_CLIENT, context, {
    capabilityId: 'cap-analyze',
    agentId: 'agent-analyzer',
    action: { invoiceId: 'INV-001', amountUsd: '120.00' },
  })
  console.log(quoted.humanMessage)
  if (quoted.raw?.error) {
    console.error('✗ quote failed:', quoted.raw.error)
    return 1
  }
  const quoteId = quoted.raw.quoteId as string
  const correlationId = quoted.raw.paymentRequirement.correlationId as string

  console.log('\n--- pay (runs verify → policy → settle → execute → receipt) ---')
  const paid = await tool(hedronToolNames.PAY).execute(OFFLINE_CLIENT, context, { quoteId })
  if (paid.raw?.error) {
    console.error('✗ payment failed:', paid.raw.error)
    return 1
  }
  console.log(paid.humanMessage)
  const receiptId = paid.raw.receiptId as string

  console.log('\n--- verify receipt ---')
  const verified = await tool(hedronToolNames.VERIFY_RECEIPT).execute(OFFLINE_CLIENT, context, {
    receiptId,
  })
  console.log(verified.humanMessage)
  for (const [name, check] of Object.entries(
    verified.raw.checks as Record<string, { ok: boolean; detail?: string }>,
  )) {
    console.log(`  ${check.ok ? '✔' : '✗'} ${name}${check.detail ? ` — ${check.detail}` : ''}`)
  }

  console.log('\n--- audit trail (HCS event chain) ---')
  const trail = await tool(hedronToolNames.GET_AUDIT_TRAIL).execute(OFFLINE_CLIENT, context, {
    correlationId,
  })
  console.log(trail.humanMessage)

  // --- 4. Policy DENY path ---------------------------------------------------
  console.log('\n--- policy deny: spend cap of 0.5 HBAR against a 1 HBAR quote ---')
  const strictContext: Context = {
    mode: AgentMode.AUTONOMOUS,
    hooks: buildHedronHooks(deps, { maxAmountTinybar: '50000000' }), // 0.5 HBAR
  }
  const strictConfiguration = { plugins: [plugin], context: strictContext }
  const strictDiscovery = ToolDiscovery.createFromConfiguration(strictConfiguration)
  const strictTools = strictDiscovery.getAllTools(strictContext, strictConfiguration)

  const quoted2 = await strictTools
    .find((t) => t.method === hedronToolNames.GET_QUOTE)!
    .execute(OFFLINE_CLIENT, strictContext, {
      capabilityId: 'cap-analyze',
      agentId: 'agent-analyzer',
      action: { invoiceId: 'INV-002' },
    })
  const blocked = await strictTools
    .find((t) => t.method === hedronToolNames.PAY)!
    .execute(OFFLINE_CLIENT, strictContext, { quoteId: quoted2.raw.quoteId })

  const wasBlocked = typeof blocked.raw?.error === 'string' && blocked.raw.error.includes('blocked by policy')
  console.log(wasBlocked ? `✔ blocked as expected: ${blocked.raw.error}` : '✗ NOT blocked')

  const ok = verified.raw.ok === true && wasBlocked
  console.log(ok ? '\nHAK v4 buyer example passed ✅' : '\nHAK v4 buyer example FAILED ❌')
  return ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)

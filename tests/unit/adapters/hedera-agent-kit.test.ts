/**
 * HAK v4 plugin tests.
 *
 * These exercise the REAL `@hashgraph/hedera-agent-kit@4.0.0` runtime:
 * `ToolDiscovery` resolves the plugin, and tools are executed through
 * `BaseTool.execute` so the four lifecycle hooks and the policy bridge
 * actually fire. No testnet keys are needed — the Hedera `Client` is only
 * passed through to our `coreAction`, which never touches the network.
 */

import { describe, it, expect } from 'vitest'
import { BaseTool, ToolDiscovery, AgentMode } from '@hashgraph/hedera-agent-kit'
import type { Context } from '@hashgraph/hedera-agent-kit'
import type { Client } from '@hiero-ledger/sdk'

import { AgentRegistry } from '../../../src/registry'
import { Router } from '../../../src/router'
import { Broker } from '../../../src/broker'
import { MockHcsEmitter } from '../../../src/hcs'
import { MockPaymentAdapter } from '../../../src/settlement'
import { RegistryQuoteVerifier } from '../../../src/quotes'
import { policy } from '../../../src/policy'
import {
  LocalHedronCommercePort,
  buildHedronConfiguration,
  buildHedronHooks,
  buildHedronPlugin,
  describeMinimalPlugin,
  hederaAgentKitManifest,
  hedronToolNames,
  HedronSpendTrackingHook,
  HEDRON_TOOL_METHODS,
  HAK_LIFECYCLE_STAGES,
} from '../../../src/adapters/hedera-agent-kit'
import type { AgentCard } from '../../../src/types'

const CARD: AgentCard = {
  identity: { id: 'agent-analyzer', publicKey: 'pk-analyzer' },
  manifest: { id: 'hedron/example-analyzer', kind: 'agent-runtime', version: '0.2.0' },
  capabilities: [
    {
      id: 'cap-analyze',
      agentId: 'agent-analyzer',
      name: 'invoice.analyze',
      description: 'Analyzes an invoice',
      tags: ['invoice', 'analysis'],
      pricing: { kind: 'fixed-hbar', amountTinybar: '100000000' }, // 1 HBAR
      allowedRails: ['hedera-hbar'],
      adapterId: 'hedron/example-analyzer',
    },
  ],
}

/** The Hedera client is never used by Hedron tools; a cast keeps tests offline. */
const FAKE_CLIENT = {} as Client

function buildWorld(opts: { maxPriceTinybar?: string } = {}) {
  const registry = new AgentRegistry()
  registry.register(CARD)
  const router = new Router(registry)
  const emitter = new MockHcsEmitter()
  const quoteVerifier = new RegistryQuoteVerifier(registry)
  const rules = policy.compose([
    policy.maxPricePerCall({
      asset: 'hbar',
      maxAmountTinybar: opts.maxPriceTinybar ?? '500000000',
    }),
    policy.allow({ description: 'tail' }),
  ])
  const paymentAdapter = new MockPaymentAdapter()
  const broker = new Broker({
    emitter,
    paymentAdapter,
    rules,
    operatorId: 'op',
    topicId: '0.0.test',
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
    defaultCaller: { id: 'hak-agent', role: 'agent' },
  })
  const deps = { port, rules, registry, emitter }
  return { registry, router, broker, emitter, port, deps }
}

function toolsOf(deps: ReturnType<typeof buildWorld>['deps'], context: Context = {}) {
  const plugin = buildHedronPlugin(deps)
  const discovery = ToolDiscovery.createFromConfiguration({ plugins: [plugin], context })
  const tools = discovery.getAllTools(context, { plugins: [plugin], context })
  const byMethod = new Map(tools.map((t) => [t.method, t]))
  return { plugin, tools, byMethod }
}

describe('HAK v4 plugin shape (real API)', () => {
  it('exposes a manifest listing the tool surface', () => {
    expect(hederaAgentKitManifest.id).toBe('hedron/hedera-agent-kit')
    expect(hederaAgentKitManifest.supportedCapabilities).toEqual([...HEDRON_TOOL_METHODS])
  })

  it('builds a v4 Plugin: name (not id), and tools as a FUNCTION', () => {
    const { deps } = buildWorld()
    const plugin = buildHedronPlugin(deps)
    expect(plugin.name).toBe('hedron-commerce')
    expect(typeof plugin.tools).toBe('function')
    // v4 Plugin has no `id` and no `policies` field.
    expect((plugin as Record<string, unknown>)['id']).toBeUndefined()
    expect((plugin as Record<string, unknown>)['policies']).toBeUndefined()
  })

  it('keeps the tool surface minimal: exactly six commerce tools', () => {
    const { deps } = buildWorld()
    const { tools } = toolsOf(deps)
    expect(tools).toHaveLength(6)
    expect(tools.map((t) => t.method).sort()).toEqual([...HEDRON_TOOL_METHODS].sort())
  })

  it('produces real BaseTool instances, so hooks and policies apply', () => {
    const { deps } = buildWorld()
    const { tools } = toolsOf(deps)
    for (const t of tools) {
      expect(t instanceof BaseTool).toBe(true)
      // v4 identity/schema field names
      expect(typeof t.method).toBe('string')
      expect(t.parameters).toBeDefined()
    }
  })

  it('is discoverable through HAK ToolDiscovery with an explicit plugins array', () => {
    const { deps } = buildWorld()
    const { byMethod } = toolsOf(deps)
    expect(byMethod.has(hedronToolNames.GET_QUOTE)).toBe(true)
    expect(byMethod.has(hedronToolNames.PAY)).toBe(true)
    expect(byMethod.has(hedronToolNames.VERIFY_RECEIPT)).toBe(true)
  })

  it('honours the HAK configuration.tools allowlist', () => {
    const { deps } = buildWorld()
    const plugin = buildHedronPlugin(deps)
    const configuration = { plugins: [plugin], context: {}, tools: [hedronToolNames.PAY] }
    const discovery = ToolDiscovery.createFromConfiguration(configuration)
    const tools = discovery.getAllTools({}, configuration)
    expect(tools.map((t) => t.method)).toEqual([hedronToolNames.PAY])
  })

  it('registers hooks on context, not on the plugin', () => {
    const { deps } = buildWorld()
    const { plugins, context } = buildHedronConfiguration(deps, {
      allowedRoles: ['agent'],
      maxAmountTinybar: '500000000',
    })
    expect(plugins).toHaveLength(1)
    expect(Array.isArray(context.hooks)).toBe(true)
    expect(context.hooks!.length).toBeGreaterThan(0)
  })
})

describe('HAK v4 plugin execution (end-to-end through BaseTool.execute)', () => {
  it('lists agents', async () => {
    const { deps } = buildWorld()
    const { byMethod } = toolsOf(deps)
    const out = await byMethod
      .get(hedronToolNames.LIST_AGENTS)!
      .execute(FAKE_CLIENT, {}, { name: 'invoice.analyze' })
    expect(out.raw.ok).toBe(true)
    expect(out.raw.count).toBe(1)
    expect(out.raw.capabilities[0].capabilityId).toBe('cap-analyze')
  })

  it('quotes, pays, verifies, and reads the audit trail', async () => {
    const { deps } = buildWorld()
    const { byMethod } = toolsOf(deps)

    const quoted = await byMethod.get(hedronToolNames.GET_QUOTE)!.execute(
      FAKE_CLIENT,
      {},
      { capabilityId: 'cap-analyze', agentId: 'agent-analyzer', action: { invoiceId: 'INV-1' } },
    )
    expect(quoted.raw.ok).toBe(true)
    expect(quoted.raw.verified).toBe(true)
    const quoteId = quoted.raw.quoteId as string

    const paid = await byMethod.get(hedronToolNames.PAY)!.execute(FAKE_CLIENT, {}, { quoteId })
    expect(paid.raw.ok).toBe(true)
    expect(paid.raw.status).toBe('completed')
    expect(paid.raw.quoteVerificationHash).toMatch(/^[0-9a-f]{64}$/)
    const receiptId = paid.raw.receiptId as string

    const verified = await byMethod
      .get(hedronToolNames.VERIFY_RECEIPT)!
      .execute(FAKE_CLIENT, {}, { receiptId })
    expect(verified.raw.ok).toBe(true)
    expect(verified.raw.checks.quoteVerified.ok).toBe(true)

    // The audit trail is keyed by correlationId. Take it from the quote the
    // port issued, so this asserts a real chain rather than an empty one.
    const correlationId = quoted.raw.paymentRequirement.correlationId as string
    const trail = await byMethod
      .get(hedronToolNames.GET_AUDIT_TRAIL)!
      .execute(FAKE_CLIENT, {}, { correlationId })
    expect(trail.raw.ok).toBe(true)
    expect(trail.raw.events.map((e: { eventType: string }) => e.eventType)).toEqual([
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

  it('fires all four HAK lifecycle stages in order for a Hedron tool', async () => {
    const { deps } = buildWorld()
    const tracker = new HedronSpendTrackingHook()
    const context: Context = { mode: AgentMode.AUTONOMOUS, hooks: [tracker] }
    const { byMethod } = toolsOf(deps, context)

    await byMethod
      .get(hedronToolNames.LIST_AGENTS)!
      .execute(FAKE_CLIENT, context, { name: 'invoice.analyze' })

    const stages = tracker.log().map((e) => e.stage)
    expect(stages).toEqual([...HAK_LIFECYCLE_STAGES])
  })

  it('blocks payment above the spend cap via the HAK policy bridge', async () => {
    const { deps } = buildWorld()
    // Cap of 0.5 HBAR against a 1 HBAR quote → policy must block.
    const hooks = buildHedronHooks(deps, { maxAmountTinybar: '50000000' })
    const context: Context = { hooks }
    const { byMethod } = toolsOf(deps, context)

    const quoted = await byMethod.get(hedronToolNames.GET_QUOTE)!.execute(
      FAKE_CLIENT,
      context,
      { capabilityId: 'cap-analyze', agentId: 'agent-analyzer', action: { invoiceId: 'INV-2' } },
    )
    const quoteId = quoted.raw.quoteId as string

    const blocked = await byMethod
      .get(hedronToolNames.PAY)!
      .execute(FAKE_CLIENT, context, { quoteId })
    // HAK converts a policy block into an error result rather than a throw.
    expect(blocked.raw.error).toBeDefined()
    expect(String(blocked.raw.error)).toContain('blocked by policy')
    expect(String(blocked.raw.error)).toContain('Hedron Spend Cap Policy')
  })

  it('allows payment under the spend cap', async () => {
    const { deps } = buildWorld()
    const hooks = buildHedronHooks(deps, { maxAmountTinybar: '500000000' }) // 5 HBAR
    const context: Context = { hooks }
    const { byMethod } = toolsOf(deps, context)

    const quoted = await byMethod.get(hedronToolNames.GET_QUOTE)!.execute(
      FAKE_CLIENT,
      context,
      { capabilityId: 'cap-analyze', agentId: 'agent-analyzer', action: { invoiceId: 'INV-3' } },
    )
    const paid = await byMethod
      .get(hedronToolNames.PAY)!
      .execute(FAKE_CLIENT, context, { quoteId: quoted.raw.quoteId })
    expect(paid.raw.error).toBeUndefined()
    expect(paid.raw.status).toBe('completed')
  })

  it('blocks a disallowed caller role at the pre-tool stage', async () => {
    const { deps } = buildWorld()
    const hooks = buildHedronHooks(deps, { allowedRoles: ['user'] })
    const context: Context = { hooks }
    const { byMethod } = toolsOf(deps, context)

    const denied = await byMethod.get(hedronToolNames.GET_QUOTE)!.execute(
      FAKE_CLIENT,
      context,
      {
        capabilityId: 'cap-analyze',
        agentId: 'agent-analyzer',
        action: {},
        caller: { id: 'bot', role: 'agent' },
      },
    )
    expect(String(denied.raw.error)).toContain('blocked by policy')
  })

  it('refuses to pay an unknown quote id (fails closed)', async () => {
    const { deps } = buildWorld()
    const hooks = buildHedronHooks(deps, { maxAmountTinybar: '500000000' })
    const context: Context = { hooks }
    const { byMethod } = toolsOf(deps, context)
    const out = await byMethod
      .get(hedronToolNames.PAY)!
      .execute(FAKE_CLIENT, context, { quoteId: 'quote_does_not_exist' })
    expect(out.raw.error).toBeDefined()
  })
})

describe('HAK v4 descriptive surface', () => {
  it('describes the real tool method names', () => {
    const plugin = describeMinimalPlugin()
    const ids = plugin.tools.map((t) => t.id)
    expect(ids).toContain(hedronToolNames.GET_QUOTE)
    expect(ids).toContain(hedronToolNames.PAY)
    expect(ids).toContain(hedronToolNames.VERIFY_RECEIPT)
  })

  it('describes policies against the real HAK stage method names', () => {
    const plugin = describeMinimalPlugin()
    const stages = new Set(plugin.policies.map((p) => p.stage))
    expect(stages.has('preToolExecutionHook')).toBe(true)
    expect(stages.has('postParamsNormalizationHook')).toBe(true)
    expect(stages.has('postToolExecutionHook')).toBe(true)
  })
})

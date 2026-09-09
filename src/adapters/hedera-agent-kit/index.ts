/**
 * Hedera Agent Kit v4 plugin — real implementation.
 *
 * Exposes Hedron's commerce loop to any HAK v4 host as six `BaseTool`
 * subclasses plus a policy bridge onto HAK's four lifecycle stages.
 *
 * See `docs/HEDERA_AGENT_KIT_PLUGIN.md`. The HAK v4 API shapes used here were
 * verified against the shipped `@hashgraph/hedera-agent-kit@4.0.0` type
 * declarations and a runtime smoke test, not from upstream markdown (which is
 * ahead of the release in several places).
 *
 * `@hashgraph/hedera-agent-kit`, `@hiero-ledger/sdk` and `zod` are declared as
 * OPTIONAL peer dependencies: importing `hedron` does not pull HAK in.
 * Live Hedera I/O uses `@hiero-ledger/sdk`. Only this subpath needs HAK.
 *
 *   import { buildHedronPlugin } from 'hedron/adapters/hedera-agent-kit'
 */

import type { AbstractHook, Plugin, Tool, Context } from '@hashgraph/hedera-agent-kit'
import type { AdapterManifest } from '../../types'
import { buildHedronTools, hedronToolNames, HEDRON_TOOL_METHODS } from './tools'
import { buildHedronPolicies, HAK_LIFECYCLE_STAGES } from './policies'
import type { HedronPluginDeps } from './deps'
import { LocalHedronCommercePort } from './localPort'

export const hederaAgentKitManifest: AdapterManifest = {
  id: 'hedron/hedera-agent-kit',
  kind: 'agent-runtime',
  version: '0.2.0-alpha.1',
  description: 'Exposes Hedron commerce actions as HAK v4 BaseTool plugins',
  supportedCapabilities: [...HEDRON_TOOL_METHODS],
}

/** The plugin `name` a HAK host sees. */
export const HEDRON_PLUGIN_NAME = 'hedron-commerce'

export interface BuildHedronPluginOptions {
  /** Caller roles permitted to invoke Hedron tools. Omit to skip the role gate. */
  allowedRoles?: Array<'user' | 'app' | 'agent'>
  /** Per-call spend cap in tinybar. Requires an amount resolver (auto-wired for the local port). */
  maxAmountTinybar?: string
}

/**
 * Build the Hedron HAK v4 plugin.
 *
 * NOTE on the real v4 shape: `Plugin` is `{ name, version?, description?, tools }`
 * where **`tools` is a function** `(context) => Tool[]`. There is no `id` field
 * and **no `policies` field** — hooks and policies are registered separately on
 * `configuration.context.hooks`. Use `buildHedronHooks()` for those.
 */
export function buildHedronPlugin(deps: HedronPluginDeps): Plugin {
  return {
    name: HEDRON_PLUGIN_NAME,
    version: hederaAgentKitManifest.version,
    description: 'Hedron agentic commerce: discover, quote, approve, pay, verify, audit',
    tools: (_context: Context): Tool[] => buildHedronTools(deps),
  }
}

/**
 * Build the hook/policy array for `configuration.context.hooks`.
 *
 * Kept separate from `buildHedronPlugin` because HAK v4 registers them in a
 * different place than tools — a plugin-level `policies` field does not exist.
 */
export function buildHedronHooks(
  deps: HedronPluginDeps,
  opts: BuildHedronPluginOptions = {},
): AbstractHook[] {
  const port = deps.port
  const local = port instanceof LocalHedronCommercePort ? port : undefined
  return buildHedronPolicies({
    ...(opts.allowedRoles !== undefined ? { allowedRoles: opts.allowedRoles } : {}),
    ...(opts.maxAmountTinybar !== undefined && local !== undefined
      ? {
          maxAmountTinybar: opts.maxAmountTinybar,
          resolveAmountTinybar: (quoteId: string) => local.amountTinybarFor(quoteId),
        }
      : {}),
    ...(local !== undefined
      ? { isQuoteVerified: (quoteId: string) => local.isQuoteVerified(quoteId) }
      : {}),
  })
}

/**
 * Convenience: plugin + hooks in the shape a HAK `Configuration` wants.
 *
 * ```ts
 * const { plugins, context } = buildHedronConfiguration(deps, { maxAmountTinybar: '500000000' })
 * const toolkit = new HederaLangchainToolkit({ client, configuration: { plugins, context } })
 * ```
 */
export function buildHedronConfiguration(
  deps: HedronPluginDeps,
  opts: BuildHedronPluginOptions = {},
): { plugins: Plugin[]; context: Context } {
  return {
    plugins: [buildHedronPlugin(deps)],
    context: { hooks: buildHedronHooks(deps, opts) },
  }
}

// -----------------------------------------------------------------------------
// Descriptive surface (kept: useful for docs/tests without instantiating HAK)
// -----------------------------------------------------------------------------

export interface HedronHakTool {
  id: string
  description: string
}

export interface HedronHakPolicy {
  id: string
  stage: (typeof HAK_LIFECYCLE_STAGES)[number]
  description: string
}

export interface HedronHakPlugin {
  id: string
  description: string
  tools: HedronHakTool[]
  policies: HedronHakPolicy[]
}

/**
 * Static description of the plugin surface.
 *
 * Retained for docs and for tests that assert the tool surface stays minimal
 * without needing a HAK client. The live shape comes from `buildHedronPlugin`.
 */
export function describeMinimalPlugin(): HedronHakPlugin {
  return {
    id: HEDRON_PLUGIN_NAME,
    description: 'Minimal Hedron commerce plugin: quote / pay / verify (+ helpers)',
    tools: [
      { id: hedronToolNames.LIST_AGENTS, description: 'List provider agents for a capability filter' },
      { id: hedronToolNames.GET_QUOTE, description: 'Request a quote for a capability' },
      { id: hedronToolNames.APPROVE_QUOTE, description: 'Approve a quote (HITL path)' },
      { id: hedronToolNames.PAY, description: 'Run the commerce flow and settle a quote' },
      { id: hedronToolNames.VERIFY_RECEIPT, description: 'Verify a Hedron receipt' },
      { id: hedronToolNames.GET_AUDIT_TRAIL, description: 'Fetch the HCS event chain for a flow' },
    ],
    policies: [
      {
        id: 'hedron-caller-role',
        stage: 'preToolExecutionHook',
        description: 'Reject when caller role is not allowed by Hedron policy',
      },
      {
        id: 'hedron-spend-cap',
        stage: 'postParamsNormalizationHook',
        description: 'Check per-call spend cap before a transaction is formed',
      },
      {
        id: 'hedron-quote-verified',
        stage: 'postParamsNormalizationHook',
        description: 'Block payment for a quote that fails Hedron quote verification',
      },
      {
        id: 'hedron-spend-tracking',
        stage: 'postToolExecutionHook',
        description: 'Append a spend-tracking entry to the audit log',
      },
    ],
  }
}

export * from './deps'
export * from './tools'
export * from './policies'
export * from './localPort'

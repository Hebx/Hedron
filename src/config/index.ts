import { ConfigError } from '../errors'
import { loadEnvIfNeeded } from '../utils/env'
import type { HedronConfig, HederaNetwork, PaymentRail } from '../types'

const VALID_NETWORKS: HederaNetwork[] = ['mainnet', 'testnet', 'previewnet']
const VALID_RAILS: PaymentRail[] = [
  'hedera-hbar',
  'hedera-hts',
  'x402',
  'evm-usdc',
  'mpp',
]

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ConfigError(`expected number, got "${v}"`)
  return n
}

function parseRails(v: string | undefined, def: PaymentRail[]): PaymentRail[] {
  if (!v) return def
  const rails = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const r of rails) {
    if (!VALID_RAILS.includes(r as PaymentRail)) {
      throw new ConfigError(`unknown payment rail "${r}"`)
    }
  }
  return rails as PaymentRail[]
}

function parseList(v: string | undefined): string[] {
  if (!v) return []
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Load HedronConfig from process.env. Pure: no I/O beyond `loadEnvIfNeeded`,
 * which reads `.env` once if present.
 *
 * Validation is intentionally minimal so the mocked demo can run with an
 * empty `.env`. Stricter validation lives in `validateForNetwork` below.
 */
export function loadHedronConfig(env: NodeJS.ProcessEnv = process.env): HedronConfig {
  loadEnvIfNeeded()

  const network = (env.HEDERA_NETWORK ?? 'testnet') as HederaNetwork
  if (!VALID_NETWORKS.includes(network)) {
    throw new ConfigError(`HEDERA_NETWORK must be one of ${VALID_NETWORKS.join('|')}`)
  }

  const defaultRail = (env.HEDRON_DEFAULT_PAYMENT_RAIL ?? 'hedera-hbar') as PaymentRail
  if (!VALID_RAILS.includes(defaultRail)) {
    throw new ConfigError(`HEDRON_DEFAULT_PAYMENT_RAIL must be one of ${VALID_RAILS.join('|')}`)
  }

  const demoMode = (env.DEMO_MODE ?? 'mock') as HedronConfig['flags']['demoMode']
  if (!['mock', 'testnet', 'mainnet'].includes(demoMode)) {
    throw new ConfigError(`DEMO_MODE must be mock|testnet|mainnet`)
  }

  const logLevel = (env.LOG_LEVEL ?? 'info') as HedronConfig['logging']['level']
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be debug|info|warn|error`)
  }

  const logFormat = (env.LOG_FORMAT ?? 'pretty') as HedronConfig['logging']['format']
  if (!['pretty', 'json'].includes(logFormat)) {
    throw new ConfigError(`LOG_FORMAT must be pretty|json`)
  }

  const defaultDecision = (env.HEDRON_POLICY_DEFAULT ?? 'deny') as 'deny' | 'allow'
  if (!['deny', 'allow'].includes(defaultDecision)) {
    throw new ConfigError(`HEDRON_POLICY_DEFAULT must be deny|allow`)
  }

  const cfg: HedronConfig = {
    hedera: {
      network,
      ...(env.HEDERA_OPERATOR_ID ? { operatorId: env.HEDERA_OPERATOR_ID } : {}),
      ...(env.HEDERA_OPERATOR_KEY ? { operatorKeyRef: 'env:HEDERA_OPERATOR_KEY' } : {}),
      ...(env.HEDERA_MIRROR_NODE_URL ? { mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL } : {}),
    },
    hcs: {
      ...(env.HEDRON_HCS_AUDIT_TOPIC_ID ? { auditTopicId: env.HEDRON_HCS_AUDIT_TOPIC_ID } : {}),
      ...(env.HEDRON_HCS_RECEIPT_TOPIC_ID
        ? { receiptTopicId: env.HEDRON_HCS_RECEIPT_TOPIC_ID }
        : {}),
      ...(env.HEDRON_HCS_POLICY_TOPIC_ID
        ? { policyTopicId: env.HEDRON_HCS_POLICY_TOPIC_ID }
        : {}),
    },
    router: {
      httpHost: env.HEDRON_ROUTER_HTTP_HOST ?? '0.0.0.0',
      httpPort: num(env.HEDRON_ROUTER_HTTP_PORT, 4080),
      trustedAgentIds: parseList(env.HEDRON_TRUSTED_AGENT_IDS),
      idempotencyTtlSeconds: num(env.HEDRON_IDEMPOTENCY_TTL_SECONDS, 900),
    },
    broker: {
      httpPort: num(env.HEDRON_BROKER_HTTP_PORT, 4081),
    },
    policy: {
      maxPriceHbar: env.HEDRON_POLICY_MAX_PRICE_HBAR ?? '10',
      maxDailySpendHbar: env.HEDRON_POLICY_MAX_DAILY_SPEND_HBAR ?? '100',
      requireApprovalOverHbar: env.HEDRON_POLICY_REQUIRE_APPROVAL_OVER_HBAR ?? '5',
      allowedPaymentRails: parseRails(env.HEDRON_POLICY_ALLOWED_PAYMENT_RAILS, [
        'hedera-hbar',
        'hedera-hts',
        'x402',
      ]),
      defaultDecision,
    },
    settlement: {
      defaultRail,
      ...(env.HEDRON_HTS_SETTLEMENT_TOKEN_ID
        ? { htsSettlementTokenId: env.HEDRON_HTS_SETTLEMENT_TOKEN_ID }
        : {}),
    },
    adapters: {
      x402: {
        ...(env.HEDRON_X402_FACILITATOR_URL
          ? { facilitatorUrl: env.HEDRON_X402_FACILITATOR_URL }
          : {}),
        ...(env.HEDRON_X402_FACILITATOR_API_KEY
          ? { facilitatorApiKey: env.HEDRON_X402_FACILITATOR_API_KEY }
          : {}),
        network: env.HEDRON_X402_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
        ...(env.HEDRON_X402_PAY_TO ? { payTo: env.HEDRON_X402_PAY_TO } : {}),
        ...(env.HEDRON_X402_FEE_PAYER ? { feePayer: env.HEDRON_X402_FEE_PAYER } : {}),
      },
      evm: {
        ...(env.EVM_RPC_URL ? { rpcUrl: env.EVM_RPC_URL } : {}),
        ...(env.EVM_CHAIN_ID ? { chainId: num(env.EVM_CHAIN_ID, 0) } : {}),
        ...(env.EVM_USDC_CONTRACT ? { usdcContract: env.EVM_USDC_CONTRACT } : {}),
        ...(env.EVM_MERCHANT_ADDRESS ? { merchantAddress: env.EVM_MERCHANT_ADDRESS } : {}),
      },
      daydreams: {
        ...(env.DAYDREAMS_AGENT_ID ? { agentId: env.DAYDREAMS_AGENT_ID } : {}),
        ...(env.DAYDREAMS_API_BASE_URL ? { apiBaseUrl: env.DAYDREAMS_API_BASE_URL } : {}),
      },
      hak: {
        enabled: bool(env.HAK_PLUGIN_ENABLED, false),
        ...(env.HAK_LLM_PROVIDER ? { llmProvider: env.HAK_LLM_PROVIDER } : {}),
      },
    },
    flags: {
      runHederaIntegration: bool(env.RUN_HEDERA_INTEGRATION, false),
      runEvmIntegration: bool(env.RUN_EVM_INTEGRATION, false),
      demoMode,
    },
    logging: { level: logLevel, format: logFormat },
  }
  return cfg
}

/**
 * Cross-check config against a target network. Used before mainnet runs.
 */
export function validateForNetwork(cfg: HedronConfig, expected: HederaNetwork): void {
  if (cfg.hedera.network !== expected) {
    throw new ConfigError(
      `expected HEDERA_NETWORK=${expected}, got ${cfg.hedera.network}`,
    )
  }
  if (expected === 'mainnet') {
    if (!cfg.hedera.operatorId || !cfg.hedera.operatorKeyRef) {
      throw new ConfigError('mainnet requires HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY')
    }
    if (cfg.flags.demoMode === 'mock') {
      throw new ConfigError('mainnet runs cannot use DEMO_MODE=mock')
    }
  }
}

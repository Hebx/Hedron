/**
 * Hedron v0.2 — shared type surface
 *
 * This module is the public type contract for the runtime. Anything outside
 * `src/types/` and the module-level index files is internal until v0.2.0.
 */

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export type HederaNetwork = 'mainnet' | 'testnet' | 'previewnet'

export interface HedronConfig {
  hedera: {
    network: HederaNetwork
    operatorId?: string
    /** Operator key handle. The raw value never lives in HedronConfig — only a reference. */
    operatorKeyRef?: string
    mirrorNodeUrl?: string
  }
  hcs: {
    auditTopicId?: string
    receiptTopicId?: string
    policyTopicId?: string
  }
  router: {
    httpHost: string
    httpPort: number
    trustedAgentIds: string[]
    idempotencyTtlSeconds: number
  }
  broker: {
    httpPort: number
  }
  policy: {
    maxPriceHbar: string
    maxDailySpendHbar: string
    requireApprovalOverHbar: string
    allowedPaymentRails: PaymentRail[]
    defaultDecision: 'deny' | 'allow'
  }
  settlement: {
    defaultRail: PaymentRail
    htsSettlementTokenId?: string
  }
  adapters: {
    x402: {
      /** Facilitator base URL. Absent/empty disables the x402 rail. */
      facilitatorUrl?: string
      /** Optional bearer token; open-access facilitators need none. */
      facilitatorApiKey?: string
      /** Short name; mapped to the CAIP-2 id (`hedera:testnet`/`hedera:mainnet`). */
      network: 'testnet' | 'mainnet'
      /** Hedera account receiving x402 payments (`payTo`). */
      payTo?: string
      /** Fee-sponsoring account; discovered from `/supported` when absent. */
      feePayer?: string
    }
    evm: { rpcUrl?: string; chainId?: number; usdcContract?: string; merchantAddress?: string }
    daydreams: { agentId?: string; apiBaseUrl?: string }
    hak: { enabled: boolean; llmProvider?: string }
  }
  flags: {
    runHederaIntegration: boolean
    runEvmIntegration: boolean
    demoMode: 'mock' | 'testnet' | 'mainnet'
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error'
    format: 'pretty' | 'json'
  }
}

// -----------------------------------------------------------------------------
// Identity & capabilities
// -----------------------------------------------------------------------------

export interface AgentIdentity {
  id: string
  /** Optional Hedera account id, e.g. "0.0.xxxxx" */
  hederaAccountId?: string
  /** Public key in canonical encoding (hex or DER) — never the private key */
  publicKey?: string
  /** Free-form display name; not used for routing */
  displayName?: string
}

export type CapabilityPricing =
  | { kind: 'fixed-hbar'; amountTinybar: string }
  | { kind: 'fixed-hts'; tokenId: string; amount: string; decimals: number }
  | {
      kind: 'fixed-evm-erc20'
      chainId: number
      contract: string
      amount: string
      decimals: number
    }
  | { kind: 'metered'; rateTinybarPerUnit: string; unit: string }

export interface AgentCapability {
  id: string
  agentId: string
  /** Stable machine-readable identifier (e.g. "invoice.tokenize") */
  name: string
  description: string
  tags: string[]
  pricing: CapabilityPricing
  /** Payment rails this capability can settle on */
  allowedRails: PaymentRail[]
  /** Inputs schema (JSON Schema or zod-compiled) — opaque to Hedron */
  inputSchemaRef?: string
  /** Outputs schema reference */
  outputSchemaRef?: string
  /** Adapter manifest id (which runtime produces this capability) */
  adapterId: string
}

export interface AgentCard {
  identity: AgentIdentity
  capabilities: AgentCapability[]
  /** Optional trust / reputation metadata */
  reputation?: {
    score?: number
    issuer?: string
    proofUri?: string
  }
  manifest: AdapterManifest
}

// -----------------------------------------------------------------------------
// Commerce loop
// -----------------------------------------------------------------------------

export interface IntentRequest {
  intentId: string
  correlationId: string
  caller: { id: string; role: 'user' | 'app' | 'agent' }
  capabilityFilter: {
    name?: string
    tags?: string[]
    maxPriceHbar?: string
    allowedRails?: PaymentRail[]
  }
  /** Canonical-encoded action request the chosen agent will execute */
  action: unknown
  /** Optional deadline — quotes past this point are rejected */
  expiresAt?: string
}

export interface QuoteRequest {
  quoteRequestId: string
  intentId: string
  correlationId: string
  agentId: string
  capabilityId: string
  action: unknown
  expiresAt: string
}

export interface QuoteResponse {
  quoteId: string
  quoteRequestId: string
  intentId: string
  correlationId: string
  agentId: string
  capabilityId: string
  pricing: CapabilityPricing & { rail: PaymentRail }
  /** sha256 hex of canonical encoding of the action request */
  actionHash: string
  policyRequirements: {
    requiresApprovalOver?: string
  }
  paymentRequirement: PaymentRequirement
  signature: string
  expiresAt: string
}

export interface BrokerDecision {
  flowId: string
  decision: 'accept' | 'reject'
  reason?: string
}

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

export type ApproverScope = 'operator' | 'user' | 'custom'

export type PolicyDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'requireApproval'; reason: string; approverScope: ApproverScope }

export interface PolicyContext {
  timestamp: string
  correlationId: string
  intent: IntentRequest
  quote: QuoteResponse
  agent: AgentIdentity
  caller: { id: string; role: 'user' | 'app' | 'agent' }
  spendWindow: { dailySpentHbar: string; since: string }
}

export interface PolicyRule {
  id: string
  description: string
  evaluate(ctx: PolicyContext): PolicyDecision
}

// -----------------------------------------------------------------------------
// Settlement
// -----------------------------------------------------------------------------

export type PaymentRail =
  | 'hedera-hbar'
  | 'hedera-hts'
  | 'x402'
  | 'evm-usdc'
  | 'mpp'

export interface PaymentRequirement {
  rail: PaymentRail
  asset:
    | { kind: 'hbar' }
    | { kind: 'hts'; tokenId: string }
    | { kind: 'evm-erc20'; chainId: number; contract: string }
  amount: string
  recipient: string
  expiresAt: string
  /** sha256 hex of canonical encoding of the action request */
  actionHash: string
  /** sha256 hex of canonical encoding of the quote */
  quoteHash: string
  correlationId: string
  metadata?: Record<string, string>
}

export interface PaymentPayload {
  rail: PaymentRail
  quoteId: string
  paymentId: string
  signedPayload: string
  metadata?: Record<string, string>
}

export interface SettlementIntent {
  flowId: string
  correlationId: string
  quote: QuoteResponse
  payment: PaymentPayload
  idempotencyKey: string
}

export interface SettlementResult {
  ok: boolean
  paymentId: string
  settlementId: string
  rail: PaymentRail
  /** sha256 hex of canonical encoding of the settlement record */
  settlementHash: string
  failureReason?: string
}

export interface SettlementStatus {
  settlementId: string
  state: 'pending' | 'confirmed' | 'failed'
  detail?: string
}

export interface SettlementReceipt {
  settlementId: string
  rail: PaymentRail
  /** Canonical, signed settlement record from the rail */
  record: string
  signature?: string
}

export interface SettlementVerification {
  ok: boolean
  checks: Record<string, { ok: boolean; detail?: string }>
}

// -----------------------------------------------------------------------------
// HCS audit + receipts
// -----------------------------------------------------------------------------

export type HedronEventType =
  | 'INTENT_CREATED'
  | 'AGENTS_DISCOVERED'
  | 'QUOTE_REQUESTED'
  | 'QUOTE_RECEIVED'
  | 'QUOTE_VERIFIED'
  | 'POLICY_EVALUATED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_GRANTED'
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_VERIFIED'
  | 'EXECUTION_STARTED'
  | 'EXECUTION_COMPLETED'
  | 'EXECUTION_FAILED'
  | 'RECEIPT_ISSUED'

export interface HcsAuditEvent<T = unknown> {
  schemaVersion: '1'
  eventType: HedronEventType
  correlationId: string
  flowId: string
  agentId?: string
  capabilityId?: string
  quoteId?: string
  paymentId?: string
  timestamp: string
  /** sha256 hex of canonical encoding of the previous event in this flow */
  prevEventHash?: string
  payload: T
  signature: string
}

export interface Receipt {
  receiptId: string
  flowId: string
  status: 'completed' | 'failed'
  resultHash?: string
  failureReason?: string
  issuedAt: string
}

export interface VerifiableReceipt extends Receipt {
  schemaVersion: '1'
  intentId: string
  correlationId: string
  quoteId: string
  paymentId: string
  executionId: string
  hcsTopicId: string
  hcsSequenceStart: number
  hcsSequenceEnd: number
  policyDecisionHash: string
  /**
   * sha256 hex of the canonical quote-verification outcome emitted as
   * `QUOTE_VERIFIED`. Anchors "this flow spent against a quote that was
   * verified" into the receipt.
   */
  quoteVerificationHash: string
  settlementHash: string
  rail: PaymentRail
  asset:
    | { kind: 'hbar' }
    | { kind: 'hts'; tokenId: string }
    | { kind: 'evm-erc20'; chainId: number; contract: string }
  amount: string
  recipient: string
  verification: {
    method: 'hcs-mirror'
    mirrorHints: string[]
    chainAlgorithm: 'sha-256-prevhash'
  }
  signature: string
}

export interface ExecutionResult {
  executionId: string
  flowId: string
  /** sha256 hex of canonical execution result */
  resultHash: string
  /** Caller-facing result. Never goes on HCS. */
  result: unknown
  status: 'completed' | 'failed'
  failureReason?: string
}

// -----------------------------------------------------------------------------
// Adapter manifest (every adapter advertises its surface)
// -----------------------------------------------------------------------------

export interface AdapterManifest {
  id: string
  kind: 'agent-runtime' | 'payment-rail' | 'protocol'
  version: string
  supportedCapabilities?: string[]
  supportedRails?: PaymentRail[]
  description?: string
}

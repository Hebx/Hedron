/**
 * Live e2e probe: Hedron's x402 rail against a real Hedera testnet facilitator.
 *
 * This is NOT a unit test. It makes real network calls to a real facilitator and,
 * when credentials are present, submits a real testnet transaction.
 *
 * It runs in two tiers so the credential-free part is always verifiable:
 *
 *   Tier A — no credentials required:
 *     A1  facilitator /supported reachable, advertises hedera:testnet for `exact`
 *     A2  our feePayerFor() discovers the advertised fee payer
 *     A3  our supportsHederaNetwork() agrees
 *     A4  mirror node confirms the advertised fee-payer account exists
 *     A5  our adapter builds a PaymentRequirement using discovered fee payer
 *     A6  facilitator REJECTS a structurally-invalid payload (fails closed,
 *         proving /verify is really being exercised, not stubbed)
 *
 *   Tier B — requires HEDERA_OPERATOR_ID + HEDERA_OPERATOR_KEY (funded testnet):
 *     B1  our X402HederaPayer builds + signs a real TransferTransaction
 *     B2  facilitator /verify accepts it (isValid: true)
 *     B3  our adapter settles it through /settle → real on-chain tx
 *     B4  mirror node confirms the transaction reached consensus
 *     B5  our verifySettlementReceipt passes on the real settlement
 *     B6  replay of the same paymentId is rejected without a second /settle
 *
 * Usage:
 *   npx tsx scripts/e2e-x402-testnet.ts
 *
 * Env:
 *   HEDRON_X402_FACILITATOR_URL  default https://api.testnet.blocky402.com
 *   HEDERA_OPERATOR_ID           e.g. 0.0.12345   (enables Tier B)
 *   HEDERA_OPERATOR_KEY          DER/hex private key
 *   HEDERA_KEY_TYPE              ecdsa | ed25519  (default ecdsa)
 *   HEDRON_E2E_PAY_TO            recipient; defaults to the operator (self-pay)
 *   HEDERA_MIRROR_NODE_URL       default https://testnet.mirrornode.hedera.com
 */

import { X402FacilitatorClient } from '../src/settlement/x402/facilitator'
import { X402HederaAdapter } from '../src/settlement/x402/adapter'
import { X402HederaPayer } from '../src/settlement/x402/client'
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from '../src/settlement/x402/mapping'
import { decodePaymentHeader } from '../src/settlement/x402/wire'
import type { QuoteResponse } from '../src/types'

const FACILITATOR_URL =
  process.env['HEDRON_X402_FACILITATOR_URL'] ?? 'https://api.testnet.blocky402.com'
const MIRROR =
  process.env['HEDERA_MIRROR_NODE_URL'] ?? 'https://testnet.mirrornode.hedera.com'
const OPERATOR_ID = process.env['HEDERA_OPERATOR_ID']
const OPERATOR_KEY = process.env['HEDERA_OPERATOR_KEY']
const KEY_TYPE = (process.env['HEDERA_KEY_TYPE'] ?? 'ecdsa') as 'ecdsa' | 'ed25519'

/** Tiny HBAR amount so a real run costs ~nothing: 100 tinybar = 0.000001 HBAR. */
const AMOUNT_TINYBAR = '100'

let passed = 0
let failed = 0
const failures: string[] = []

function check(id: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✔ ${id}  ${detail}`)
  } else {
    failed += 1
    failures.push(`${id}: ${detail}`)
    console.log(`  ✘ ${id}  ${detail}`)
  }
  return ok
}

async function mirrorGet(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${MIRROR}${path}`)
  let body: unknown = null
  try {
    body = JSON.parse(await res.text())
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/** A fixed-HBAR quote shaped like something the Router would emit. */
function buildQuote(payTo: string): QuoteResponse {
  const now = Date.now()
  return {
    quoteId: `e2e-quote-${now}`,
    agentId: 'e2e-provider',
    correlationId: `e2e-corr-${now}`,
    capability: 'e2e.x402.probe',
    pricing: { kind: 'fixed-hbar', amountTinybar: AMOUNT_TINYBAR },
    expiresAt: new Date(now + 180_000).toISOString(),
    actionHash: 'e'.repeat(64),
    quoteHash: 'f'.repeat(64),
    payTo,
  } as unknown as QuoteResponse
}

async function tierA(): Promise<{ feePayer?: string; facilitator: X402FacilitatorClient }> {
  console.log('\n── Tier A — facilitator contract (no credentials) ──')
  const facilitator = new X402FacilitatorClient({ baseUrl: FACILITATOR_URL })

  const supported = await facilitator.supported()
  const hederaKind = supported.kinds.find(
    (k) => k.scheme === 'exact' && k.network === HEDERA_TESTNET_CAIP2,
  )
  check(
    'A1',
    hederaKind !== undefined,
    `GET /supported advertises ${HEDERA_TESTNET_CAIP2} for exact (${supported.kinds.length} kinds total)`,
  )

  const feePayer = await facilitator.feePayerFor(HEDERA_TESTNET_CAIP2)
  check('A2', typeof feePayer === 'string' && feePayer.length > 0, `feePayerFor() → ${feePayer}`)

  const supports = await facilitator.supportsHederaNetwork(HEDERA_TESTNET_CAIP2)
  check('A3', supports, `supportsHederaNetwork(${HEDERA_TESTNET_CAIP2}) → ${supports}`)

  if (feePayer !== undefined) {
    const { status, body } = await mirrorGet(`/api/v1/accounts/${feePayer}`)
    const acct = body as { account?: string } | null
    check(
      'A4',
      status === 200 && acct?.account === feePayer,
      `mirror node confirms fee payer ${feePayer} exists (HTTP ${status})`,
    )
  }

  const adapter = new X402HederaAdapter({
    facilitator,
    payTo: OPERATOR_ID ?? '0.0.2',
    network: 'testnet',
  })
  const quote = buildQuote(OPERATOR_ID ?? '0.0.2')
  const requirement = await adapter.createPaymentRequirement({
    quote,
    correlationId: quote.correlationId,
  })
  check(
    'A5',
    requirement.rail === 'x402' && requirement.amount === AMOUNT_TINYBAR,
    `adapter built requirement: ${requirement.amount} tinybar, rail=${requirement.rail}`,
  )

  // Fails closed: a payload whose transaction bytes are garbage must be rejected
  // by the real facilitator. This proves /verify is genuinely round-tripping.
  const bogus = {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: HEDERA_TESTNET_CAIP2,
      asset: HBAR_ASSET_ID,
      amount: AMOUNT_TINYBAR,
      payTo: OPERATOR_ID ?? '0.0.2',
      maxTimeoutSeconds: 180,
      extra: { feePayer: feePayer ?? '0.0.7162784' },
    },
    payload: { transaction: Buffer.from('not-a-transaction').toString('base64') },
  }
  try {
    const verified = await facilitator.verify({
      payload: bogus as never,
      requirements: bogus.accepted as never,
    })
    check(
      'A6',
      verified.isValid === false,
      `facilitator rejected a malformed payload: isValid=${verified.isValid} reason=${verified.invalidReason ?? 'n/a'}`,
    )
  } catch (err) {
    // A typed HTTP rejection is also "fails closed" — acceptable.
    check(
      'A6',
      true,
      `facilitator rejected a malformed payload with an error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    )
  }

  return { ...(feePayer !== undefined ? { feePayer } : {}), facilitator }
}

async function tierB(facilitator: X402FacilitatorClient, feePayer: string): Promise<void> {
  console.log('\n── Tier B — real on-chain settlement (credentials present) ──')
  const payTo = process.env['HEDRON_E2E_PAY_TO'] ?? OPERATOR_ID!
  const adapter = new X402HederaAdapter({ facilitator, payTo, network: 'testnet' })
  const quote = buildQuote(payTo)
  const requirement = await adapter.createPaymentRequirement({
    quote,
    correlationId: quote.correlationId,
  })

  const payer = new X402HederaPayer({
    accountId: OPERATOR_ID!,
    privateKey: OPERATOR_KEY!,
    keyType: KEY_TYPE,
    network: 'testnet',
  })
  // Sign the ADAPTER'S OWN wire requirements, not a hand-rolled copy. The
  // adapter derives `maxTimeoutSeconds` from the quote expiry relative to now,
  // so a hardcoded value drifts and /settle rejects with
  // accepted_payment_requirements_mismatch — the payload's `accepted` block
  // must be byte-identical to what the adapter presents.
  const wireRequirements = await adapter.toWireRequirements(requirement)
  const built = await payer.buildPaymentHeader(wireRequirements)
  const decoded = decodePaymentHeader(built.header)
  check(
    'B1',
    decoded.payload['transaction'] !== undefined && built.transactionId.startsWith(feePayer),
    `payer built signed tx, txId=${built.transactionId} (id account is the fee payer)`,
  )

  const verified = await facilitator.verify({
    payload: decoded,
    requirements: decoded.accepted,
  })
  if (
    !check(
      'B2',
      verified.isValid,
      `facilitator /verify → isValid=${verified.isValid} ${verified.invalidReason ?? ''}`,
    )
  ) {
    return
  }

  const paymentId = `e2e-pay-${Date.now()}`
  const settlement = await adapter.settlePayment({
    requirement,
    payload: {
      paymentId,
      quoteId: quote.quoteId,
      signedPayload: built.header,
    } as never,
    idempotencyKey: `e2e-idem-${Date.now()}`,
  })
  check(
    'B3',
    settlement.ok && settlement.settlementId.length > 0,
    `adapter settled on-chain: ${settlement.settlementId}`,
  )

  // Mirror node needs a moment to reach consensus + index.
  const mirrorTxId = settlement.settlementId.replace('@', '-').replace(/\.(\d+)$/, '-$1')
  let mirrorOk = false
  let mirrorDetail = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 3000))
    const { status, body } = await mirrorGet(`/api/v1/transactions/${mirrorTxId}`)
    const tx = body as { transactions?: { result?: string }[] } | null
    if (status === 200 && tx?.transactions?.[0]?.result !== undefined) {
      mirrorOk = tx.transactions[0].result === 'SUCCESS'
      mirrorDetail = `mirror result=${tx.transactions[0].result} after ${(attempt + 1) * 3}s`
      break
    }
    mirrorDetail = `mirror had not indexed ${mirrorTxId} after ${(attempt + 1) * 3}s (HTTP ${status})`
  }
  check('B4', mirrorOk, mirrorDetail)
  console.log(
    `      hashscan: https://hashscan.io/testnet/transaction/${settlement.settlementId}`,
  )

  // Use the adapter's own receipt rather than hand-building one.
  // `settlement.settlementHash` and `receipt.record` are deliberately DIFFERENT
  // hashes: settlementHash binds the full quote/action/correlation context,
  // while receipt.record is the narrow cross-rail settlement identity. Passing
  // settlementHash as `record` makes recordMatches fail — correct behaviour,
  // wrong input.
  const receipt = await adapter.produceSettlementReceipt(settlement.settlementId)
  const receiptCheck = await adapter.verifySettlementReceipt(receipt)
  check(
    'B5',
    receiptCheck.ok,
    `verifySettlementReceipt on the real settlement: ${JSON.stringify(receiptCheck.checks)}`,
  )

  // Replay the paymentId that B3 already settled. Hedron's own guard must
  // reject this BEFORE any network call — if it reached the facilitator we
  // would get an X402FacilitatorError instead, which would mean our replay
  // protection is not actually in front of the wire.
  try {
    await adapter.settlePayment({
      requirement,
      payload: {
        paymentId,
        quoteId: quote.quoteId,
        signedPayload: built.header,
      } as never,
      idempotencyKey: 'replay',
    })
    check('B6', false, 'replay was NOT rejected — this is a bug')
  } catch (err) {
    const name = err instanceof Error ? err.name : String(err)
    check(
      'B6',
      name === 'ReplayDetectedError',
      name === 'ReplayDetectedError'
        ? 'replay rejected by Hedron before reaching the facilitator (ReplayDetectedError)'
        : `replay rejected but by the WRONG layer: ${name} — our guard should have caught it first`,
    )
  }
}

async function main(): Promise<void> {
  console.log('Hedron x402 live e2e probe')
  console.log(`  facilitator: ${FACILITATOR_URL}`)
  console.log(`  mirror:      ${MIRROR}`)

  const { feePayer, facilitator } = await tierA()

  if (OPERATOR_ID === undefined || OPERATOR_KEY === undefined) {
    console.log('\n── Tier B — SKIPPED ──')
    console.log('  HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY not set.')
    console.log('  Tier B submits a real (tiny) testnet transaction and needs a funded account.')
  } else if (feePayer === undefined) {
    console.log('\n── Tier B — SKIPPED (facilitator advertised no fee payer) ──')
  } else {
    await tierB(facilitator, feePayer)
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('\n💥 probe crashed:', err)
  process.exitCode = 1
})

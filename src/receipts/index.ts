import { ReceiptVerificationError } from '../errors'
import { canonicalize, sha256Hex } from '../utils/canonical'
import type { HcsAuditEvent, VerifiableReceipt } from '../types'
import type { HcsEmitter } from '../hcs'

export interface VerificationCheck {
  ok: boolean
  detail?: string
}

export interface VerificationResult {
  ok: boolean
  receiptId: string
  checks: {
    schema: VerificationCheck
    signature: VerificationCheck
    chainIntegrity: VerificationCheck
    anchoring: VerificationCheck
    quoteVerified: VerificationCheck
    policyConsistent: VerificationCheck
    status: VerificationCheck
  }
}

/**
 * Canonical event order for a settled flow. `QUOTE_VERIFIED` must appear
 * after the quote is received and strictly before policy evaluation — a chain
 * that policy-evaluates or pays before verifying the quote is not acceptable
 * even if every hash matches.
 */
const REQUIRED_EVENT_ORDER: readonly string[] = [
  'QUOTE_RECEIVED',
  'QUOTE_VERIFIED',
  'POLICY_EVALUATED',
] as const

/**
 * Local-mode verifier. Reads events from the supplied emitter (which in mock
 * mode is an in-memory chain that mirrors how a real HCS mirror would respond).
 *
 * In testnet/mainnet mode the emitter is backed by a real mirror node client.
 */
export async function verifyReceipt(
  receipt: VerifiableReceipt,
  emitter: HcsEmitter,
): Promise<VerificationResult> {
  const checks: VerificationResult['checks'] = {
    schema: { ok: false },
    signature: { ok: false },
    chainIntegrity: { ok: false },
    anchoring: { ok: false },
    quoteVerified: { ok: false },
    policyConsistent: { ok: false },
    status: { ok: false },
  }

  // 1) schema
  checks.schema = {
    ok:
      receipt.schemaVersion === '1' &&
      typeof receipt.receiptId === 'string' &&
      typeof receipt.flowId === 'string' &&
      typeof receipt.hcsTopicId === 'string',
  }
  if (!checks.schema.ok) {
    return { ok: false, receiptId: receipt.receiptId, checks }
  }

  // 2) signature (mock: signature matches sha256(canonical(receiptWithoutSignature)))
  const { signature, ...rest } = receipt
  const recomputed = sha256Hex(canonicalize(rest))
  checks.signature =
    signature === recomputed ? { ok: true } : { ok: false, detail: 'signature mismatch' }

  // 3) read the events for this flow
  const events = await emitter.readSequenceRange(
    receipt.hcsSequenceStart,
    receipt.hcsSequenceEnd,
  )
  if (events.length !== receipt.hcsSequenceEnd - receipt.hcsSequenceStart + 1) {
    checks.chainIntegrity = { ok: false, detail: 'event count mismatch' }
    return { ok: false, receiptId: receipt.receiptId, checks }
  }

  // 4) chain integrity (prevEventHash consistency for this flow)
  let prevHash: string | undefined
  let chainOk = true
  for (const ev of events) {
    if (ev.flowId !== receipt.flowId) continue
    if (prevHash !== undefined && ev.prevEventHash !== prevHash) {
      chainOk = false
      break
    }
    const { signature: _s, ...unsigned } = ev as HcsAuditEvent & { signature: string }
    prevHash = sha256Hex(canonicalize(unsigned))
  }
  checks.chainIntegrity = { ok: chainOk }

  // 5) anchoring: RECEIPT_ISSUED at hcsSequenceEnd must reference this receipt
  const issuedEvent = events.find(
    (e) => e.eventType === 'RECEIPT_ISSUED' && e.flowId === receipt.flowId,
  )
  if (
    issuedEvent &&
    (issuedEvent.payload as { receiptId?: string } | undefined)?.receiptId === receipt.receiptId
  ) {
    checks.anchoring = { ok: true }
  } else {
    checks.anchoring = { ok: false, detail: 'RECEIPT_ISSUED event missing or mismatched' }
  }

  // 6) QUOTE_VERIFIED present, successful, correctly ordered, hash-matched
  const flowEvents = events.filter((e) => e.flowId === receipt.flowId)
  const quoteVerifiedEvent = flowEvents.find((e) => e.eventType === 'QUOTE_VERIFIED')
  if (!quoteVerifiedEvent) {
    checks.quoteVerified = { ok: false, detail: 'QUOTE_VERIFIED event missing from flow' }
  } else {
    const payload = quoteVerifiedEvent.payload as
      | { ok?: boolean; quoteVerificationHash?: string; failedCheck?: string }
      | undefined
    const positions = REQUIRED_EVENT_ORDER.map((type) =>
      flowEvents.findIndex((e) => e.eventType === type),
    )
    const orderOk = positions.every(
      (pos, i) => pos !== -1 && (i === 0 || pos > (positions[i - 1] as number)),
    )
    if (payload?.ok !== true) {
      checks.quoteVerified = {
        ok: false,
        detail: `QUOTE_VERIFIED reported failure${payload?.failedCheck ? ` on '${payload.failedCheck}'` : ''}`,
      }
    } else if (!orderOk) {
      checks.quoteVerified = {
        ok: false,
        detail: `event order violation: expected ${REQUIRED_EVENT_ORDER.join(' → ')}`,
      }
    } else if (payload.quoteVerificationHash !== receipt.quoteVerificationHash) {
      checks.quoteVerified = {
        ok: false,
        detail: 'receipt.quoteVerificationHash does not match the QUOTE_VERIFIED event',
      }
    } else {
      checks.quoteVerified = { ok: true }
    }
  }

  // 7) policy + settlement hash consistency
  const policyEvent = events.find(
    (e) => e.eventType === 'POLICY_EVALUATED' && e.flowId === receipt.flowId,
  )
  const paymentEvent = events.find(
    (e) => e.eventType === 'PAYMENT_VERIFIED' && e.flowId === receipt.flowId,
  )
  const policyAnchor = (policyEvent?.payload as { policyDecisionHash?: string } | undefined)
    ?.policyDecisionHash
  const settlementAnchor = (paymentEvent?.payload as { settlementHash?: string } | undefined)
    ?.settlementHash
  checks.policyConsistent = {
    ok:
      policyAnchor === receipt.policyDecisionHash &&
      settlementAnchor === receipt.settlementHash,
  }

  // 8) terminal status
  const terminal = events.find(
    (e) =>
      (e.eventType === 'EXECUTION_COMPLETED' || e.eventType === 'EXECUTION_FAILED') &&
      e.flowId === receipt.flowId,
  )
  checks.status = {
    ok:
      (terminal?.eventType === 'EXECUTION_COMPLETED' && receipt.status === 'completed') ||
      (terminal?.eventType === 'EXECUTION_FAILED' && receipt.status === 'failed'),
  }

  const ok = Object.values(checks).every((c) => c.ok)
  return { ok, receiptId: receipt.receiptId, checks }
}

export function assertVerificationOk(result: VerificationResult): void {
  for (const [name, check] of Object.entries(result.checks)) {
    if (!check.ok) {
      throw new ReceiptVerificationError(name, check.detail ?? 'check failed')
    }
  }
}

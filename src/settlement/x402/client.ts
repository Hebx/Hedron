/**
 * Client-side x402 payer for the Hedera `exact` scheme.
 *
 * This is the ONLY part of the x402 rail that touches a private key, and it is
 * the *payer's* key — never Hedron's and never the facilitator's. It is kept in
 * its own module so the adapter, mapping, and facilitator client all stay
 * key-free and testable without credentials.
 *
 * Per the scheme spec, the client MUST:
 *   1. build a **direct** `TransferTransaction` (never `ScheduleCreate`-wrapped)
 *   2. debit itself and credit `payTo` by exactly `amount` of `asset`
 *   3. set `transactionId`'s account to `extra.feePayer` so the facilitator is
 *      the fee payer at the network level
 *   4. freeze and sign — producing a *partially* signed transaction, because the
 *      fee payer's signature is still missing
 *   5. base64 the serialized bytes into `payload.transaction`
 *
 * Step 3 is the counter-intuitive one: the transaction id belongs to the
 * facilitator, not the payer, even though the payer is the one sending value.
 *
 * Requires the optional peer deps `@hiero-ledger/sdk` and `@x402/hedera`.
 */

import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransactionId,
  TransferTransaction,
} from '@hiero-ledger/sdk'
import { HBAR_ASSET_ID, X402_VERSION, X402MappingError } from './mapping'
import { encodePaymentHeader } from './wire'
import type { X402PaymentPayload, X402PaymentRequirements } from './wire'

export interface X402PayerOptions {
  /** Paying Hedera account id, e.g. `0.0.5005`. */
  accountId: string
  /** Payer's private key (DER or hex). Never leaves this process. */
  privateKey: string
  /** Key type; ECDSA is the common default for new accounts. */
  keyType?: 'ecdsa' | 'ed25519'
  /**
   * Which network's node list to freeze against. Freezing requires real node
   * account ids, so this selects the address book — it does NOT submit
   * anything. Defaults to `testnet`.
   */
  network?: 'testnet' | 'mainnet'
}

/**
 * Builds a signed `X-PAYMENT` header for a set of x402 payment requirements.
 *
 * Returns the header value plus the decoded payload, so a caller can inspect
 * what it is about to send.
 */
export class X402HederaPayer {
  private readonly accountId: AccountId
  private readonly key: PrivateKey
  private readonly network: 'testnet' | 'mainnet'

  constructor(opts: X402PayerOptions) {
    this.network = opts.network ?? 'testnet'
    this.accountId = AccountId.fromString(opts.accountId)
    this.key =
      opts.keyType === 'ed25519'
        ? PrivateKey.fromStringED25519(opts.privateKey)
        : PrivateKey.fromStringECDSA(opts.privateKey)
  }

  get payerAccountId(): string {
    return this.accountId.toString()
  }

  /**
   * Build, freeze and sign the transfer described by `requirements`.
   *
   * No network calls: freezing with an explicit `TransactionId` and node list
   * avoids needing a live client, which keeps this usable offline and in tests.
   */
  async buildPaymentHeader(requirements: X402PaymentRequirements): Promise<{
    header: string
    payload: X402PaymentPayload
    transactionId: string
  }> {
    const feePayer = requirements.extra?.['feePayer']
    if (typeof feePayer !== 'string' || feePayer.length === 0) {
      throw new X402MappingError(
        'missing_fee_payer',
        'PaymentRequirements.extra.feePayer is required by the Hedera exact scheme',
      )
    }
    if (!/^\d+$/.test(requirements.amount)) {
      throw new X402MappingError(
        'invalid_amount',
        `amount must be a whole number of the asset's smallest unit, got ${requirements.amount}`,
      )
    }

    const amount = BigInt(requirements.amount)
    if (amount <= 0n) {
      throw new X402MappingError('invalid_amount', 'amount must be positive')
    }

    const payTo = AccountId.fromString(requirements.payTo)
    const feePayerId = AccountId.fromString(feePayer)

    // The fee payer owns the transaction id — this is what makes them the
    // network-level payer of fees.
    const txId = TransactionId.generate(feePayerId)

    let tx = new TransferTransaction().setTransactionId(txId)

    if (requirements.asset === HBAR_ASSET_ID) {
      // Stay in tinybars end-to-end. `fromTinybars` takes Long/string/number,
      // not bigint, so the value is passed as a decimal string — going through
      // a float here would be a way to silently pay the wrong amount.
      const debit = Hbar.fromTinybars((-amount).toString())
      const credit = Hbar.fromTinybars(amount.toString())
      tx = tx.addHbarTransfer(this.accountId, debit).addHbarTransfer(payTo, credit)
    } else {
      // `addTokenTransfer` accepts a bigint directly in @hiero-ledger/sdk, so
      // the base unit amount is passed through untouched — no Long import and
      // no number round-trip.
      tx = tx
        .addTokenTransfer(requirements.asset, this.accountId, -amount)
        .addTokenTransfer(requirements.asset, payTo, amount)
    }

    // Freezing needs real node account ids, so a bare `tx.freeze()` is not
    // enough even with the transaction id already set — signing it throws
    // "transaction must have been frozen before calculating the hash".
    // `freezeWith(client)` supplies the address book; it does NOT submit
    // anything and never uses an operator, so this stays offline-safe. The
    // reference @x402/hedera client does the same.
    const client =
      this.network === 'mainnet' ? Client.forMainnet() : Client.forTestnet()
    let transaction: string
    try {
      const frozen = tx.freezeWith(client)
      const signed = await frozen.sign(this.key)
      transaction = Buffer.from(signed.toBytes()).toString('base64')
    } finally {
      client.close()
    }

    const payload: X402PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: { transaction },
    }
    return {
      header: encodePaymentHeader(payload),
      payload,
      transactionId: txId.toString(),
    }
  }
}

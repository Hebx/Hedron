/**
 * Hedron Hedera testnet demo (opt-in).
 *
 * Requires:
 *   HEDERA_NETWORK=testnet
 *   HEDERA_OPERATOR_ID=0.0.xxxxx
 *   HEDERA_OPERATOR_KEY=<your-testnet-operator-private-key>
 *   RUN_HEDERA_INTEGRATION=true
 *
 *   npm run demo:testnet
 *
 * Placeholder until ROADMAP v0.2.0-alpha.2: real HCS emission + mirror
 * verification. Refuses to pretend the loop ran. Requires
 * RUN_HEDERA_INTEGRATION=true.
 */

import { loadHedronConfig, validateForNetwork } from '../src/config'

async function main(): Promise<number> {
  const cfg = loadHedronConfig()
  validateForNetwork(cfg, 'testnet')

  if (!cfg.flags.runHederaIntegration) {
    console.error(
      'RUN_HEDERA_INTEGRATION=true is required for the testnet demo. See docs/QUICKSTART.md.',
    )
    return 1
  }

  console.log(
    `[hedron] testnet demo placeholder. Operator=${cfg.hedera.operatorId ?? '(unset)'} ` +
      `Audit topic=${cfg.hcs.auditTopicId ?? '(auto-provision)'}`,
  )
  console.log(
    '[hedron] Real HCS emission is ROADMAP v0.2.0-alpha.2. See docs/ROADMAP.md.',
  )
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)

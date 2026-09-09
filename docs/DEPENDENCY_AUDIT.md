# Dependency audit status

Last reviewed **2026-07-31** against `npm audit` on `0.2.0-alpha.0`.

## Current state

**8 advisories: 6 high, 2 moderate, 0 critical.** Down from 27 (3 critical, 11 high, 5 moderate).

Every remaining advisory reports `fixAvailable: false` and reaches us transitively through the Hedera and x402 SDKs. We are already pinned to the newest published version of all four relevant direct dependencies, so there is no upgrade left to take.

## What was fixed

| Action | Effect |
|---|---|
| `npm audit fix --package-lock-only` | Transitive bumps: `brace-expansion`, `js-yaml`, `postcss`, `@babel/core`, `shell-quote`. 27 → 22. |
| **Removed `@hashgraph/sdk`** | 22 → ~10. Biggest single win. |
| **`vitest` 2.1.8 → 4.1.10** (+ `@vitest/coverage-v8`) | Cleared the last critical plus the `vite` / `esbuild` / `vite-node` / `@vitest/mocker` chain. |

### Removing `@hashgraph/sdk` was the high-leverage move

It was a **legacy dependency with zero real imports** — it appeared only inside comments (`src/hcs/index.ts`, `src/settlement/hedera/index.ts`, `src/adapters/hedera-agent-kit/index.ts`) describing what a future real implementation *would* use. Meanwhile it was a top-level source of:

- `protobufjs` **critical** (arbitrary code execution) via three separate paths
- `@grpc/grpc-js` high
- `@hashgraph/proto` high
- the whole `@ethersproject/*` + `elliptic` low cluster

The live code path uses `@hiero-ledger/sdk`, which is the SDK the ecosystem is migrating to. Dropping the v2 package cost nothing and removed a critical.

It also resolved the `npm ls` conflict noted in `AGENTS.md`: legacy `@hashgraph/sdk` v2 exact-pinned `protobufjs@7.5.4` while `@hiero-ledger/sdk` resolves 8.6.6, and those two cannot coexist cleanly. Removing the legacy package is the correct fix — **not** a blanket `protobufjs` override, which breaks the tree.

### Verification

`npm run build` clean, **89/89 tests pass on vitest 4** (no test changes needed), and the live x402 probe still passes **12/12** including real on-chain settlement.

## Remaining 8 — why they stay

| Advisory | Sev | Reaches us via | Assessment |
|---|---|---|---|
| `protobufjs` | high | `@x402/hedera` → `@hiero-ledger/sdk`, `@grpc/proto-loader` | Upstream vendors its own copies. Not fixable without forking. |
| `@hiero-ledger/proto` | high | `@hiero-ledger/sdk`, `@x402/hedera` | Depends on vulnerable `protobufjs`. |
| `@hiero-ledger/sdk` | high | direct | Already on latest `2.86.2`. |
| `@x402/hedera` | high | direct | Already on latest `2.20.0`. Vendors its own SDK + proto copy. |
| `@grpc/grpc-js` | high | `@hiero-ledger/sdk` | Server-side DoS advisories. |
| `ws` | high | `ethers` → `@hiero-ledger/sdk`, `@x402/hedera` | Two of three advisories have **no fix at any version**. |
| `ethers` | moderate | `@hiero-ledger/sdk`, `@x402/hedera` | Depends on vulnerable `ws`. |
| `@hashgraph/hedera-agent-kit` | moderate | direct (optional peer) | Already on latest `4.0.0`. |

### Exposure assessment

Worth being precise rather than alarmist:

- The `protobufjs` advisories require **attacker-controlled `.proto` schemas or descriptors**. Hedron parses no untrusted schemas; protobuf here only decodes Hedera network responses.
- `@grpc/grpc-js` advisories are **server-side** (malformed inbound requests crashing a gRPC *server*). Hedron is a gRPC client.
- `ws` and `ethers` arrive through the Hedera SDK's WebSocket/EVM paths. Hedron's x402 rail uses HTTPS to a facilitator and REST to a mirror node — it opens no WebSocket.
- `@hashgraph/hedera-agent-kit` is an **optional peer dependency**; consumers who never load the HAK adapter never install it.

None of these are reachable from Hedron's own code paths in a way an external caller controls. They are real advisories in the dependency tree and should not be dismissed, but they do not currently represent an exploitable path in this SDK.

`npm audit` in CI is intentionally **warn-only** for exactly this reason: the remaining set cannot be actioned by us, and failing the build on them would train people to ignore the signal.

## When to revisit

- When `@x402/hedera` publishes past `2.20.0` — it vendors its own `@hiero-ledger/sdk` and `protobufjs`, so an upstream bump clears several rows at once.
- When `@hiero-ledger/sdk` ships a `protobufjs` ≥ the first patched release.
- Before any mainnet deployment, re-run this audit and re-assess exposure with real value at risk. The reasoning above is scoped to a testnet-only SDK.

## Reproducing

```bash
npm audit                 # summary
npm audit --json          # full advisory detail
npm ls protobufjs         # show duplicate/conflicting resolutions
```

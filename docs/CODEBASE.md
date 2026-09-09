# Hedron — codebase map

*Table of contents for agents. Target architecture in `ARCHITECTURE.md`; code may lag v0.2 design.*

## Repository layout

```
Hedron/
├── src/
│   ├── router/              # IntentRequest → QuoteResponse[]
│   ├── broker/              # Flow coordinator (quote → receipt)
│   ├── policy/              # Default-deny PolicyEngine
│   ├── settlement/
│   │   ├── hedera/          # HBAR / native Hedera settlement
│   │   ├── evm/             # EVM rail adapter
│   │   └── x402/            # x402 Hedera exact scheme (wire/mapping/
│   │                        #   facilitator/adapter/client) — implemented
│   ├── quotes/              # Quote signing + verification trust boundary
│   ├── receipts/            # VerifiableReceipt build/verify
│   ├── hcs/                 # Topic emit + query helpers
│   ├── registry/            # AgentCard / capability index
│   ├── adapters/
│   │   ├── hedera-agent-kit/
│   │   ├── daydreams/
│   │   └── mcp/
│   ├── config/              # Env + runtime config
│   ├── errors/              # Typed errors
│   ├── types/               # Shared types
│   └── utils/               # ids, canonical hashing, env
├── tests/unit/              # Vitest — mirror src/ structure
├── demo/                    # local.ts, testnet.ts
├── deployments/testnet/     # deployment.json
└── docs/                    # ARCHITECTURE, ROUTER_BROKER, HCS_RECEIPTS, …
```

## Commerce flow (where to edit)

```
IntentRequest
  → router/index.ts          (discover + quotes)
  → broker/index.ts          (policy → settle → execute → receipt)
  → policy/index.ts          (allow / deny / approval)
  → settlement/*/index.ts    (rail-specific pay)
  → adapters/*/index.ts      (provider agent runtime)
  → hcs/index.ts + receipts/index.ts   (audit + proof)
```

## Tests by area

| Area | Test path |
|------|-----------|
| Router/broker flow | `tests/unit/broker-flow.test.ts` |
| Policy | `tests/unit/policy.test.ts` |
| Registry | `tests/unit/registry.test.ts` |
| Settlement mocks | `tests/unit/settlement-mock.test.ts` |
| HAK adapter | `tests/unit/adapters/hedera-agent-kit.test.ts` |
| Daydreams | `tests/unit/adapters/daydreams.test.ts` |
| Config / canonical | `tests/unit/config.test.ts`, `canonical.test.ts` |

Run scoped: `npm test -- tests/unit/policy.test.ts`

## Docs index

Start at `docs/INDEX.md` → ARCHITECTURE, ROUTER_BROKER, HCS_RECEIPTS, X402_ADAPTER, HEDERA_AGENT_KIT_PLUGIN.

## Agent notes

- **Hedera-first** — HCS sequences anchor receipts; app logs are not proof.
- **Adapter boundary** — new payment rail → `settlement/`; new agent runtime → `adapters/`.
- Navigation: grep + this map; models are not pre-trained on Hedron layout.

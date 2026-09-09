# Changelog

All notable changes to Hedron are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- Public status copy now matches shipped surface: mocked local loop, HAK v4 plugin offline, x402 exact HBAR rail proven; `demo:testnet` documented as a placeholder until alpha.2.

### Added
- Canonical v0.2 documentation: `docs/{INDEX,ARCHITECTURE,ROUTER_BROKER,HCS_RECEIPTS,POLICY_ENGINE,SECURITY_MODEL,QUICKSTART,DAYDREAMS_ADAPTER,PAYAI_X402_ADAPTER,HEDERA_AGENT_KIT_PLUGIN,ROADMAP,DEPENDENCY_HARDENING}.md`.
- Top-level `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `RELEASE_CHECKLIST.md`.
- `src/types/`, `src/errors/`, `src/config/`, `src/router/`, `src/broker/`, `src/policy/`, `src/receipts/`, `src/hcs/`, `src/registry/`, `src/settlement/`, `src/adapters/{daydreams,hedera-agent-kit,mcp}` skeletons.
- Mocked Router/Broker commerce flow runnable via `npm run demo:local`.
- Receipt verifier and HCS audit event schema (v1).
- ESLint v9 flat config + Prettier config.
- GitHub Actions CI: typecheck, lint, unit tests, contract compile, gitleaks.

### Changed
- `README.md` rewritten to position Hedron as a Hedera-native agentic commerce SDK + Router/Broker runtime.
- `.env.example` consolidated into one canonical file grouped by feature area.
- `deployment.json` moved under `deployments/testnet/`.
- `package.json` scripts modernized: `clean`, `build`, `typecheck`, `lint`, `format`, `test`, `test:unit`, `test:integration`, `compile:contracts`, `test:contracts`, `demo:local`, `demo:testnet`.

### Removed
- Tracked Hardhat output (`artifacts/`, `cache/`) — now gitignored, reproducible via `npx hardhat compile`.
- Duplicate `env.example` (canonical: `.env.example`).
- Hackathon-only docs (`HACKATHON_README.md`, `REPO_STATUS.md`, `SDK_README.md`, `docs/PITCH_DECK.md`, `docs/VIDEO_PITCH_SUMMARY.md`, `docs/BOUNTY_*.md`, `docs/BOUNTIES_GUIDE.md`, `docs/HACKATHON_READY.md`, `docs/HCS10_ALL_DEMOS_CHANGES.md`, `docs/REAL_WORLD_USE_CASES.md`, hackathon submission PDF). Preserved in private project archive.

### Security
- Full-history secret scan with `gitleaks 8.30.x`: 0 findings on the rewritten tree.
- One legacy test ECDSA key (testnet only) on the historical `ascension` branch was scrubbed across all 108 commits via `git filter-repo`. Rotation was not urgent — testnet only — but the key is no longer reachable from any ref. See internal incident notes.

## Pre-cleanup history

The pre-cleanup snapshot is preserved locally as:

- Tag: `pre-cleanup-postrewrite-20260518`
- Branch: `archive/pre-cleanup-postrewrite-20260518`
- Tarball: `~/projects/Hedron-local-archive-20260518/git-backup-pre-rewrite.tar.gz`

This version of Hedron was originally submitted to the **Hedera Africa Hackathon** under the x402 Payment Standard and Hedera Agent Kit bounties.

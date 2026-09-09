# Release Checklist

Run this checklist before tagging any Hedron release. Anything unchecked blocks the release.

## Pre-flight

- [ ] `npm ci` produces a clean install on a fresh machine.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run lint` exits 0 (or only documented warnings).
- [ ] `npm run test` (unit) passes — no real credentials needed.
- [ ] `npm run compile:contracts` succeeds.
- [ ] `npm run test:contracts` passes (Hardhat).
- [ ] `npm run demo:local` runs end-to-end and prints `Receipt verified`.
- [ ] `gitleaks detect --source . --no-git` → 0 findings.
- [ ] `gitleaks detect --source . --log-opts="--all --full-history"` → 0 findings.
- [ ] CI is green on the release commit on `main`.

## Docs

- [ ] `README.md` reflects the new tag's actual surface.
- [ ] `CHANGELOG.md` has a populated section for the tag (no `[Unreleased]` content unless intentional).
- [ ] `docs/ROADMAP.md` matches shipped surface (no dangling grant-plan refs).
- [ ] `package.json` `version` field matches the tag.
- [ ] `repository.url`, `homepage`, `bugs.url` all point to `Glorian-Labs/Hedron`.

## Integration smoke (testnet)

- [ ] `RUN_HEDERA_INTEGRATION=true npm run demo:testnet` writes an HCS topic and produces a verifiable receipt.
- [ ] `verifyReceipt` against the public mirror returns ok on six checks.
- [ ] HashScan link to the topic is reachable and shows the expected events.

## Mainnet rehearsal (only when the tag claims mainnet)

- [ ] Operator key rotated within the last 90 days OR documented exception.
- [ ] Mainnet HBAR demo runs with a tiny amount; receipt verified.
- [ ] On-call playbook is current.
- [ ] Monitoring dashboard URL is in `docs/`.

## Security

- [ ] `SECURITY.md` reachable, contact address current.
- [ ] No new dependency with a known CVE (per `npm audit --omit=dev`, or documented suppression).
- [ ] No new top-level secret in `.env.example` without a corresponding `.gitignore` rule.

## Tag and publish

- [ ] `git tag vX.Y.Z` from `main` HEAD.
- [ ] `git tag --verify vX.Y.Z` (GPG-signed tag).
- [ ] GitHub Release notes link to `CHANGELOG.md`.
- [ ] If npm-publishing: `npm publish --access public --otp ******` and verify the listing.

## Communication

- [ ] Monthly grant update posted (if release coincides with a reporting window).
- [ ] Demo video link added to README and grant tracker.
- [ ] Two technical posts queued (architecture + verifier walkthrough) if a milestone tag.

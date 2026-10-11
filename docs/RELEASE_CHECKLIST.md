# BCIS Final Release Checklist

Use `DONE`, `PENDING`, `NOT APPLICABLE`, or `BLOCKED`. A generated artifact or existing source code is not, by itself, acceptance evidence.

## Repository and secrets

| Item | Status | Evidence / action |
| --- | --- | --- |
| D1 source repository available and documented | DONE | Existing Git repository and source tree inspected. |
| `.env`, credentials, tokens, live customer/payment data excluded from release/source evidence | PENDING | Review tracked files and installer contents before publication; never paste secret values in logs/reports. |
| Production bootstrap account secured and secrets configured outside source | PENDING | Confirm rotation/provisioning and strong server environment configuration on target server. |
| Version, package metadata, and intended installer identified | DONE | Electron package is version 1.0.0; existing x64 NSIS artifact identified. |

## Installation and database

| Item | Status | Evidence / action |
| --- | --- | --- |
| Clean server dependencies/build | DONE | Backend build command passed in captured 2026-10-11 verification; repeat on release host. |
| Clean database schema application/migration evidence | PENDING | `npm run migrate` is Drizzle `push`; apply on clean disposable DB and capture output. |
| Declared constraints and referential integrity acceptance | PENDING | Execute AT-01 with valid/invalid duplicate and FK cases. |
| Synthetic seed tested; no real customer/payment records used for demonstration | DONE | Seed is explicit opt-in and generates synthetic prefixed demo records; operational demo deployment still needs review. |

## Build, lint, types, and tests

| Item | Status | Evidence / action |
| --- | --- | --- |
| Backend TypeScript build | DONE | `server`: `npm run build` passed in captured 2026-10-11 run. |
| Frontend TypeScript check | DONE | `bcis-system`: `npx tsc --noEmit` passed in captured 2026-10-11 run. |
| Frontend lint | DONE | `bcis-system`: `npm run lint` passed in captured 2026-10-11 run. |
| Backend automated test suite | DONE | 10 passed, 0 failed, 0 skipped in captured 2026-10-11 run; run against safe disposable/non-production DB. |
| Frontend automated tests | NOT APPLICABLE | No frontend test command or frontend unit-test suite is defined. |
| Production frontend/Electron build | DONE | `npm run build` produced the installer on 2026-10-11; warnings noted in testing report. |

## Authentication and financial acceptance

| Item | Status | Evidence / action |
| --- | --- | --- |
| Authentication and tested role authorization | DONE | Backend automated auth/RBAC test passed; full route-by-role matrix remains a manual acceptance task. |
| Billing cycle, idempotent invoice generation, totals, and ledger | DONE | Corresponding automated integration test passed; attach institution-specific financial acceptance evidence. |
| Payment allocation/reversal and exact balance checks | DONE | Corresponding automated integration test passed. |
| Receipt workflow | DONE | Automated integration suite contains receipt assertions; UI/printed output evidence is not recorded. |
| Collection reconciliation | DONE | Automated remittance reconciliation test passed. |
| Receivables aging and suspension/reconnection | DONE | Automated test passed; manual policy/acceptance still advisable. |
| Reports and sample output comparison | PENDING | Generate synthetic reports and compare totals; save redacted sample outputs. |
| Security and audit coverage across all relevant endpoints | PENDING | Selected RBAC, audit filtering/redaction pass; complete full role/route security test matrix. |

## Backup, deployment, and release

| Item | Status | Evidence / action |
| --- | --- | --- |
| Stubbed backup/restore route safeguards | DONE | Automated integration test passed; not equivalent to actual utility restore. |
| Real `pg_dump`/`pg_restore`/`pg_amcheck` recovery test | PENDING | Run `npm run test:backup:real` only against a disposable non-production environment; capture evidence. |
| API listens on LAN address and correct port | DONE | Source defaults to `0.0.0.0:3000`; verify server host/firewall on target network. |
| Windows firewall restricted to trusted Private network | PENDING | Add/review limited inbound API TCP rule; confirm PostgreSQL is not reachable from clients. |
| Client API URL configured to server LAN IPv4 | PENDING | Configure and verify each target PC using `%APPDATA%\bcis-system\bcis-config.json`. |
| Existing Windows installer artifact present | DONE | `bcis-system/release/1.0.0/BCIS-Windows-1.0.0-Setup.exe`. |
| Installer clean-install/uninstall/reinstall test on target Windows PCs | PENDING | Test without relying on developer dependencies; record Windows version and result. |
| Three separate clients on LAN; concurrent workflow evidence (AT-09) | PENDING | Not evidenced. Complete simultaneous client test before claiming deployment acceptance. |
| Public network exposure avoided / TLS plan reviewed | PENDING | Keep service private; arrange approved TLS proxy if required by deployment policy. |

## Laboratory submission package

| Deliverable/item | Status | Evidence / action |
| --- | --- | --- |
| D1 — Source Repository | DONE | Repository exists; perform final secret/tracked-file scan before submission. |
| D2 — Working Release | PENDING | Installer exists, but clean installation and three-PC acceptance remain. |
| D3 — Technical Documentation | DONE | [TECHNICAL_DOCUMENTATION.md](./TECHNICAL_DOCUMENTATION.md). |
| D4 — User Manual | DONE | [USER_MANUAL.md](./USER_MANUAL.md). |
| D5 — Testing Package | DONE | [TESTING_REPORT.md](./TESTING_REPORT.md), automated test source in `server/test/`. |
| D6 — Reports | PENDING | UI supports exports; collect reviewed, redacted sample Excel/PDF outputs. |
| D7 — UI Evidence | PENDING | Capture genuine screenshots from the running app using synthetic data; no screenshots were found in repository. |
| D8 — Presentation/Defense | PENDING | Prepare presentation and demonstrate only verified behavior/evidence. |
| Official lab AT-01–AT-12 wording cross-checked | PENDING | The official activity document was not present in the repository; reconcile this report's proposed mapping with the issued activity sheet. |

## Exact project commands

```powershell
# Backend; run from server
npm ci
npm run build
npm run migrate
npm run dev
# or, after build
npm run start
npm test

# Electron client; run from bcis-system
npm ci
npx tsc --noEmit
npm run lint
npm run dev
npm run build
```

Before running `npm run migrate`, backend integration tests, or the real backup workflow, verify that `DATABASE_URL` points to an authorized non-production database unless the operation is specifically approved for production. Do not run real backup/restore acceptance tests against production.

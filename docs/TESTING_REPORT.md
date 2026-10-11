# BCIS Testing Report

## Test environment and evidence

- Repository source: current BCIS workspace.
- Backend runtime/toolchain: Node.js/npm project in `server/`, TypeScript and `tsx`; PostgreSQL must be configured for database-backed integration coverage.
- Frontend runtime/toolchain: Node.js/npm project in `bcis-system/`; TypeScript, Vite, ESLint, and electron-builder.
- Existing Windows x64 installer artifact: `bcis-system/release/1.0.0/BCIS-Windows-1.0.0-Setup.exe`.
- Verified date for captured command results: **2026-10-11** (the prior captured run in this working session; no new database test is run by this documentation update).
- No frontend unit-test script is defined in `bcis-system/package.json`.
- Integration tests may write/remove synthetic test rows in the `DATABASE_URL` database. Use a disposable/non-production test database; do not run against production.

## Existing automated suites and commands

| Check | Command from project directory | Evidence/result |
| --- | --- | --- |
| Backend TypeScript build/check | `cd server; npm run build` | Passed on 2026-10-11 in the captured session. `build` runs `tsc -p tsconfig.json`. |
| Backend integration tests | `cd server; npm test` | Passed: 10 tests, 0 failures, 0 skipped on 2026-10-11. |
| Backend development start | `cd server; npm run dev` | Watch command exists; not a test. |
| Frontend TypeScript | `cd bcis-system; npx tsc --noEmit` | Passed in the captured 2026-10-11 verification. |
| Frontend lint | `cd bcis-system; npm run lint` | Passed in the captured 2026-10-11 verification. |
| Frontend/Electron packaging build | `cd bcis-system; npm run build` | Passed and produced installer on 2026-10-11. Existing build emitted third-party Rollup annotation and large-chunk warnings; these were non-fatal. |
| Real PostgreSQL backup/restore | `cd server; npm run test:backup:real` | NOT RUN for this submission. It creates/drops temporary databases and requires a non-production DB and PostgreSQL utilities. |

## Acceptance tests AT-01 through AT-12

The official laboratory activity text/test protocol was not present as a separate file in the inspected repository. The scenarios below map the prompt's stated acceptance areas to this implementation; compare them with the institution's original wording before submitting. `PASS` means the identified automated test actually passed; it does not certify manual acceptance or deployment.

| ID | Scenario | Procedure | Expected result | Actual result/evidence | Status |
| --- | --- | --- | --- | --- | --- |
| AT-01 | Database schema and referential integrity | On a clean disposable PostgreSQL database, apply the documented schema; attempt valid and invalid FK/unique operations; retain SQL/log evidence. | Schema applies; declared PK/FK/unique constraints reject invalid relationships/duplicates. | Schema declarations and generated SQL exist, but no clean-database migration/constraint acceptance evidence recorded. | NOT RUN |
| AT-02 | Authentication and role restrictions | Run backend auth/RBAC integration test; manually try allowed and denied actions for each submitted role. | Correct sign-in; unauthenticated requests get 401; unauthorized role operations get 403. | Automated test “authentication and role authorization behavior” passed. Per-role manual test matrix not recorded. | PASS |
| AT-03 | Subscriber/service-account workflows | Execute test workflow for subscriber master data and service events; then verify UI create/edit/search/details using synthetic records. | Valid data persists and linked service events reference the correct account. | Automated “subscriber master-data workflow reaches service events” passed. Full UI acceptance not recorded. | PASS |
| AT-04 | Billing cycle and invoice generation | Create an open cycle and active account; run invoice generation twice; verify invoice/item/ledger and duplicate handling. | Correct invoice amount; one invoice per service-account/cycle; repeated generation is idempotent. | Automated “billing generation is idempotent, exact, ledgered, and transactional” passed. | PASS |
| AT-05 | Payment, allocation, and reversal correctness | Record payment, allocate to eligible invoices, inspect balances/ledger; reverse with reason and inspect history. | Exact totals/statuses; no over-allocation; reversal preserves original and balancing history. | Automated “payment workflow preserves exact balances, allocation order, audit, and ledger” passed. | PASS |
| AT-06 | Receipt issue and payment history | On disposable synthetic records, issue receipt for posted payment; reject invalid payment; search/filter receipt list in UI. | Unique receipt is linked to posted payment and visible in history; invalid issue is rejected. | Integration suite has receipt workflow assertions; backend test run passed. No separate manual receipt/UI evidence recorded. | PASS |
| AT-07 | Collections and remittance reconciliation | Create assignment and batch, record cash/non-cash collection, submit remittance with/without variance and review totals. | Expected/remitted/difference totals are consistent and changes are atomic/auditable. | Automated “collection remittances reconcile totals and preserve atomic ledger records” passed. | PASS |
| AT-08 | Receivables aging and suspension lifecycle | Create overdue/part-paid accounts; check buckets, record suspension, then reconnect and inspect history. | Balances use posted allocations; aging/status and lifecycle records are consistent. | Automated “receivables aging and suspension lifecycle use outstanding balances” passed. | PASS |
| AT-09 | Two/three-client concurrent LAN operation | Install/configure clients on separate PCs; sign in simultaneously and perform concurrent reads/writes; compare records and logs. | All authorized clients reach the same API/database; concurrent updates do not duplicate or corrupt financial records. | No evidence of a separate two/three-PC concurrency run. | NOT RUN |
| AT-10 | Reports, filters, exports, sample outputs | Generate each report from approved synthetic data; check filters/totals; open XLSX/PDF and attach redacted samples. | Filtered figures match source records and output opens with correct values. | Report/export UI and code exist; no saved report artifacts/manual comparison evidence found. | NOT RUN |
| AT-11 | Security, RBAC, and audit trail | Test protected API routes with anonymous/allowed/disallowed roles; create audited changes; verify redaction and audit filters. | Expected 401/403 outcomes; audit captures event; sensitive keys are redacted. | Automated audit report/RBAC/redaction test and auth test passed. Security acceptance across every endpoint is not evidenced. | PASS |
| AT-12 | Backup/restore and recovery | Run stubbed backup endpoint test; separately, run real utility test against disposable source/`_restore` DB; validate restored state and integrity. | Backup file verified; restore only affects isolated target; restored values and integrity checks pass. | Automated test “backup endpoints enforce roles, store verified metadata, and restore only to a safe target” passed using stub runner. Real `pg_dump`/`pg_restore`/`pg_amcheck` workflow has not been recorded as run. | PASS |

AT-06/AT-12 `PASS` indicates the automated suite assertions passed, not full manual/real-infrastructure acceptance. Keep the procedures and result categories distinct in the final submission.

## Backup/restore test evidence and limitations

The integration test suite includes backup route tests with a stubbed external command runner, role checks, verified metadata, and safe restore-target validation. This verifies route logic without invoking real PostgreSQL utilities.

`npm run test:backup:real` is a separate opt-in destructive-to-temporary-resources test. It requires PostgreSQL client tools and permission to create/drop uniquely named temporary databases; only run with a known non-production `DATABASE_URL`. It has **not** been recorded as run for this report. Do not use a production database to obtain the evidence.

## Defects, fixes, and remaining evidence

- The backend source registers health routes at `/api/health` and `/api/v1/health`; `/`, `/health`, and `/api/docs` are intentionally unregistered. This URL mismatch was diagnosed; no source change was needed.
- Earlier LAN preparation added `HOST` configuration and client API address configuration; those changes are present in source. This report does not claim that three physical PCs have been tested.
- No new defects/fixes are asserted beyond evidence in the current repository/session.
- Pending: official laboratory AT text crosswalk, AT-01 clean DB migration/constraints, manual UI workflows and screenshots, report output sample checks, real utility backup/restore, installer clean install, and AT-09 multi-client LAN concurrency.

## Safety

Do not run migration pushes or real backup/restore tests against production or valuable data. Redact usernames, IPs, account details, payment references, connection strings, and tokens from submitted evidence. Use synthetic/demo data.

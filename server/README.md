# BCIS server demo data

The demo seed adds records with the `DEMO13` / `demo13_` prefix. It is safe to
run repeatedly: stable unique identifiers are used, related financial records
are created transactionally, and existing records are not deleted or rewritten.
The seed command is disabled in production and requires explicit opt-in.

Run against a non-production PostgreSQL database from `server`:

```powershell
$env:BCIS_DEMO_SEED = 'true'
$env:BCIS_DEMO_PASSWORD = 'Demo13!Only'
npm run seed:demo
```

All five demo users use the configured `BCIS_DEMO_PASSWORD` when they are first
created. For local demonstration only, the default is `Demo13!Only`. User
passwords are stored as hashes using the application's PBKDF2 password utility;
the demo password is never stored in plaintext. Set a different password before
seeding any shared development environment. Never use these demo credentials
for production accounts or reuse a production secret.

The demo roles are `OWNER`, `CASHIER`, `COLLECTION_SUPERVISOR`,
`ACCOUNTING_AUDITOR`, and `TECHNICIAN`. The cashier and collection supervisor
are the two assigned collectors.

The sample billing periods are fixed to July, August, and September 2026 so
re-running the seed does not add new demo months over time.

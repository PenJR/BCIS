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

## PostgreSQL backups and restore

The server uses PostgreSQL's `pg_dump` custom format and validates each dump
with `pg_restore --list`. Install PostgreSQL client tools on the server host,
or configure `PG_DUMP_PATH` and `PG_RESTORE_PATH` with absolute executable
paths. Backups are stored on the server filesystem in `BCIS_BACKUP_DIRECTORY`
(default: `server/backups`). The Electron renderer receives only backup
metadata; database URLs and passwords are read and used by the server.

`DATABASE_URL` is server-only. Set `BCIS_BACKUP_DIRECTORY` to a protected,
access-controlled location with adequate capacity and routine filesystem
backups. Configure TLS connection parameters in the PostgreSQL URL when
required by the deployment. The server passes database passwords to the
PostgreSQL utilities via their private process environment, not command-line
arguments or API responses.

Backup/restore authorization, destination safeguards, command construction,
file validation, and metadata behavior are covered by integration tests with
a stubbed utility runner. The real-utility workflow below supplements those
tests by invoking the configured `pg_dump` and `pg_restore` binaries and
`pg_amcheck`.

Only `OWNER` and `ADMINISTRATOR` can create or list backups; only `OWNER` can
restore. Restore is disabled unless `BCIS_ENABLE_RESTORE=true` is explicitly
set, and is always disabled when `NODE_ENV=production`. Restore also requires
`BCIS_RESTORE_DATABASE_URL` to point to a separate database whose name ends in
`_restore`; it rejects the configured live database. `pg_restore --clean` can
replace objects in that dedicated restore database, so never point it at a
production or otherwise valuable database. The restore endpoint is
`POST /api/v1/backups/:id/restore` and accepts only verified successful backup
metadata.

### Manual restore procedure

If `pg_restore` is unavailable to the server, install PostgreSQL client tools
and configure `PG_RESTORE_PATH`, or restore manually on a non-production
PostgreSQL host. Create an isolated database named with the `_restore` suffix
(for example `bcis_restore`), then restore a `.dump` file from the configured
backup directory:

```powershell
$env:PGPASSWORD = '<restore-role password>'
pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges `
  --host '<restore host>' --port '5432' --username '<restore role>' `
  --dbname 'bcis_restore' 'C:\protected\bcis-backup.dump'
Remove-Item Env:PGPASSWORD
```

Use a restore-only PostgreSQL role with privileges restricted to that isolated
database. Validate the restored database and its financial totals before
switching any application configuration. The application never automatically
switches its live `DATABASE_URL` as part of restoring a backup.

### Real backup/restore verification

With PostgreSQL client tools (`pg_dump`, `pg_restore`, and `pg_amcheck`)
available on `PATH` or configured for the server, run from `server`:

```powershell
npm run test:backup:real
```

The workflow requires the configured `DATABASE_URL` database to be available,
an `admin` user with the `OWNER` role (created by `ensureDemoAdmin` when
missing), and a PostgreSQL role with permission to create and drop databases.
It creates uniquely named temporary
`bcis_phase9_*` and `bcis_phase9_*_restore` databases, uses the real backup
routes/utilities to snapshot a test row, restores it, changes and adds test
data, restores again, and verifies the original row and the reverted changes.
It then checks for unvalidated constraints and runs `pg_amcheck`. The temporary
databases, dump file, and backup-history row are removed when the workflow
finishes; its successful backup/restore audit events remain in the configured
metadata database. Run only with a non-production `DATABASE_URL`; never point
this test at a production or valuable PostgreSQL instance.

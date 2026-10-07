import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { backupHistory, roles, userRoles, users } from '../db/schema';
import { createBackupRoutes } from '../src/routes/backups';
import { authSessions, ensureDemoAdmin } from '../src/lib/auth';
import { closeDatabase, db, initializeDatabase } from '../src/lib/db';
import { config } from '../src/lib/config';

const probeTable = 'phase9_backup_probe';

function replaceDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function utilityEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  return {
    ...process.env,
    PGPASSWORD: decodeURIComponent(url.password),
  };
}

function runUtility(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(executable, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-8_000); });
    child.stderr.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-8_000); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} failed (${code ?? 'unknown'}): ${output.trim()}`));
    });
  });
}

async function main(): Promise<void> {
  if (!(await initializeDatabase()) || !db) {
    throw new Error('The configured BCIS metadata database must be available.');
  }
  const metadataDb = db;
  await ensureDemoAdmin();
  const [owner] = await metadataDb
    .select({ id: users.id, username: users.username, fullName: users.fullName, role: roles.name })
    .from(users)
    .innerJoin(userRoles, eq(users.id, userRoles.userId))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(users.username, 'admin'), eq(roles.name, 'OWNER')))
    .limit(1);
  if (!owner || owner.role !== 'OWNER') {
    throw new Error('An existing OWNER account with username "admin" is required for this real-utility test.');
  }

  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const sourceDatabase = `bcis_phase9_${suffix}`;
  const restoreDatabase = `${sourceDatabase}_restore`;
  const sourceUrl = replaceDatabase(config.DATABASE_URL, sourceDatabase);
  const restoreUrl = replaceDatabase(config.DATABASE_URL, restoreDatabase);
  const maintenancePool = new Pool({ connectionString: config.DATABASE_URL });
  const sourcePool = new Pool({ connectionString: sourceUrl });
  const restorePool = new Pool({ connectionString: restoreUrl });
  const backupDirectory = await mkdtemp(path.join(tmpdir(), 'bcis-phase9-backup-'));
  const app = Fastify();
  const token = `phase9-real-backup-${randomUUID()}`;
  let sourceCreated = false;
  let restoreCreated = false;
  let backupId: number | undefined;
  let backupFile: string | undefined;

  try {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(sourceDatabase)}`);
    sourceCreated = true;
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)}`);
    restoreCreated = true;
    await Promise.all([sourcePool.query('SELECT 1'), restorePool.query('SELECT 1')]);

    const originalValue = `original-${randomUUID()}`;
    const probeId = randomUUID();
    await sourcePool.query('CREATE EXTENSION amcheck');
    await sourcePool.query(
      `CREATE TABLE ${quoteIdentifier(probeTable)} (id text PRIMARY KEY, value text NOT NULL)`,
    );
    await sourcePool.query(
      `INSERT INTO ${quoteIdentifier(probeTable)} (id, value) VALUES ($1, $2)`,
      [probeId, originalValue],
    );

    authSessions.set(token, {
      userId: owner.id,
      username: owner.username,
      fullName: owner.fullName,
      role: 'OWNER',
      expiresAt: Date.now() + 60_000,
    });
    await app.register(createBackupRoutes({
      backupDirectory,
      sourceDatabaseUrl: sourceUrl,
      restoreDatabaseUrl: restoreUrl,
      restoreEnabled: true,
      production: false,
    }));
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const backup = created.json().data as { id: number; backupFile: string; verified: boolean };
    backupId = backup.id;
    backupFile = backup.backupFile;
    assert.equal(backup.verified, true);
    console.log('PASS: real pg_dump created a verified custom-format backup.');

    const restore = async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/backups/${backup.id}/restore`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 200, response.body);
    };

    await restore();
    const firstRestore = await restorePool.query(
      `SELECT value FROM ${quoteIdentifier(probeTable)} WHERE id = $1`,
      [probeId],
    );
    assert.equal(firstRestore.rows[0]?.value, originalValue);
    const liveSource = await sourcePool.query(
      `SELECT value FROM ${quoteIdentifier(probeTable)} WHERE id = $1`,
      [probeId],
    );
    assert.equal(liveSource.rows[0]?.value, originalValue);
    console.log('PASS: pg_restore returned the original pre-backup test value.');

    await restorePool.query(
      `UPDATE ${quoteIdentifier(probeTable)} SET value = $2 WHERE id = $1`,
      [probeId, 'changed-after-backup'],
    );
    const postBackupId = randomUUID();
    await restorePool.query(
      `INSERT INTO ${quoteIdentifier(probeTable)} (id, value) VALUES ($1, $2)`,
      [postBackupId, 'must-be-removed-by-restore'],
    );
    await restore();
    const revertedValue = await restorePool.query(
      `SELECT value FROM ${quoteIdentifier(probeTable)} WHERE id = $1`,
      [probeId],
    );
    const revertedInsert = await restorePool.query(
      `SELECT 1 FROM ${quoteIdentifier(probeTable)} WHERE id = $1`,
      [postBackupId],
    );
    assert.equal(revertedValue.rows[0]?.value, originalValue);
    assert.equal(revertedInsert.rowCount, 0);
    console.log('PASS: second pg_restore reverted the update and removed the post-backup insert.');

    const unvalidatedConstraints = await restorePool.query(
      `SELECT count(*)::int AS count FROM pg_constraint WHERE NOT convalidated`,
    );
    assert.equal(unvalidatedConstraints.rows[0]?.count, 0);
    const pgAmcheckPath = process.env.PG_AMCHECK_PATH ?? 'pg_amcheck';
    const restoreConnection = new URL(restoreUrl);
    await runUtility(pgAmcheckPath, [
      '--host', restoreConnection.hostname,
      '--port', restoreConnection.port || '5432',
      '--username', decodeURIComponent(restoreConnection.username),
      '--database', restoreDatabase,
    ], utilityEnvironment(restoreUrl));
    console.log('PASS: restored database has no unvalidated constraints and pg_amcheck reports no corruption.');
  } finally {
    authSessions.delete(token);
    await app.close();
    await sourcePool.end();
    await restorePool.end();
    if (backupId !== undefined) {
      await metadataDb.delete(backupHistory).where(eq(backupHistory.id, backupId));
    }
    if (backupFile) {
      await rm(path.join(backupDirectory, backupFile), { force: true });
    }
    await rm(backupDirectory, { recursive: true, force: true });
    if (restoreCreated) {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDatabase)}`);
    }
    if (sourceCreated) {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceDatabase)}`);
    }
    await maintenancePool.end();
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

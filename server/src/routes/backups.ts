import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { backupHistory } from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { config } from '../lib/config';
import { db } from '../lib/db';

const backupRoles = ['OWNER', 'ADMINISTRATOR'];
const backupIdSchema = z.object({ id: z.coerce.number().int().positive() });
const backupFilenamePattern = /^bcis-\d+-[0-9a-f-]{36}\.dump$/i;
const stderrLimit = 8_000;

export type BackupCommandRunner = (
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) => Promise<void>;

type BackupRouteOptions = {
  backupDirectory?: string;
  pgDumpPath?: string;
  pgRestorePath?: string;
  runCommand?: BackupCommandRunner;
  sourceDatabaseUrl?: string;
  restoreDatabaseUrl?: string;
  restoreEnabled?: boolean;
  production?: boolean;
};

type ConnectionDetails = {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslmode?: string;
  sslrootcert?: string;
  sslcert?: string;
  sslkey?: string;
};

class BackupOperationError extends Error {
  constructor(message: string, public readonly statusCode = 503) {
    super(message);
    this.name = 'BackupOperationError';
  }
}

function parseConnectionString(connectionString: string): ConnectionDetails {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new BackupOperationError('PostgreSQL connection configuration is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new BackupOperationError('PostgreSQL connection configuration is invalid.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const username = decodeURIComponent(url.username);
  if (!url.hostname || !database || !username) {
    throw new BackupOperationError('PostgreSQL connection configuration is incomplete.');
  }
  return {
    host: url.hostname,
    port: url.port || '5432',
    database,
    username,
    password: decodeURIComponent(url.password),
    sslmode: url.searchParams.get('sslmode') ?? undefined,
    sslrootcert: url.searchParams.get('sslrootcert') ?? undefined,
    sslcert: url.searchParams.get('sslcert') ?? undefined,
    sslkey: url.searchParams.get('sslkey') ?? undefined,
  };
}

function postgresEnvironment(connection: ConnectionDetails): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    PGPASSWORD: connection.password,
    ...(connection.sslmode ? { PGSSLMODE: connection.sslmode } : {}),
    ...(connection.sslrootcert ? { PGSSLROOTCERT: connection.sslrootcert } : {}),
    ...(connection.sslcert ? { PGSSLCERT: connection.sslcert } : {}),
    ...(connection.sslkey ? { PGSSLKEY: connection.sslkey } : {}),
  };
}

function connectionArgs(connection: ConnectionDetails): string[] {
  return [
    '--host', connection.host,
    '--port', connection.port,
    '--username', connection.username,
  ];
}

const defaultCommandRunner: BackupCommandRunner = (executable, args, environment) => (
  new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(executable, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-stderrLimit);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new BackupOperationError(`Required PostgreSQL utility "${executable}" was not found. Install PostgreSQL client tools or configure its executable path.`)
        : new BackupOperationError(`Could not start PostgreSQL utility "${executable}": ${error.message}`));
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const safeStderr = stderr.replace(/password\s*=\s*\S+/ig, 'password=[REDACTED]');
      reject(new BackupOperationError(
        safeStderr.trim()
          ? `PostgreSQL utility "${executable}" failed: ${safeStderr.trim()}`
          : `PostgreSQL utility "${executable}" failed with exit code ${code ?? 'unknown'}.`,
      ));
    });
  })
);

function authorizationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  if (requireRole(request, backupRoles)) return null;
  const authenticated = requireAuth(request);
  return reply.code(authenticated ? 403 : 401).send({
    success: false,
    message: authenticated ? 'You do not have permission to manage database backups.' : 'Authentication required.',
    data: null,
  });
}

function validBackupFilePath(backupDirectory: string, filename: string): string {
  if (!backupFilenamePattern.test(filename)) {
    throw new BackupOperationError('Backup metadata contains an invalid backup filename.', 400);
  }
  const root = path.resolve(backupDirectory);
  const filePath = path.resolve(root, filename);
  if (path.dirname(filePath) !== root) {
    throw new BackupOperationError('Backup file path is invalid.', 400);
  }
  return filePath;
}

async function requireBackupFile(filePath: string): Promise<void> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new BackupOperationError('Backup file is missing from the configured backup directory.', 404);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new BackupOperationError('Backup file is invalid or empty.', 400);
  }
}

function restoreTarget(
  sourceUrl: string,
  restoreUrl: string | undefined,
  enabled: boolean,
  production: boolean,
): { connection: ConnectionDetails; environment: NodeJS.ProcessEnv } {
  if (production || !enabled) {
    throw new BackupOperationError('Restore is disabled. Configure a dedicated restore database and explicitly enable restore outside production.');
  }
  if (!restoreUrl) {
    throw new BackupOperationError('BCIS_RESTORE_DATABASE_URL must point to a dedicated restore database.');
  }
  const source = parseConnectionString(sourceUrl);
  const target = parseConnectionString(restoreUrl);
  if (target.database === source.database
    && target.host.toLowerCase() === source.host.toLowerCase()
    && target.port === source.port) {
    throw new BackupOperationError('Restore destination must not be the live application database.', 409);
  }
  if (!target.database.toLowerCase().endsWith('_restore')) {
    throw new BackupOperationError('Restore destination database name must end with "_restore".', 409);
  }
  return { connection: target, environment: postgresEnvironment(target) };
}

export function createBackupRoutes(options: BackupRouteOptions = {}): FastifyPluginAsync {
  const backupDirectory = path.resolve(options.backupDirectory ?? config.BCIS_BACKUP_DIRECTORY);
  const pgDumpPath = options.pgDumpPath ?? config.PG_DUMP_PATH;
  const pgRestorePath = options.pgRestorePath ?? config.PG_RESTORE_PATH;
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const sourceDatabaseUrl = options.sourceDatabaseUrl ?? config.DATABASE_URL;

  return async (fastify) => {
    fastify.get('/api/v1/backups', async (request, reply) => {
      const failure = authorizationFailure(request, reply);
      if (failure) return failure;
      if (!db) {
        return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
      }
      const records = await db.select({
        id: backupHistory.id,
        backupFile: backupHistory.backupFile,
        backupDate: backupHistory.backupDate,
        createdBy: backupHistory.createdBy,
        status: backupHistory.status,
        verified: backupHistory.verified,
        notes: backupHistory.notes,
      }).from(backupHistory).orderBy(desc(backupHistory.backupDate), desc(backupHistory.id));
      return reply.send({ success: true, message: 'Backup history loaded.', data: records });
    });

    fastify.post('/api/v1/backups', async (request, reply) => {
      const failure = authorizationFailure(request, reply);
      if (failure) return failure;
      if (!db) {
        return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
      }
      const session = requireRole(request, backupRoles);
      if (!session) throw new Error('Authorized backup session disappeared.');

      const filename = `bcis-${Date.now()}-${randomUUID()}.dump`;
      const filePath = validBackupFilePath(backupDirectory, filename);
      let connection: ConnectionDetails;
      try {
        connection = parseConnectionString(sourceDatabaseUrl);
        await mkdir(backupDirectory, { recursive: true });
        await runCommand(pgDumpPath, [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          ...connectionArgs(connection),
          '--file', filePath,
          '--dbname', connection.database,
        ], postgresEnvironment(connection));
        await requireBackupFile(filePath);
        await runCommand(pgRestorePath, ['--list', filePath], postgresEnvironment(connection));
      } catch (error) {
        let message = error instanceof Error ? error.message : 'PostgreSQL backup failed.';
        try {
          await rm(filePath, { force: true });
        } catch {
          message = `${message} A partial backup file could not be removed; an administrator must clean the backup directory.`;
        }
        let failureRecord: { id: number; backupFile: string; status: string; verified: boolean } | null = null;
        try {
          const [record] = await db.insert(backupHistory).values({
            backupFile: filename,
            createdBy: session.userId,
            status: 'FAILED',
            verified: false,
            notes: message.slice(0, 2_000),
          }).returning({
            id: backupHistory.id,
            backupFile: backupHistory.backupFile,
            status: backupHistory.status,
            verified: backupHistory.verified,
          });
          failureRecord = record ?? null;
        } catch {
          message = `${message} Failed-backup metadata could not be recorded.`;
        }
        const statusCode = error instanceof BackupOperationError ? error.statusCode : 503;
        return reply.code(statusCode).send({ success: false, message, data: failureRecord });
      }

      let record;
      try {
        [record] = await db.insert(backupHistory).values({
          backupFile: filename,
          createdBy: session.userId,
          status: 'SUCCESS',
          verified: true,
          notes: 'Custom-format PostgreSQL dump created and verified with pg_restore --list.',
        }).returning({
          id: backupHistory.id,
          backupFile: backupHistory.backupFile,
          backupDate: backupHistory.backupDate,
          createdBy: backupHistory.createdBy,
          status: backupHistory.status,
          verified: backupHistory.verified,
          notes: backupHistory.notes,
        });
      } catch (error) {
        await rm(filePath, { force: true });
        throw error;
      }
      if (!record) {
        await rm(filePath, { force: true });
        throw new Error('Backup was created but its metadata could not be stored.');
      }
      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE_BACKUP',
        entityType: 'backup_history',
        entityId: record.id,
        newValues: { backupFile: filename, verified: true },
        ipAddress: request.ip,
      });
      return reply.code(201).send({
        success: true,
        message: 'Database backup created and verified.',
        data: record,
      });
    });

    fastify.post('/api/v1/backups/:id/restore', async (request, reply) => {
      const session = requireRole(request, ['OWNER']);
      if (!session) {
        const authenticated = requireAuth(request);
        return reply.code(authenticated ? 403 : 401).send({
          success: false,
          message: authenticated ? 'Only an OWNER may restore a database backup.' : 'Authentication required.',
          data: null,
        });
      }
      if (!db) {
        return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
      }
      const parsedParams = backupIdSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ success: false, message: 'Invalid backup ID.', data: null });
      }

      let destination: ReturnType<typeof restoreTarget>;
      try {
        destination = restoreTarget(
          sourceDatabaseUrl,
          options.restoreDatabaseUrl ?? config.BCIS_RESTORE_DATABASE_URL,
          options.restoreEnabled ?? config.BCIS_ENABLE_RESTORE === 'true',
          options.production ?? process.env.NODE_ENV === 'production',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Restore configuration is invalid.';
        const statusCode = error instanceof BackupOperationError ? error.statusCode : 503;
        return reply.code(statusCode).send({ success: false, message, data: null });
      }

      const [record] = await db.select({
        id: backupHistory.id,
        backupFile: backupHistory.backupFile,
        status: backupHistory.status,
        verified: backupHistory.verified,
      }).from(backupHistory)
        .where(eq(backupHistory.id, parsedParams.data.id))
        .limit(1);
      if (!record) {
        return reply.code(404).send({ success: false, message: 'Backup record not found.', data: null });
      }
      if (record.status !== 'SUCCESS' || !record.verified) {
        return reply.code(409).send({ success: false, message: 'Only successfully verified backups can be restored.', data: null });
      }

      let filePath: string;
      try {
        filePath = validBackupFilePath(backupDirectory, record.backupFile);
        await requireBackupFile(filePath);
        await runCommand(pgRestorePath, ['--list', filePath], destination.environment);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Backup file could not be validated.';
        const statusCode = error instanceof BackupOperationError ? error.statusCode : 400;
        return reply.code(statusCode).send({ success: false, message, data: null });
      }

      try {
        await runCommand(pgRestorePath, [
          '--format=custom',
          '--clean',
          '--if-exists',
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          ...connectionArgs(destination.connection),
          '--dbname', destination.connection.database,
          filePath,
        ], destination.environment);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'PostgreSQL restore failed.';
        const statusCode = error instanceof BackupOperationError ? error.statusCode : 503;
        return reply.code(statusCode).send({ success: false, message, data: null });
      }

      await writeAuditLog({
        userId: session.userId,
        action: 'RESTORE_BACKUP',
        entityType: 'backup_history',
        entityId: record.id,
        reason: 'Restored to the explicitly configured dedicated restore database.',
        newValues: { destinationDatabase: destination.connection.database },
        ipAddress: request.ip,
      });
      return reply.send({
        success: true,
        message: 'Backup restored to the configured dedicated restore database.',
        data: { id: record.id, restored: true },
      });
    });
  };
}

export const backupRoutes = createBackupRoutes();

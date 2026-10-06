import { auditLogs } from '../../db/schema';
import { db } from './db';

type DatabaseTransaction = Parameters<
  Parameters<NonNullable<typeof db>['transaction']>[0]
>[0];

type AuditPayload = {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  reason?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  ipAddress?: string | null;
};

const sensitiveKeyPattern = /password|token|authorization|secret|credential|api.?key|private.?key|session|cookie/i;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitizeValue(item),
    ]),
  );
}

function serializeValues(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    return JSON.stringify(sanitizeValue(value));
  } catch {
    return null;
  }
}

export async function writeAuditLog(
  payload: AuditPayload,
  transaction?: DatabaseTransaction,
): Promise<void> {
  if (transaction) {
    await transaction.insert(auditLogs).values({
      userId: payload.userId ?? null,
      action: payload.action,
      entityType: payload.entityType,
      entityId: payload.entityId ?? null,
      reason: payload.reason ?? null,
      oldValues: serializeValues(payload.oldValues),
      newValues: serializeValues(payload.newValues),
      ipAddress: payload.ipAddress ?? null,
    });
    return;
  }

  if (!db) {
    return;
  }

  try {
    await db.insert(auditLogs).values({
      userId: payload.userId ?? null,
      action: payload.action,
      entityType: payload.entityType,
      entityId: payload.entityId ?? null,
      reason: payload.reason ?? null,
      oldValues: serializeValues(payload.oldValues),
      newValues: serializeValues(payload.newValues),
      ipAddress: payload.ipAddress ?? null,
    });
  } catch {
    console.warn('Audit log write failed.');
  }
}

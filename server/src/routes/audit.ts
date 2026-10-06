import { FastifyPluginAsync } from 'fastify';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  lte,
  SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { db } from '../lib/db';

const { auditLogs, users } = schema;

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const querySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().min(1).max(100).optional(),
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  startDate: z.iso.datetime().optional(),
  endDate: z.iso.datetime().optional(),
}).refine((value) => (
  !value.startDate
  || !value.endDate
  || value.startDate <= value.endDate
), {
  message: 'Start date must be on or before end date.',
  path: ['endDate'],
});

const auditRoles = ['OWNER', 'ADMINISTRATOR', 'ACCOUNTING_AUDITOR'];
const sensitiveKeyPattern = /password|token|authorization|secret|credential|api.?key|private.?key|session|cookie/i;

function sanitizeAuditValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed.map(sanitizeAuditItem);
    }

    if (typeof parsed === 'object' && parsed !== null) {
      return sanitizeAuditItem(parsed);
    }

    return null;
  } catch {
    return null;
  }
}

function sanitizeAuditItem(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditItem);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitizeAuditItem(child),
    ]),
  );
}

function toSafeAuditLog<T extends {
  oldValues: string | null;
  newValues: string | null;
}>(entry: T) {
  return {
    ...entry,
    oldValues: sanitizeAuditValue(entry.oldValues),
    newValues: sanitizeAuditValue(entry.newValues),
  };
}

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/audit-logs', async (request, reply) => {
    const session = requireRole(request, auditRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
          data: null,
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to view audit logs.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
        data: null,
      });
    }

    const parsedQuery = querySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid audit log filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const filters = parsedQuery.data;
    const conditions: SQL[] = [];

    if (filters.userId !== undefined) {
      conditions.push(eq(auditLogs.userId, filters.userId));
    }
    if (filters.action !== undefined) {
      conditions.push(ilike(auditLogs.action, `%${filters.action}%`));
    }
    if (filters.entityType !== undefined) {
      conditions.push(ilike(auditLogs.entityType, `%${filters.entityType}%`));
    }
    if (filters.entityId !== undefined) {
      conditions.push(eq(auditLogs.entityId, filters.entityId));
    }
    if (filters.startDate !== undefined) {
      conditions.push(gte(auditLogs.createdAt, new Date(filters.startDate)));
    }
    if (filters.endDate !== undefined) {
      conditions.push(lte(auditLogs.createdAt, new Date(filters.endDate)));
    }

    const baseQuery = db
      .select({
        id: auditLogs.id,
        userId: auditLogs.userId,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        reason: auditLogs.reason,
        oldValues: auditLogs.oldValues,
        newValues: auditLogs.newValues,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
        username: users.username,
        userFullName: users.fullName,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id));

    const items = conditions.length > 0
      ? await baseQuery
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      : await baseQuery.orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));

    return reply.send({
      success: true,
      message: 'Audit logs loaded.',
      data: items.map(toSafeAuditLog),
    });
  });

  fastify.get('/api/v1/audit-logs/:id', async (request, reply) => {
    const session = requireRole(request, auditRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
          data: null,
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to view audit logs.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
        data: null,
      });
    }

    const parsedParams = paramsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid audit log ID.',
        data: null,
      });
    }

    const [entry] = await db
      .select({
        id: auditLogs.id,
        userId: auditLogs.userId,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        reason: auditLogs.reason,
        oldValues: auditLogs.oldValues,
        newValues: auditLogs.newValues,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
        username: users.username,
        userFullName: users.fullName,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(eq(auditLogs.id, parsedParams.data.id))
      .limit(1);

    if (!entry) {
      return reply.code(404).send({
        success: false,
        message: 'Audit log not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Audit log loaded.',
      data: toSafeAuditLog(entry),
    });
  });
};

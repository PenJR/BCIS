import { randomUUID } from 'node:crypto';
import { FastifyPluginAsync } from 'fastify';
import {
  and,
  desc,
  eq,
  gte,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  users,
  collectionAreas,
  subscribers,
  serviceAccounts,
  collectorAssignments,
  collectionBatches,
  batchAccounts,
  collectorRemittances,
  payments,
  ledgerEntries,
  paymentProofs,
} = schema;

const managerRoles = ['OWNER', 'ADMINISTRATOR', 'COLLECTION_SUPERVISOR'];
const collectionWriteRoles = [...managerRoles, 'CASHIER'];
const batchStatuses = [
  'OPEN',
  'IN_PROGRESS',
  'SUBMITTED',
  'REMITTED',
  'RECONCILED',
  'CLOSED',
] as const;

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const batchIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, {
  message: 'Enter a non-negative amount with up to two decimal places.',
});

const positiveMoneySchema = moneySchema.refine((value) => /[1-9]/.test(value), {
  message: 'Amount must be greater than zero.',
});

const assignmentQuerySchema = z.object({
  collectorId: z.coerce.number().int().positive().optional(),
  collectionAreaId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const createAssignmentSchema = z.object({
  collectorId: z.number().int().positive(),
  collectionAreaId: z.number().int().positive(),
  assignedFrom: z.iso.date(),
  assignedTo: z.iso.date().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
}).refine((value) => (
  !value.assignedTo || value.assignedTo >= value.assignedFrom
), {
  message: 'Assignment end date must be on or after its start date.',
  path: ['assignedTo'],
});

const batchQuerySchema = z.object({
  collectorId: z.coerce.number().int().positive().optional(),
  collectionAreaId: z.coerce.number().int().positive().optional(),
  status: z.enum(batchStatuses).optional(),
  collectionDate: z.iso.date().optional(),
});

const createBatchSchema = z.object({
  batchNumber: z.string().trim().min(1).max(40),
  collectorId: z.number().int().positive(),
  collectionAreaId: z.number().int().positive(),
  collectionDate: z.iso.date(),
  expectedCash: moneySchema.default('0'),
  expectedNonCash: moneySchema.default('0'),
  notes: z.string().nullable().optional(),
});

const createBatchAccountSchema = z.object({
  serviceAccountId: z.number().int().positive(),
  expectedAmount: positiveMoneySchema,
});

const remittanceQuerySchema = z.object({
  batchId: z.coerce.number().int().positive().optional(),
  status: z.enum(['PENDING', 'RECONCILED']).optional(),
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

const createRemittanceSchema = z.object({
  batchId: z.number().int().positive(),
  remittedCash: moneySchema,
  remittanceDate: z.iso.datetime().optional(),
  shortageReason: z.string().trim().min(1).nullable().optional(),
});

const createCollectionPaymentSchema = z.object({
  amount: positiveMoneySchema,
  paymentMethod: z.enum(['Cash', 'GCash', 'Bank Transfer', 'Cheque', 'Other']),
  referenceNumber: z.string().trim().min(1).max(100).optional(),
  notes: z.string().nullable().optional(),
}).superRefine((value, context) => {
  if (value.paymentMethod === 'GCash' && !value.referenceNumber) {
    context.addIssue({
      code: 'custom',
      path: ['referenceNumber'],
      message: 'GCash collection payments require a reference number.',
    });
  }
});

type DatabaseTransaction = Parameters<
  Parameters<NonNullable<typeof db>['transaction']>[0]
>[0];

function amountToCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToAmount(amount: bigint): string {
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

async function recalculateBatchTotals(
  transaction: DatabaseTransaction,
  batchId: number,
): Promise<void> {
  const [batch] = await transaction
    .select({ status: collectionBatches.status })
    .from(collectionBatches)
    .where(eq(collectionBatches.id, batchId))
    .for('update')
    .limit(1);
  if (!batch) {
    throw new Error(`Collection batch ${batchId} disappeared while calculating totals.`);
  }

  const collected = await transaction
    .select({
      amount: payments.amount,
      method: payments.paymentMethod,
    })
    .from(ledgerEntries)
    .innerJoin(payments, eq(ledgerEntries.paymentId, payments.id))
    .where(and(
      eq(ledgerEntries.entryType, 'COLLECTION'),
      eq(ledgerEntries.referenceNumber, `BATCH-${batchId}`),
      eq(payments.status, 'POSTED'),
    ));
  const cashCents = collected.reduce(
    (sum, payment) => payment.method === 'Cash'
      ? sum + amountToCents(payment.amount)
      : sum,
    0n,
  );
  const nonCashCents = collected.reduce(
    (sum, payment) => payment.method === 'Cash'
      ? sum
      : sum + amountToCents(payment.amount),
    0n,
  );

  await transaction
    .update(collectionBatches)
    .set({
      expectedCash: centsToAmount(cashCents),
      expectedNonCash: centsToAmount(nonCashCents),
      status: batch.status === 'OPEN' ? 'IN_PROGRESS' : batch.status,
    })
    .where(eq(collectionBatches.id, batchId));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23503';
}

const assignmentFields = {
  id: collectorAssignments.id,
  collectorId: collectorAssignments.collectorId,
  collectionAreaId: collectorAssignments.collectionAreaId,
  assignedFrom: collectorAssignments.assignedFrom,
  assignedTo: collectorAssignments.assignedTo,
  status: collectorAssignments.status,
  collectorName: users.fullName,
  areaCode: collectionAreas.areaCode,
  areaName: collectionAreas.areaName,
};

const batchFields = {
  id: collectionBatches.id,
  batchNumber: collectionBatches.batchNumber,
  collectorId: collectionBatches.collectorId,
  collectionAreaId: collectionBatches.collectionAreaId,
  collectionDate: collectionBatches.collectionDate,
  status: collectionBatches.status,
  expectedCash: collectionBatches.expectedCash,
  expectedNonCash: collectionBatches.expectedNonCash,
  notes: collectionBatches.notes,
  createdAt: collectionBatches.createdAt,
  collectorName: users.fullName,
  areaCode: collectionAreas.areaCode,
  areaName: collectionAreas.areaName,
};

export const collectionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/collection-assignments', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedQuery = assignmentQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({ success: false, message: 'Invalid assignment filters.', data: parsedQuery.error.flatten() });
    }

    const filters = parsedQuery.data;
    const items = await db
      .select(assignmentFields)
      .from(collectorAssignments)
      .innerJoin(users, eq(collectorAssignments.collectorId, users.id))
      .innerJoin(collectionAreas, eq(collectorAssignments.collectionAreaId, collectionAreas.id))
      .where(and(
        filters.collectorId === undefined ? undefined : eq(collectorAssignments.collectorId, filters.collectorId),
        filters.collectionAreaId === undefined ? undefined : eq(collectorAssignments.collectionAreaId, filters.collectionAreaId),
        filters.status === undefined ? undefined : eq(collectorAssignments.status, filters.status),
      ))
      .orderBy(desc(collectorAssignments.assignedFrom), desc(collectorAssignments.id));

    return reply.send({ success: true, message: 'Collection assignments loaded.', data: items });
  });

  fastify.post('/api/v1/collection-assignments', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create collection assignments.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedBody = createAssignmentSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: 'Valid assignment data is required.', data: parsedBody.error.flatten() });
    }

    const [collector] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, parsedBody.data.collectorId))
      .limit(1);

    if (!collector) {
      return reply.code(404).send({ success: false, message: 'Collector user not found.', data: null });
    }

    if (collector.status !== 'ACTIVE') {
      return reply.code(409).send({ success: false, message: 'Collector user is not active.', data: null });
    }

    const [area] = await db
      .select({ id: collectionAreas.id, status: collectionAreas.status })
      .from(collectionAreas)
      .where(eq(collectionAreas.id, parsedBody.data.collectionAreaId))
      .limit(1);

    if (!area) {
      return reply.code(404).send({ success: false, message: 'Collection area not found.', data: null });
    }

    if (area.status !== 'ACTIVE') {
      return reply.code(409).send({ success: false, message: 'Collection area is not active.', data: null });
    }

    if (parsedBody.data.status === 'ACTIVE') {
      const requestedEnd = parsedBody.data.assignedTo ?? '9999-12-31';
      const [conflict] = await db
        .select({ id: collectorAssignments.id })
        .from(collectorAssignments)
        .where(and(
          eq(collectorAssignments.collectorId, parsedBody.data.collectorId),
          eq(collectorAssignments.collectionAreaId, parsedBody.data.collectionAreaId),
          eq(collectorAssignments.status, 'ACTIVE'),
          lte(collectorAssignments.assignedFrom, requestedEnd),
          or(
            isNull(collectorAssignments.assignedTo),
            gte(collectorAssignments.assignedTo, parsedBody.data.assignedFrom),
          ),
        ))
        .limit(1);

      if (conflict) {
        return reply.code(409).send({ success: false, message: 'An active assignment already overlaps this collector and area date range.', data: null });
      }
    }

    const [created] = await db
      .insert(collectorAssignments)
      .values(parsedBody.data)
      .returning();

    if (created) {
      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'collector_assignments',
        entityId: created.id,
        newValues: created,
        ipAddress: request.ip,
      });
    }

    return reply.code(201).send({ success: true, message: 'Collection assignment created.', data: created ?? null });
  });

  fastify.get('/api/v1/collection-batches', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedQuery = batchQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({ success: false, message: 'Invalid collection batch filters.', data: parsedQuery.error.flatten() });
    }

    const filters = parsedQuery.data;
    const items = await db
      .select(batchFields)
      .from(collectionBatches)
      .innerJoin(users, eq(collectionBatches.collectorId, users.id))
      .innerJoin(collectionAreas, eq(collectionBatches.collectionAreaId, collectionAreas.id))
      .where(and(
        filters.collectorId === undefined ? undefined : eq(collectionBatches.collectorId, filters.collectorId),
        filters.collectionAreaId === undefined ? undefined : eq(collectionBatches.collectionAreaId, filters.collectionAreaId),
        filters.status === undefined ? undefined : eq(collectionBatches.status, filters.status),
        filters.collectionDate === undefined ? undefined : eq(collectionBatches.collectionDate, filters.collectionDate),
      ))
      .orderBy(desc(collectionBatches.collectionDate), desc(collectionBatches.createdAt));

    return reply.send({ success: true, message: 'Collection batches loaded.', data: items });
  });

  fastify.get('/api/v1/collection-batches/:id', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedParams = idParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: 'Invalid collection batch ID.', data: null });
    }

    const [batch] = await db
      .select(batchFields)
      .from(collectionBatches)
      .innerJoin(users, eq(collectionBatches.collectorId, users.id))
      .innerJoin(collectionAreas, eq(collectionBatches.collectionAreaId, collectionAreas.id))
      .where(eq(collectionBatches.id, parsedParams.data.id))
      .limit(1);

    if (!batch) {
      return reply.code(404).send({ success: false, message: 'Collection batch not found.', data: null });
    }

    return reply.send({ success: true, message: 'Collection batch loaded.', data: batch });
  });

  fastify.post('/api/v1/collection-batches', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create collection batches.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedBody = createBatchSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: 'Valid collection batch data is required.', data: parsedBody.error.flatten() });
    }

    const [collector] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, parsedBody.data.collectorId))
      .limit(1);

    if (!collector) {
      return reply.code(404).send({ success: false, message: 'Collector user not found.', data: null });
    }

    if (collector.status !== 'ACTIVE') {
      return reply.code(409).send({ success: false, message: 'Collector user is not active.', data: null });
    }

    const [area] = await db
      .select({ id: collectionAreas.id, status: collectionAreas.status })
      .from(collectionAreas)
      .where(eq(collectionAreas.id, parsedBody.data.collectionAreaId))
      .limit(1);

    if (!area) {
      return reply.code(404).send({ success: false, message: 'Collection area not found.', data: null });
    }

    if (area.status !== 'ACTIVE') {
      return reply.code(409).send({ success: false, message: 'Collection area is not active.', data: null });
    }

    const [assignment] = await db
      .select({ id: collectorAssignments.id })
      .from(collectorAssignments)
      .where(and(
        eq(collectorAssignments.collectorId, parsedBody.data.collectorId),
        eq(collectorAssignments.collectionAreaId, parsedBody.data.collectionAreaId),
        eq(collectorAssignments.status, 'ACTIVE'),
        lte(collectorAssignments.assignedFrom, parsedBody.data.collectionDate),
        or(
          isNull(collectorAssignments.assignedTo),
          gte(collectorAssignments.assignedTo, parsedBody.data.collectionDate),
        ),
      ))
      .limit(1);

    if (!assignment) {
      return reply.code(409).send({ success: false, message: 'Collector has no active assignment for this area and collection date.', data: null });
    }

    try {
      const [created] = await db
        .insert(collectionBatches)
        .values({
          ...parsedBody.data,
          status: 'OPEN',
        })
        .returning();

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'collection_batches',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({ success: true, message: 'Collection batch created.', data: created ?? null });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Batch number already exists.', data: null });
      }

      if (isForeignKeyViolation(error)) {
        return reply.code(404).send({ success: false, message: 'Collector or collection area not found.', data: null });
      }

      throw error;
    }
  });

  fastify.get('/api/v1/collection-batches/:id/accounts', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedParams = idParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: 'Invalid collection batch ID.', data: null });
    }

    const [batch] = await db
      .select({ id: collectionBatches.id })
      .from(collectionBatches)
      .where(eq(collectionBatches.id, parsedParams.data.id))
      .limit(1);

    if (!batch) {
      return reply.code(404).send({ success: false, message: 'Collection batch not found.', data: null });
    }

    const accounts = await db
      .select({
        id: batchAccounts.id,
        batchId: batchAccounts.batchId,
        serviceAccountId: batchAccounts.serviceAccountId,
        expectedAmount: batchAccounts.expectedAmount,
        collectedAmount: batchAccounts.collectedAmount,
        status: batchAccounts.status,
        serviceAccountNumber: serviceAccounts.serviceAccountNumber,
        subscriberId: subscribers.id,
        subscriberAccountNumber: subscribers.accountNumber,
        subscriberFirstName: subscribers.firstName,
        subscriberLastName: subscribers.lastName,
      })
      .from(batchAccounts)
      .innerJoin(serviceAccounts, eq(batchAccounts.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .where(eq(batchAccounts.batchId, batch.id))
      .orderBy(desc(batchAccounts.id));

    return reply.send({ success: true, message: 'Batch accounts loaded.', data: accounts });
  });

  fastify.post('/api/v1/collection-batches/:id/accounts', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to add batch accounts.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedParams = idParamsSchema.safeParse(request.params);
    const parsedBody = createBatchAccountSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({ success: false, message: 'Invalid batch ID or batch account data.', data: null });
    }

    const result = await db.transaction(async (transaction) => {
      const [batch] = await transaction
        .select({
          id: collectionBatches.id,
          collectorId: collectionBatches.collectorId,
          collectionAreaId: collectionBatches.collectionAreaId,
          status: collectionBatches.status,
        })
        .from(collectionBatches)
        .where(eq(collectionBatches.id, parsedParams.data.id))
        .for('update')
        .limit(1);

      if (!batch) {
        return { type: 'batch_not_found' as const };
      }

      const [serviceAccount] = await transaction
        .select({
          id: serviceAccounts.id,
          subscriberId: serviceAccounts.subscriberId,
          assignedCollectorId: serviceAccounts.assignedCollectorId,
          collectionAreaId: subscribers.collectionAreaId,
        })
        .from(serviceAccounts)
        .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
        .where(eq(serviceAccounts.id, parsedBody.data.serviceAccountId))
        .limit(1);

      if (!serviceAccount) {
        return { type: 'service_account_not_found' as const };
      }

      if (!['OPEN', 'IN_PROGRESS'].includes(batch.status)) {
        return { type: 'batch_closed' as const };
      }

      if (serviceAccount.collectionAreaId !== batch.collectionAreaId) {
        return { type: 'area_mismatch' as const };
      }

      if (
        serviceAccount.assignedCollectorId !== null
        && serviceAccount.assignedCollectorId !== batch.collectorId
      ) {
        return { type: 'collector_mismatch' as const };
      }

      const [existingAccount] = await transaction
        .select({ id: batchAccounts.id })
        .from(batchAccounts)
        .where(and(
          eq(batchAccounts.batchId, batch.id),
          eq(batchAccounts.serviceAccountId, serviceAccount.id),
        ))
        .limit(1);

      if (existingAccount) {
        return { type: 'duplicate_account' as const };
      }

      const [created] = await transaction
        .insert(batchAccounts)
        .values({
          batchId: batch.id,
          serviceAccountId: serviceAccount.id,
          expectedAmount: parsedBody.data.expectedAmount,
          collectedAmount: '0',
          status: 'UNPAID',
        })
        .returning();

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'ADD_ACCOUNT',
          entityType: 'batch_accounts',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        }, transaction);
      }

      return { type: 'created' as const, account: created };
    });

    if (result.type === 'batch_not_found') {
      return reply.code(404).send({ success: false, message: 'Collection batch not found.', data: null });
    }

    if (result.type === 'service_account_not_found') {
      return reply.code(404).send({ success: false, message: 'Service account not found.', data: null });
    }

    if (result.type === 'batch_closed') {
      return reply.code(409).send({ success: false, message: 'Accounts cannot be added to a submitted or closed batch.', data: null });
    }

    if (result.type === 'area_mismatch') {
      return reply.code(409).send({ success: false, message: 'Service account subscriber is outside this collection area.', data: null });
    }

    if (result.type === 'collector_mismatch') {
      return reply.code(409).send({ success: false, message: 'Service account is assigned to a different collector.', data: null });
    }

    if (result.type === 'duplicate_account') {
      return reply.code(409).send({ success: false, message: 'Service account is already included in this batch.', data: null });
    }

    return reply.code(201).send({ success: true, message: 'Account added to collection batch.', data: result.account ?? null });
  });

  fastify.post('/api/v1/collection-batches/:id/accounts/:accountId/payments', async (request, reply) => {
    const session = requireAuth(request);
    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
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

    const parsedParams = z.object({
      id: z.coerce.number().int().positive(),
      accountId: z.coerce.number().int().positive(),
    }).safeParse(request.params);
    const parsedBody = createCollectionPaymentSchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid batch, account, or collection payment data.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [batch] = await transaction
        .select({
          id: collectionBatches.id,
          collectorId: collectionBatches.collectorId,
          status: collectionBatches.status,
        })
        .from(collectionBatches)
        .where(eq(collectionBatches.id, parsedParams.data.id))
        .for('update')
        .limit(1);
      if (!batch) return { type: 'batch_not_found' as const };

      const manager = collectionWriteRoles.includes(session.role);
      if (!manager && session.userId !== batch.collectorId) {
        return { type: 'forbidden' as const };
      }
      if (!['OPEN', 'IN_PROGRESS'].includes(batch.status)) {
        return { type: 'batch_closed' as const };
      }

      const [account] = await transaction
        .select({
          id: batchAccounts.id,
          batchId: batchAccounts.batchId,
          serviceAccountId: batchAccounts.serviceAccountId,
          subscriberId: serviceAccounts.subscriberId,
          expectedAmount: batchAccounts.expectedAmount,
          collectedAmount: batchAccounts.collectedAmount,
        })
        .from(batchAccounts)
        .innerJoin(serviceAccounts, eq(batchAccounts.serviceAccountId, serviceAccounts.id))
        .where(and(
          eq(batchAccounts.id, parsedParams.data.accountId),
          eq(batchAccounts.batchId, batch.id),
        ))
        .for('update')
        .limit(1);
      if (!account) return { type: 'account_not_found' as const };

      const amountCents = amountToCents(parsedBody.data.amount);
      const expectedCents = amountToCents(account.expectedAmount);
      const alreadyCollectedCents = amountToCents(account.collectedAmount);
      if (amountCents > expectedCents - alreadyCollectedCents) {
        return { type: 'amount_exceeded' as const };
      }

      if (parsedBody.data.referenceNumber) {
        await transaction.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext(${parsedBody.data.referenceNumber}))
        `);
        const [duplicatePayment] = await transaction
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.referenceNumber, parsedBody.data.referenceNumber))
          .limit(1);
        const [duplicateProof] = await transaction
          .select({ id: paymentProofs.id })
          .from(paymentProofs)
          .where(eq(paymentProofs.referenceNumber, parsedBody.data.referenceNumber))
          .limit(1);
        if (duplicatePayment || duplicateProof) {
          return { type: 'duplicate_reference' as const };
        }
      }

      const [payment] = await transaction
        .insert(payments)
        .values({
          paymentNumber: `PAY-${randomUUID()}`,
          subscriberId: account.subscriberId,
          amount: parsedBody.data.amount,
          paymentMethod: parsedBody.data.paymentMethod,
          referenceNumber: parsedBody.data.referenceNumber,
          notes: parsedBody.data.notes,
          status: 'POSTED',
          receivedBy: session.userId,
        })
        .returning();
      if (!payment) throw new Error('Collection payment insert returned no record.');

      const collectedTotal = alreadyCollectedCents + amountCents;
      const [updatedAccount] = await transaction
        .update(batchAccounts)
        .set({
          collectedAmount: centsToAmount(collectedTotal),
          status: collectedTotal >= expectedCents ? 'PAID' : 'PARTIALLY_PAID',
        })
        .where(eq(batchAccounts.id, account.id))
        .returning();

      await transaction.insert(ledgerEntries).values({
        serviceAccountId: account.serviceAccountId,
        paymentId: payment.id,
        entryType: 'COLLECTION',
        description: `Collection received for batch ${batch.id}`,
        debit: '0.00',
        credit: parsedBody.data.amount,
        referenceNumber: `BATCH-${batch.id}`,
      });
      await recalculateBatchTotals(transaction, batch.id);
      await writeAuditLog({
        userId: session.userId,
        action: 'RECORD_COLLECTION',
        entityType: 'payments',
        entityId: payment.id,
        newValues: {
          payment,
          batchId: batch.id,
          batchAccountId: account.id,
          collectedAmount: updatedAccount?.collectedAmount,
        },
        ipAddress: request.ip,
      }, transaction);

      return {
        type: 'recorded' as const,
        payment,
        account: updatedAccount,
      };
    });

    if (result.type === 'batch_not_found') {
      return reply.code(404).send({ success: false, message: 'Collection batch not found.', data: null });
    }
    if (result.type === 'account_not_found') {
      return reply.code(404).send({ success: false, message: 'Batch account not found.', data: null });
    }
    if (result.type === 'forbidden') {
      return reply.code(403).send({ success: false, message: 'You do not have permission to record payments for this batch.', data: null });
    }
    if (result.type === 'batch_closed') {
      return reply.code(409).send({ success: false, message: 'Payments cannot be recorded for a submitted or closed batch.', data: null });
    }
    if (result.type === 'amount_exceeded') {
      return reply.code(409).send({ success: false, message: 'Collection amount exceeds the remaining expected amount for this account.', data: null });
    }
    if (result.type === 'duplicate_reference') {
      return reply.code(409).send({ success: false, message: 'Payment reference number has already been used.', data: null });
    }

    return reply.code(201).send({
      success: true,
      message: 'Collection payment recorded.',
      data: result,
    });
  });

  fastify.get('/api/v1/collector-remittances', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedQuery = remittanceQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({ success: false, message: 'Invalid remittance filters.', data: parsedQuery.error.flatten() });
    }

    const filters = parsedQuery.data;
    const items = await db
      .select({
        id: collectorRemittances.id,
        batchId: collectorRemittances.batchId,
        remittanceDate: collectorRemittances.remittanceDate,
        expectedCash: collectorRemittances.expectedCash,
        remittedCash: collectorRemittances.remittedCash,
        difference: collectorRemittances.difference,
        shortageReason: collectorRemittances.shortageReason,
        receivedBy: collectorRemittances.receivedBy,
        status: collectorRemittances.status,
        createdAt: collectorRemittances.createdAt,
        batchNumber: collectionBatches.batchNumber,
        collectorName: users.fullName,
        areaName: collectionAreas.areaName,
      })
      .from(collectorRemittances)
      .innerJoin(collectionBatches, eq(collectorRemittances.batchId, collectionBatches.id))
      .innerJoin(users, eq(collectionBatches.collectorId, users.id))
      .innerJoin(collectionAreas, eq(collectionBatches.collectionAreaId, collectionAreas.id))
      .where(and(
        filters.batchId === undefined ? undefined : eq(collectorRemittances.batchId, filters.batchId),
        filters.status === undefined ? undefined : eq(collectorRemittances.status, filters.status),
        filters.startDate === undefined ? undefined : gte(collectorRemittances.remittanceDate, new Date(filters.startDate)),
        filters.endDate === undefined ? undefined : lte(collectorRemittances.remittanceDate, new Date(filters.endDate)),
      ))
      .orderBy(desc(collectorRemittances.remittanceDate), desc(collectorRemittances.id));

    return reply.send({ success: true, message: 'Collector remittances loaded.', data: items });
  });

  fastify.get('/api/v1/collector-remittances/:id', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedParams = idParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: 'Invalid remittance ID.', data: null });
    }

    const [remittance] = await db
      .select({
        id: collectorRemittances.id,
        batchId: collectorRemittances.batchId,
        remittanceDate: collectorRemittances.remittanceDate,
        expectedCash: collectorRemittances.expectedCash,
        remittedCash: collectorRemittances.remittedCash,
        difference: collectorRemittances.difference,
        shortageReason: collectorRemittances.shortageReason,
        receivedBy: collectorRemittances.receivedBy,
        status: collectorRemittances.status,
        createdAt: collectorRemittances.createdAt,
        batchNumber: collectionBatches.batchNumber,
        collectorName: users.fullName,
        areaName: collectionAreas.areaName,
      })
      .from(collectorRemittances)
      .innerJoin(collectionBatches, eq(collectorRemittances.batchId, collectionBatches.id))
      .innerJoin(users, eq(collectionBatches.collectorId, users.id))
      .innerJoin(collectionAreas, eq(collectionBatches.collectionAreaId, collectionAreas.id))
      .where(eq(collectorRemittances.id, parsedParams.data.id))
      .limit(1);

    if (!remittance) {
      return reply.code(404).send({ success: false, message: 'Collector remittance not found.', data: null });
    }

    return reply.send({ success: true, message: 'Collector remittance loaded.', data: remittance });
  });

  fastify.post('/api/v1/collector-remittances', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create collector remittances.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const parsedBody = createRemittanceSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: 'Valid remittance data is required.', data: parsedBody.error.flatten() });
    }

    const [receiver] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!receiver) {
      return reply.code(404).send({ success: false, message: 'Receiving user not found.', data: null });
    }

    if (receiver.status !== 'ACTIVE') {
      return reply.code(403).send({ success: false, message: 'Receiving user is not active.', data: null });
    }

    const result = await db.transaction(async (transaction) => {
      const [batch] = await transaction
        .select({
          id: collectionBatches.id,
          expectedCash: collectionBatches.expectedCash,
          status: collectionBatches.status,
        })
        .from(collectionBatches)
        .where(eq(collectionBatches.id, parsedBody.data.batchId))
        .for('update')
        .limit(1);

      if (!batch) {
        return { type: 'batch_not_found' as const };
      }

      if (['REMITTED', 'RECONCILED', 'CLOSED'].includes(batch.status)) {
        return { type: 'batch_already_remitted' as const };
      }

      const expectedCents = amountToCents(batch.expectedCash);
      if (expectedCents === 0n) {
        return { type: 'no_cash_collections' as const };
      }

      const [existingRemittance] = await transaction
        .select({ id: collectorRemittances.id })
        .from(collectorRemittances)
        .where(eq(collectorRemittances.batchId, batch.id))
        .limit(1);

      if (existingRemittance) {
        return { type: 'duplicate_remittance' as const };
      }

      const remittedCents = amountToCents(parsedBody.data.remittedCash);
      const differenceCents = expectedCents - remittedCents;

      if (differenceCents > 0n && !parsedBody.data.shortageReason?.trim()) {
        return { type: 'shortage_reason_required' as const };
      }

      const balanced = differenceCents === 0n;
      const [remittance] = await transaction
        .insert(collectorRemittances)
        .values({
          batchId: batch.id,
          remittanceDate: parsedBody.data.remittanceDate
            ? new Date(parsedBody.data.remittanceDate)
            : undefined,
          expectedCash: batch.expectedCash,
          remittedCash: parsedBody.data.remittedCash,
          difference: centsToAmount(differenceCents),
          shortageReason: parsedBody.data.shortageReason ?? null,
          receivedBy: receiver.id,
          status: balanced ? 'RECONCILED' : 'PENDING',
        })
        .returning();

      await transaction
        .update(collectionBatches)
        .set({ status: balanced ? 'RECONCILED' : 'REMITTED' })
        .where(eq(collectionBatches.id, batch.id));

      if (remittance) {
        await writeAuditLog({
          userId: session.userId,
          action: 'REMIT',
          entityType: 'collector_remittances',
          entityId: remittance.id,
          reason: remittance.shortageReason,
          oldValues: { batchStatus: batch.status },
          newValues: remittance,
          ipAddress: request.ip,
        }, transaction);
      }

      return { type: 'created' as const, remittance };
    });

    if (result.type === 'batch_not_found') {
      return reply.code(404).send({ success: false, message: 'Collection batch not found.', data: null });
    }

    if (result.type === 'batch_already_remitted' || result.type === 'duplicate_remittance') {
      return reply.code(409).send({ success: false, message: 'Collection batch already has a remittance or is closed.', data: null });
    }

    if (result.type === 'no_cash_collections') {
      return reply.code(409).send({ success: false, message: 'Batch has no collected cash to remit.', data: null });
    }

    if (result.type === 'shortage_reason_required') {
      return reply.code(400).send({ success: false, message: 'A shortage reason is required when remitted cash is below expected cash.', data: null });
    }

    return reply.code(201).send({ success: true, message: 'Collector remittance recorded.', data: result.remittance ?? null });
  });
};

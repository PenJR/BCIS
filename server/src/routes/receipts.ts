import { randomUUID } from 'node:crypto';
import { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, gte, lte, SQL } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const { receipts, payments, subscribers, users } = schema;

const cashierRoles = ['OWNER', 'ADMINISTRATOR', 'CASHIER'];

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const createReceiptSchema = z.object({
  paymentId: z.number().int().positive(),
  receiptNumber: z.string().trim().min(1).max(40).optional(),
});

const receiptQuerySchema = z.object({
  paymentId: z.coerce.number().int().positive().optional(),
  subscriberId: z.coerce.number().int().positive().optional(),
  status: z.enum(['ACTIVE', 'VOID']).optional(),
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

const receiptFields = {
  id: receipts.id,
  receiptNumber: receipts.receiptNumber,
  paymentId: receipts.paymentId,
  issuedAt: receipts.issuedAt,
  status: receipts.status,
  voidReason: receipts.voidReason,
  voidedBy: receipts.voidedBy,
  voidedAt: receipts.voidedAt,
  paymentNumber: payments.paymentNumber,
  paymentDate: payments.paymentDate,
  paymentAmount: payments.amount,
  paymentMethod: payments.paymentMethod,
  paymentReferenceNumber: payments.referenceNumber,
  paymentStatus: payments.status,
  subscriberId: subscribers.id,
  subscriberAccountNumber: subscribers.accountNumber,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  receivedByName: users.fullName,
};

export const receiptRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/receipts', async (request, reply) => {
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

    const parsedQuery = receiptQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid receipt filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const filters = parsedQuery.data;
    const conditions: SQL[] = [];

    if (filters.paymentId !== undefined) {
      conditions.push(eq(receipts.paymentId, filters.paymentId));
    }
    if (filters.subscriberId !== undefined) {
      conditions.push(eq(payments.subscriberId, filters.subscriberId));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(receipts.status, filters.status));
    }
    if (filters.startDate !== undefined) {
      conditions.push(gte(receipts.issuedAt, new Date(filters.startDate)));
    }
    if (filters.endDate !== undefined) {
      conditions.push(lte(receipts.issuedAt, new Date(filters.endDate)));
    }

    const baseQuery = db
      .select(receiptFields)
      .from(receipts)
      .innerJoin(payments, eq(receipts.paymentId, payments.id))
      .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
      .innerJoin(users, eq(payments.receivedBy, users.id));

    const items = conditions.length > 0
      ? await baseQuery
        .where(and(...conditions))
        .orderBy(desc(receipts.issuedAt), desc(receipts.id))
      : await baseQuery.orderBy(desc(receipts.issuedAt), desc(receipts.id));

    return reply.send({
      success: true,
      message: 'Receipts loaded.',
      data: items,
    });
  });

  fastify.get('/api/v1/receipts/:id', async (request, reply) => {
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

    const parsedParams = idParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid receipt ID.',
        data: null,
      });
    }

    const [receipt] = await db
      .select(receiptFields)
      .from(receipts)
      .innerJoin(payments, eq(receipts.paymentId, payments.id))
      .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
      .innerJoin(users, eq(payments.receivedBy, users.id))
      .where(eq(receipts.id, parsedParams.data.id))
      .limit(1);

    if (!receipt) {
      return reply.code(404).send({
        success: false,
        message: 'Receipt not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Receipt loaded.',
      data: receipt,
    });
  });

  fastify.post('/api/v1/receipts', async (request, reply) => {
    const session = requireRole(request, cashierRoles);

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
        message: 'You do not have permission to create receipts.',
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

    const parsedBody = createReceiptSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid receipt data is required.',
        data: parsedBody.error.flatten(),
      });
    }

    const receiptNumber = parsedBody.data.receiptNumber
      ?? `RCT-${randomUUID().replaceAll('-', '')}`;

    try {
      const result = await db.transaction(async (transaction) => {
        const [payment] = await transaction
          .select({
            id: payments.id,
            status: payments.status,
          })
          .from(payments)
          .where(eq(payments.id, parsedBody.data.paymentId))
          .for('update')
          .limit(1);

        if (!payment) {
          return { type: 'payment_not_found' as const };
        }

        if (payment.status !== 'POSTED') {
          return { type: 'payment_not_receiptable' as const };
        }

        const [existingReceipt] = await transaction
          .select({ id: receipts.id })
          .from(receipts)
          .where(and(
            eq(receipts.paymentId, payment.id),
            eq(receipts.status, 'ACTIVE'),
          ))
          .limit(1);

        if (existingReceipt) {
          return { type: 'receipt_exists' as const };
        }

        const [created] = await transaction
          .insert(receipts)
          .values({
            receiptNumber,
            paymentId: payment.id,
            status: 'ACTIVE',
          })
          .returning();

        return { type: 'created' as const, receipt: created };
      });

      if (result.type === 'payment_not_found') {
        return reply.code(404).send({
          success: false,
          message: 'Payment not found.',
          data: null,
        });
      }

      if (result.type === 'payment_not_receiptable') {
        return reply.code(409).send({
          success: false,
          message: 'Only posted, non-reversed payments can receive a receipt.',
          data: null,
        });
      }

      if (result.type === 'receipt_exists') {
        return reply.code(409).send({
          success: false,
          message: 'An active receipt already exists for this payment.',
          data: null,
        });
      }

      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'receipts',
        entityId: result.receipt?.id,
        newValues: result.receipt,
        ipAddress: request.ip,
      });

      return reply.code(201).send({
        success: true,
        message: 'Receipt created successfully.',
        data: result.receipt ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          success: false,
          message: 'Receipt number already exists and cannot be reused.',
          data: null,
        });
      }

      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === '23503'
      ) {
        return reply.code(404).send({
          success: false,
          message: 'Payment not found.',
          data: null,
        });
      }

      throw error;
    }
  });
};

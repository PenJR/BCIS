import { FastifyPluginAsync } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  invoices,
  serviceAccounts,
  subscribers,
  billingCycles,
  paymentAllocations,
  payments,
} = schema;

const paidAmountExpression = sql<string>`COALESCE((
  SELECT SUM(${paymentAllocations.amount})
  FROM ${paymentAllocations}
  INNER JOIN ${payments} ON ${paymentAllocations.paymentId} = ${payments.id}
  WHERE ${paymentAllocations.invoiceId} = ${invoices.id}
    AND ${payments.status} = 'POSTED'
), 0)::numeric`;

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, {
  message: 'Enter a non-negative amount with up to two decimal places.',
});

const createSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(40),
  serviceAccountId: z.number().int().positive(),
  billingCycleId: z.number().int().positive(),
  invoiceDate: z.iso.date(),
  dueDate: z.iso.date(),
  subtotal: moneySchema,
  discountAmount: moneySchema.default('0'),
  penaltyAmount: moneySchema.default('0'),
  totalAmount: moneySchema,
  status: z.literal('DRAFT').default('DRAFT'),
});

const updateSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(40).optional(),
  serviceAccountId: z.number().int().positive().optional(),
  billingCycleId: z.number().int().positive().optional(),
  invoiceDate: z.iso.date().optional(),
  dueDate: z.iso.date().optional(),
  subtotal: moneySchema.optional(),
  discountAmount: moneySchema.optional(),
  penaltyAmount: moneySchema.optional(),
  totalAmount: moneySchema.optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required.',
});

const writeRoles = ['OWNER', 'ADMINISTRATOR'];

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function invoiceSelectFields() {
  return {
    id: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
    serviceAccountId: invoices.serviceAccountId,
    billingCycleId: invoices.billingCycleId,
    invoiceDate: invoices.invoiceDate,
    dueDate: invoices.dueDate,
    subtotal: invoices.subtotal,
    discountAmount: invoices.discountAmount,
    penaltyAmount: invoices.penaltyAmount,
    totalAmount: invoices.totalAmount,
    amountPaid: paidAmountExpression,
    balance: sql<string>`${invoices.totalAmount} - (${paidAmountExpression})`,
    status: invoices.status,
    finalizedAt: invoices.finalizedAt,
    createdAt: invoices.createdAt,
    updatedAt: invoices.updatedAt,
    serviceAccountNumber: serviceAccounts.serviceAccountNumber,
    subscriberAccountNumber: subscribers.accountNumber,
    subscriberFirstName: subscribers.firstName,
    subscriberLastName: subscribers.lastName,
    cycleCode: billingCycles.cycleCode,
    cyclePeriodStart: billingCycles.periodStart,
    cyclePeriodEnd: billingCycles.periodEnd,
  };
}

export const invoiceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/invoices', async (request, reply) => {
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

    const items = await db
      .select(invoiceSelectFields())
      .from(invoices)
      .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .innerJoin(billingCycles, eq(invoices.billingCycleId, billingCycles.id))
      .orderBy(desc(invoices.createdAt));

    return reply.send({
      success: true,
      message: 'Invoices loaded.',
      data: items,
    });
  });

  fastify.get('/api/v1/invoices/:id', async (request, reply) => {
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

    const parsedParams = paramsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice ID.',
        data: null,
      });
    }

    const [item] = await db
      .select(invoiceSelectFields())
      .from(invoices)
      .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .innerJoin(billingCycles, eq(invoices.billingCycleId, billingCycles.id))
      .where(eq(invoices.id, parsedParams.data.id))
      .limit(1);

    if (!item) {
      return reply.code(404).send({
        success: false,
        message: 'Invoice not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Invoice loaded.',
      data: item,
    });
  });

  fastify.post('/api/v1/invoices', async (request, reply) => {
    const session = requireRole(request, writeRoles);

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
        message: 'You do not have permission to create invoices.',
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

    const parsedBody = createSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid draft invoice data is required.',
        data: parsedBody.error.flatten(),
      });
    }

    const [serviceAccount] = await db
      .select({ id: serviceAccounts.id })
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, parsedBody.data.serviceAccountId))
      .limit(1);

    if (!serviceAccount) {
      return reply.code(404).send({
        success: false,
        message: 'Service account not found.',
        data: null,
      });
    }

    const [billingCycle] = await db
      .select({ id: billingCycles.id })
      .from(billingCycles)
      .where(eq(billingCycles.id, parsedBody.data.billingCycleId))
      .limit(1);

    if (!billingCycle) {
      return reply.code(404).send({
        success: false,
        message: 'Billing cycle not found.',
        data: null,
      });
    }

    try {
      const [created] = await db
        .insert(invoices)
        .values(parsedBody.data)
        .returning();

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'invoices',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Draft invoice created successfully.',
        data: created ?? null,
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        return reply.code(409).send({
          success: false,
          message: 'Invoice number or service account and billing cycle combination already exists.',
          data: null,
        });
      }

      if (isPostgresError(error, '23503')) {
        return reply.code(404).send({
          success: false,
          message: 'Service account or billing cycle not found.',
          data: null,
        });
      }

      throw error;
    }
  });

  fastify.put('/api/v1/invoices/:id', async (request, reply) => {
    const session = requireRole(request, writeRoles);

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
        message: 'You do not have permission to update invoices.',
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
    const parsedBody = updateSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice ID or update data.',
        data: null,
      });
    }

    const [existing] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, parsedParams.data.id))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({
        success: false,
        message: 'Invoice not found.',
        data: null,
      });
    }

    if (existing.status !== 'DRAFT' || existing.finalizedAt !== null) {
      return reply.code(409).send({
        success: false,
        message: 'Only draft invoices can be updated.',
        data: null,
      });
    }

    const serviceAccountId = parsedBody.data.serviceAccountId ?? existing.serviceAccountId;
    const billingCycleId = parsedBody.data.billingCycleId ?? existing.billingCycleId;

    const [serviceAccount] = await db
      .select({ id: serviceAccounts.id })
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, serviceAccountId))
      .limit(1);

    if (!serviceAccount) {
      return reply.code(404).send({
        success: false,
        message: 'Service account not found.',
        data: null,
      });
    }

    const [billingCycle] = await db
      .select({ id: billingCycles.id })
      .from(billingCycles)
      .where(eq(billingCycles.id, billingCycleId))
      .limit(1);

    if (!billingCycle) {
      return reply.code(404).send({
        success: false,
        message: 'Billing cycle not found.',
        data: null,
      });
    }

    try {
      const [updated] = await db
        .update(invoices)
        .set({
          ...parsedBody.data,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, parsedParams.data.id))
        .returning();

      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'invoices',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }

      return reply.send({
        success: true,
        message: 'Draft invoice updated successfully.',
        data: updated ?? null,
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        return reply.code(409).send({
          success: false,
          message: 'Invoice number or service account and billing cycle combination already exists.',
          data: null,
        });
      }

      if (isPostgresError(error, '23503')) {
        return reply.code(404).send({
          success: false,
          message: 'Service account or billing cycle not found.',
          data: null,
        });
      }

      throw error;
    }
  });
};

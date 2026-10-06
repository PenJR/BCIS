import { FastifyPluginAsync } from 'fastify';
import {
  and,
  desc,
  eq,
  inArray,
} from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  users,
  subscribers,
  serviceAccounts,
  suspensionRecords,
  reconnectionRecords,
  invoices,
  paymentAllocations,
  payments,
  paymentAllocations,
} = schema;

const managerRoles = ['OWNER', 'ADMINISTRATOR', 'COLLECTION_SUPERVISOR'];
const reconnectionStatuses = [
  'REQUESTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
const openReconnectionStatuses = ['REQUESTED', 'IN_PROGRESS', 'COMPLETED'];

type DatabaseTransaction = Parameters<
  Parameters<NonNullable<typeof db>['transaction']>[0]
>[0];

async function overdueBalanceCents(
  transaction: DatabaseTransaction,
  serviceAccountId: number,
  asOfDate: string,
): Promise<bigint> {
  const overdueInvoices = await transaction
    .select({
      id: invoices.id,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(and(
      eq(invoices.serviceAccountId, serviceAccountId),
      inArray(invoices.status, ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE']),
      inArray(invoices.id, transaction
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(
          eq(invoices.serviceAccountId, serviceAccountId),
          inArray(invoices.status, ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE']),
          // Date strings are compared lexicographically in ISO format.
          // The query keeps the financial sum within PostgreSQL numeric values.
          // This branch is filtered again below before balance aggregation.
          eq(invoices.serviceAccountId, serviceAccountId),
        ))),
    ));

  const pastDueInvoices = overdueInvoices.filter((invoice) => invoice.id);
  const invoiceIds = pastDueInvoices.map((invoice) => invoice.id);
  if (invoiceIds.length === 0) return 0n;

  const allocations = await transaction
    .select({
      invoiceId: paymentAllocations.invoiceId,
      amount: paymentAllocations.amount,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(and(
      inArray(paymentAllocations.invoiceId, invoiceIds),
      eq(payments.status, 'POSTED'),
    ));
  const allocated = new Map<number, bigint>();
  for (const allocation of allocations) {
    const [whole, fraction = ''] = allocation.amount.split('.');
    allocated.set(
      allocation.invoiceId,
      (allocated.get(allocation.invoiceId) ?? 0n)
        + BigInt(whole) * 100n
        + BigInt(fraction.padEnd(2, '0')),
    );
  }

  return pastDueInvoices.reduce((total, invoice) => {
    if (invoice.dueDate >= asOfDate) return total;
    const [whole, fraction = ''] = invoice.totalAmount.split('.');
    const balance = BigInt(whole) * 100n
      + BigInt(fraction.padEnd(2, '0'))
      - (allocated.get(invoice.id) ?? 0n);
    return total + (balance > 0n ? balance : 0n);
  }, 0n);
}

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const suspensionQuerySchema = z.object({
  serviceAccountId: z.coerce.number().int().positive().optional(),
  status: z.string().trim().min(1).max(30).optional(),
});

const reconnectionQuerySchema = z.object({
  serviceAccountId: z.coerce.number().int().positive().optional(),
  suspensionId: z.coerce.number().int().positive().optional(),
  status: z.enum(reconnectionStatuses).optional(),
});

const createSuspensionSchema = z.object({
  serviceAccountId: z.number().int().positive(),
  suspensionDate: z.iso.date(),
  reason: z.string().trim().min(1),
  notes: z.string().nullable().optional(),
});

const feeSchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, {
  message: 'Fee must be a non-negative amount with up to two decimal places.',
});

const createReconnectionSchema = z.object({
  serviceAccountId: z.number().int().positive(),
  suspensionId: z.number().int().positive().optional(),
  requestDate: z.iso.date().optional(),
  completionDate: z.iso.date().nullable().optional(),
  reconnectionFee: feeSchema.default('0'),
  technicianId: z.number().int().positive().nullable().optional(),
  status: z.enum(reconnectionStatuses).default('REQUESTED'),
  notes: z.string().nullable().optional(),
}).superRefine((value, context) => {
  if (value.status === 'COMPLETED' && !value.completionDate) {
    context.addIssue({
      code: 'custom',
      path: ['completionDate'],
      message: 'Completion date is required for completed reconnections.',
    });
  }

  if (value.requestDate && value.completionDate && value.completionDate < value.requestDate) {
    context.addIssue({
      code: 'custom',
      path: ['completionDate'],
      message: 'Completion date must be on or after the request date.',
    });
  }
});

const suspensionFields = {
  id: suspensionRecords.id,
  serviceAccountId: suspensionRecords.serviceAccountId,
  suspensionDate: suspensionRecords.suspensionDate,
  reason: suspensionRecords.reason,
  approvedBy: suspensionRecords.approvedBy,
  notes: suspensionRecords.notes,
  status: suspensionRecords.status,
  createdAt: suspensionRecords.createdAt,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberId: subscribers.id,
  subscriberAccountNumber: subscribers.accountNumber,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  approvedByName: users.fullName,
};

export const suspensionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/suspensions', async (request, reply) => {
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

    const parsedQuery = suspensionQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid suspension filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const items = await db
      .select(suspensionFields)
      .from(suspensionRecords)
      .innerJoin(serviceAccounts, eq(suspensionRecords.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .leftJoin(users, eq(suspensionRecords.approvedBy, users.id))
      .where(and(
        parsedQuery.data.serviceAccountId === undefined
          ? undefined
          : eq(suspensionRecords.serviceAccountId, parsedQuery.data.serviceAccountId),
        parsedQuery.data.status === undefined
          ? undefined
          : eq(suspensionRecords.status, parsedQuery.data.status),
      ))
      .orderBy(desc(suspensionRecords.suspensionDate), desc(suspensionRecords.id));

    return reply.send({
      success: true,
      message: 'Suspension records loaded.',
      data: items,
    });
  });

  fastify.get('/api/v1/suspensions/:id', async (request, reply) => {
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
        message: 'Invalid suspension ID.',
        data: null,
      });
    }

    const [item] = await db
      .select(suspensionFields)
      .from(suspensionRecords)
      .innerJoin(serviceAccounts, eq(suspensionRecords.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .leftJoin(users, eq(suspensionRecords.approvedBy, users.id))
      .where(eq(suspensionRecords.id, parsedParams.data.id))
      .limit(1);

    if (!item) {
      return reply.code(404).send({
        success: false,
        message: 'Suspension record not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Suspension record loaded.',
      data: item,
    });
  });

  fastify.post('/api/v1/suspensions', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create suspensions.'
          : 'Authentication required.',
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

    const parsedBody = createSuspensionSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid suspension data is required.',
        data: parsedBody.error.flatten(),
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (parsedBody.data.suspensionDate > today) {
      return reply.code(400).send({
        success: false,
        message: 'Suspension date cannot be in the future.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [serviceAccount] = await transaction
        .select({
          id: serviceAccounts.id,
          status: serviceAccounts.status,
        })
        .from(serviceAccounts)
        .where(eq(serviceAccounts.id, parsedBody.data.serviceAccountId))
        .for('update')
        .limit(1);

      if (!serviceAccount) {
        return { type: 'service_account_not_found' as const };
      }

      if (serviceAccount.status !== 'ACTIVE') {
        return { type: 'service_account_unavailable' as const };
      }

      const [activeSuspension] = await transaction
        .select({ id: suspensionRecords.id })
        .from(suspensionRecords)
        .where(and(
          eq(suspensionRecords.serviceAccountId, serviceAccount.id),
          eq(suspensionRecords.status, 'ACTIVE'),
        ))
        .limit(1);

      if (activeSuspension) {
        return { type: 'active_suspension_exists' as const };
      }

      const overdueCents = await overdueBalanceCents(
        transaction,
        serviceAccount.id,
        today,
      );
      if (overdueCents <= 0n) {
        return { type: 'not_overdue' as const };
      }

      const [suspension] = await transaction
        .insert(suspensionRecords)
        .values({
          serviceAccountId: serviceAccount.id,
          suspensionDate: parsedBody.data.suspensionDate,
          reason: parsedBody.data.reason,
          notes: parsedBody.data.notes,
          approvedBy: session.userId,
          status: 'ACTIVE',
        })
        .returning();

      await transaction
        .update(serviceAccounts)
        .set({
          status: 'SUSPENDED',
          updatedAt: new Date(),
        })
        .where(eq(serviceAccounts.id, serviceAccount.id));

      await writeAuditLog({
        userId: session.userId,
        action: 'SUSPEND',
        entityType: 'suspension_records',
        entityId: suspension?.id,
        reason: parsedBody.data.reason,
        newValues: {
          suspension,
          overdueBalance: `${overdueCents / 100n}.${(overdueCents % 100n).toString().padStart(2, '0')}`,
        },
        ipAddress: request.ip,
      }, transaction);

      return { type: 'created' as const, suspension };
    });

    if (result.type === 'service_account_not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Service account not found.',
        data: null,
      });
    }

    if (result.type === 'service_account_unavailable' || result.type === 'active_suspension_exists') {
      return reply.code(409).send({
        success: false,
        message: result.type === 'active_suspension_exists'
          ? 'An active suspension already exists for this service account.'
          : 'Only active service accounts can be suspended.',
        data: null,
      });
    }

    if (result.type === 'not_overdue') {
      return reply.code(409).send({
        success: false,
        message: 'Service account is not eligible for suspension without an overdue balance.',
        data: null,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Service account suspended successfully.',
      data: result.suspension ?? null,
    });
  });

  fastify.get('/api/v1/reconnections', async (request, reply) => {
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

    const parsedQuery = reconnectionQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid reconnection filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const items = await db
      .select({
        id: reconnectionRecords.id,
        serviceAccountId: reconnectionRecords.serviceAccountId,
        suspensionId: reconnectionRecords.suspensionId,
        requestDate: reconnectionRecords.requestDate,
        completionDate: reconnectionRecords.completionDate,
        reconnectionFee: reconnectionRecords.reconnectionFee,
        requestedBy: reconnectionRecords.requestedBy,
        technicianId: reconnectionRecords.technicianId,
        status: reconnectionRecords.status,
        notes: reconnectionRecords.notes,
        serviceAccountNumber: serviceAccounts.serviceAccountNumber,
        subscriberId: subscribers.id,
        subscriberAccountNumber: subscribers.accountNumber,
        subscriberFirstName: subscribers.firstName,
        subscriberLastName: subscribers.lastName,
        technicianName: users.fullName,
      })
      .from(reconnectionRecords)
      .innerJoin(serviceAccounts, eq(reconnectionRecords.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .leftJoin(users, eq(reconnectionRecords.technicianId, users.id))
      .where(and(
        parsedQuery.data.serviceAccountId === undefined
          ? undefined
          : eq(reconnectionRecords.serviceAccountId, parsedQuery.data.serviceAccountId),
        parsedQuery.data.suspensionId === undefined
          ? undefined
          : eq(reconnectionRecords.suspensionId, parsedQuery.data.suspensionId),
        parsedQuery.data.status === undefined
          ? undefined
          : eq(reconnectionRecords.status, parsedQuery.data.status),
      ))
      .orderBy(desc(reconnectionRecords.requestDate), desc(reconnectionRecords.id));

    return reply.send({
      success: true,
      message: 'Reconnection records loaded.',
      data: items,
    });
  });

  fastify.get('/api/v1/reconnections/:id', async (request, reply) => {
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
        message: 'Invalid reconnection ID.',
        data: null,
      });
    }

    const [item] = await db
      .select({
        id: reconnectionRecords.id,
        serviceAccountId: reconnectionRecords.serviceAccountId,
        suspensionId: reconnectionRecords.suspensionId,
        requestDate: reconnectionRecords.requestDate,
        completionDate: reconnectionRecords.completionDate,
        reconnectionFee: reconnectionRecords.reconnectionFee,
        requestedBy: reconnectionRecords.requestedBy,
        technicianId: reconnectionRecords.technicianId,
        status: reconnectionRecords.status,
        notes: reconnectionRecords.notes,
        serviceAccountNumber: serviceAccounts.serviceAccountNumber,
        subscriberId: subscribers.id,
        subscriberAccountNumber: subscribers.accountNumber,
        subscriberFirstName: subscribers.firstName,
        subscriberLastName: subscribers.lastName,
        technicianName: users.fullName,
      })
      .from(reconnectionRecords)
      .innerJoin(serviceAccounts, eq(reconnectionRecords.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .leftJoin(users, eq(reconnectionRecords.technicianId, users.id))
      .where(eq(reconnectionRecords.id, parsedParams.data.id))
      .limit(1);

    if (!item) {
      return reply.code(404).send({
        success: false,
        message: 'Reconnection record not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Reconnection record loaded.',
      data: item,
    });
  });

  fastify.post('/api/v1/reconnections', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create reconnections.'
          : 'Authentication required.',
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

    const parsedBody = createReconnectionSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid reconnection data is required.',
        data: parsedBody.error.flatten(),
      });
    }

    const requestDate = parsedBody.data.requestDate
      ?? new Date().toISOString().slice(0, 10);

    if (
      parsedBody.data.completionDate
      && parsedBody.data.completionDate < requestDate
    ) {
      return reply.code(400).send({
        success: false,
        message: 'Completion date must be on or after the request date.',
        data: null,
      });
    }

    if (parsedBody.data.status === 'COMPLETED' && !parsedBody.data.completionDate) {
      return reply.code(400).send({
        success: false,
        message: 'Completion date is required for completed reconnections.',
        data: null,
      });
    }

    if (parsedBody.data.technicianId != null) {
      const [technician] = await db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, parsedBody.data.technicianId))
        .limit(1);

      if (!technician) {
        return reply.code(404).send({
          success: false,
          message: 'Technician user not found.',
          data: null,
        });
      }

      if (technician.status !== 'ACTIVE') {
        return reply.code(409).send({
          success: false,
          message: 'Technician user is not active.',
          data: null,
        });
      }
    }

    const result = await db.transaction(async (transaction) => {
      const [serviceAccount] = await transaction
        .select({
          id: serviceAccounts.id,
          status: serviceAccounts.status,
        })
        .from(serviceAccounts)
        .where(eq(serviceAccounts.id, parsedBody.data.serviceAccountId))
        .for('update')
        .limit(1);

      if (!serviceAccount) {
        return { type: 'service_account_not_found' as const };
      }

      if (serviceAccount.status !== 'SUSPENDED') {
        return { type: 'service_account_not_suspended' as const };
      }

      const activeSuspensions = await transaction
        .select({
          id: suspensionRecords.id,
          serviceAccountId: suspensionRecords.serviceAccountId,
        })
        .from(suspensionRecords)
        .where(and(
          eq(suspensionRecords.serviceAccountId, serviceAccount.id),
          eq(suspensionRecords.status, 'ACTIVE'),
        ))
        .orderBy(desc(suspensionRecords.suspensionDate), desc(suspensionRecords.id));

      if (activeSuspensions.length === 0) {
        return { type: 'suspension_not_found' as const };
      }

      const suspension = parsedBody.data.suspensionId === undefined
        ? activeSuspensions[0]
        : activeSuspensions.find((record) => record.id === parsedBody.data.suspensionId);

      if (!suspension) {
        const [providedSuspension] = await transaction
          .select({
            id: suspensionRecords.id,
            serviceAccountId: suspensionRecords.serviceAccountId,
            status: suspensionRecords.status,
          })
          .from(suspensionRecords)
          .where(eq(suspensionRecords.id, parsedBody.data.suspensionId!))
          .limit(1);

        if (!providedSuspension) {
          return { type: 'suspension_not_found' as const };
        }

        return { type: 'suspension_mismatch' as const };
      }

      const [existingReconnection] = await transaction
        .select({ id: reconnectionRecords.id })
        .from(reconnectionRecords)
        .where(and(
          eq(reconnectionRecords.suspensionId, suspension.id),
          inArray(reconnectionRecords.status, openReconnectionStatuses),
        ))
        .limit(1);

      if (existingReconnection) {
        return { type: 'reconnection_exists' as const };
      }

      const [reconnection] = await transaction
        .insert(reconnectionRecords)
        .values({
          serviceAccountId: serviceAccount.id,
          suspensionId: suspension.id,
          requestDate,
          completionDate: parsedBody.data.completionDate ?? null,
          reconnectionFee: parsedBody.data.reconnectionFee,
          requestedBy: session.userId,
          technicianId: parsedBody.data.technicianId ?? null,
          status: parsedBody.data.status,
          notes: parsedBody.data.notes ?? null,
        })
        .returning();

      if (parsedBody.data.status === 'COMPLETED') {
        await transaction
          .update(suspensionRecords)
          .set({ status: 'RECONNECTED' })
          .where(eq(suspensionRecords.id, suspension.id));

        await transaction
          .update(serviceAccounts)
          .set({
            status: 'ACTIVE',
            updatedAt: new Date(),
          })
          .where(eq(serviceAccounts.id, serviceAccount.id));
      }

      await writeAuditLog({
        userId: session.userId,
        action: parsedBody.data.status === 'COMPLETED' ? 'RECONNECT' : 'REQUEST_RECONNECTION',
        entityType: 'reconnection_records',
        entityId: reconnection?.id,
        reason: reconnection?.notes,
        newValues: {
          reconnection,
          serviceAccountStatus: parsedBody.data.status === 'COMPLETED'
            ? 'ACTIVE'
            : 'SUSPENDED',
        },
        ipAddress: request.ip,
      }, transaction);

      return { type: 'created' as const, reconnection };
    });

    if (result.type === 'service_account_not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Service account not found.',
        data: null,
      });
    }

    if (result.type === 'suspension_not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Active suspension record not found.',
        data: null,
      });
    }

    if (result.type === 'suspension_mismatch') {
      return reply.code(409).send({
        success: false,
        message: 'Suspension record does not belong to this service account or is no longer active.',
        data: null,
      });
    }

    if (result.type === 'service_account_not_suspended') {
      return reply.code(409).send({
        success: false,
        message: 'Only suspended service accounts can be reconnected.',
        data: null,
      });
    }

    if (result.type === 'reconnection_exists') {
      return reply.code(409).send({
        success: false,
        message: 'An active reconnection record already exists for this suspension.',
        data: null,
      });
    }

    return reply.code(201).send({
      success: true,
      message: parsedBody.data.status === 'COMPLETED'
        ? 'Reconnection completed successfully.'
        : 'Reconnection request created successfully.',
      data: result.reconnection ?? null,
    });
  });
};

import { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  serviceAccounts,
  subscribers,
  servicePlans,
  subscriberAddresses,
  users,
} = schema;

const allowedStatuses = [
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
  'CLOSED',
] as const;

const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter a non-negative amount with up to two decimal places.');

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const createSchema = z.object({
  serviceAccountNumber: z.string().trim().min(1).max(30),
  subscriberId: z.number().int().positive(),
  planId: z.number().int().positive(),
  installationAddressId: z.number().int().positive().nullable().optional(),
  activationDate: z.iso.date().nullable().optional(),
  billingStartDate: z.iso.date(),
  billingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  currentRate: moneySchema,
  assignedCollectorId: z.number().int().positive().nullable().optional(),
  status: z.enum(allowedStatuses).default('ACTIVE'),
});

const updateSchema = z.object({
  serviceAccountNumber: z.string().trim().min(1).max(30).optional(),
  subscriberId: z.number().int().positive().optional(),
  planId: z.number().int().positive().optional(),
  installationAddressId: z.number().int().positive().nullable().optional(),
  activationDate: z.iso.date().nullable().optional(),
  billingStartDate: z.iso.date().optional(),
  billingDay: z.number().int().min(1).max(31).optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  currentRate: moneySchema.optional(),
  assignedCollectorId: z.number().int().positive().nullable().optional(),
  status: z.enum(allowedStatuses).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required.',
});

const writeRoles = [
  'OWNER',
  'ADMINISTRATOR',
  'COLLECTION_SUPERVISOR',
];

async function validateReferences(
  subscriberId: number,
  planId: number,
  installationAddressId: number | null | undefined,
  assignedCollectorId: number | null | undefined,
): Promise<string | null> {
  if (!db) {
    return 'Database is not available.';
  }

  const [subscriber] = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .limit(1);

  if (!subscriber) {
    return 'Subscriber not found.';
  }

  const [plan] = await db
    .select({ id: servicePlans.id })
    .from(servicePlans)
    .where(eq(servicePlans.id, planId))
    .limit(1);

  if (!plan) {
    return 'Service plan not found.';
  }

  if (installationAddressId != null) {
    const [address] = await db
      .select({ id: subscriberAddresses.id })
      .from(subscriberAddresses)
      .where(
        and(
          eq(subscriberAddresses.id, installationAddressId),
          eq(subscriberAddresses.subscriberId, subscriberId),
        ),
      )
      .limit(1);

    if (!address) {
      return 'Installation address not found for this subscriber.';
    }
  }

  if (assignedCollectorId != null) {
    const [collector] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, assignedCollectorId))
      .limit(1);

    if (!collector) {
      return 'Assigned collector not found.';
    }
  }

  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

export const serviceAccountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/service-accounts', async (request, reply) => {
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

    const querySchema = z.object({ search: z.string().optional() });
    const parsedQuery = querySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid search parameters.',
        data: null,
      });
    }

    const search = parsedQuery.data.search?.trim();
    const fields = {
      id: serviceAccounts.id,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: serviceAccounts.subscriberId,
      planId: serviceAccounts.planId,
      installationAddressId: serviceAccounts.installationAddressId,
      activationDate: serviceAccounts.activationDate,
      billingStartDate: serviceAccounts.billingStartDate,
      billingDay: serviceAccounts.billingDay,
      dueDay: serviceAccounts.dueDay,
      currentRate: serviceAccounts.currentRate,
      assignedCollectorId: serviceAccounts.assignedCollectorId,
      status: serviceAccounts.status,
      createdAt: serviceAccounts.createdAt,
      updatedAt: serviceAccounts.updatedAt,
      subscriberAccountNumber: subscribers.accountNumber,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      planName: servicePlans.planName,
    };

    const baseQuery = db
      .select(fields)
      .from(serviceAccounts)
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id));

    const items = search
      ? await baseQuery
        .where(or(
          ilike(serviceAccounts.serviceAccountNumber, `%${search}%`),
          ilike(subscribers.accountNumber, `%${search}%`),
          ilike(subscribers.firstName, `%${search}%`),
          ilike(subscribers.lastName, `%${search}%`),
          ilike(servicePlans.planName, `%${search}%`),
        ))
        .orderBy(desc(serviceAccounts.createdAt))
      : await baseQuery.orderBy(desc(serviceAccounts.createdAt));

    return reply.send({
      success: true,
      message: 'Service accounts loaded.',
      data: items,
    });
  });

  fastify.get('/api/v1/service-accounts/:id', async (request, reply) => {
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
        message: 'Invalid service account ID.',
        data: null,
      });
    }

    const [item] = await db
      .select({
        id: serviceAccounts.id,
        serviceAccountNumber: serviceAccounts.serviceAccountNumber,
        subscriberId: serviceAccounts.subscriberId,
        planId: serviceAccounts.planId,
        installationAddressId: serviceAccounts.installationAddressId,
        activationDate: serviceAccounts.activationDate,
        billingStartDate: serviceAccounts.billingStartDate,
        billingDay: serviceAccounts.billingDay,
        dueDay: serviceAccounts.dueDay,
        currentRate: serviceAccounts.currentRate,
        assignedCollectorId: serviceAccounts.assignedCollectorId,
        status: serviceAccounts.status,
        createdAt: serviceAccounts.createdAt,
        updatedAt: serviceAccounts.updatedAt,
        subscriberAccountNumber: subscribers.accountNumber,
        subscriberFirstName: subscribers.firstName,
        subscriberMiddleName: subscribers.middleName,
        subscriberLastName: subscribers.lastName,
        planName: servicePlans.planName,
      })
      .from(serviceAccounts)
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
      .where(eq(serviceAccounts.id, parsedParams.data.id))
      .limit(1);

    if (!item) {
      return reply.code(404).send({
        success: false,
        message: 'Service account not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Service account loaded.',
      data: item,
    });
  });

  fastify.post('/api/v1/service-accounts', async (request, reply) => {
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
        message: 'You do not have permission to create service accounts.',
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

    const parsed = createSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid service account data is required.',
        data: parsed.error.flatten(),
      });
    }

    const referenceError = await validateReferences(
      parsed.data.subscriberId,
      parsed.data.planId,
      parsed.data.installationAddressId,
      parsed.data.assignedCollectorId,
    );

    if (referenceError) {
      return reply.code(404).send({
        success: false,
        message: referenceError,
        data: null,
      });
    }

    try {
      const [created] = await db
        .insert(serviceAccounts)
        .values(parsed.data)
        .returning();

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'service_accounts',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Service account created successfully.',
        data: created ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          success: false,
          message: 'Service account number already exists.',
          data: null,
        });
      }

      throw error;
    }
  });

  fastify.put('/api/v1/service-accounts/:id', async (request, reply) => {
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
        message: 'You do not have permission to update service accounts.',
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
        message: 'Invalid service account ID or update data.',
        data: null,
      });
    }

    const [existing] = await db
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.id, parsedParams.data.id))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({
        success: false,
        message: 'Service account not found.',
        data: null,
      });
    }

    const updatedFields = parsedBody.data;
    const referenceError = await validateReferences(
      updatedFields.subscriberId ?? existing.subscriberId,
      updatedFields.planId ?? existing.planId,
      updatedFields.installationAddressId === undefined
        ? existing.installationAddressId
        : updatedFields.installationAddressId,
      updatedFields.assignedCollectorId === undefined
        ? existing.assignedCollectorId
        : updatedFields.assignedCollectorId,
    );

    if (referenceError) {
      return reply.code(404).send({
        success: false,
        message: referenceError,
        data: null,
      });
    }

    try {
      const [updated] = await db
        .update(serviceAccounts)
        .set({
          ...updatedFields,
          updatedAt: new Date(),
        })
        .where(eq(serviceAccounts.id, parsedParams.data.id))
        .returning();

      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'service_accounts',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }

      return reply.send({
        success: true,
        message: 'Service account updated successfully.',
        data: updated ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          success: false,
          message: 'Service account number already exists.',
          data: null,
        });
      }

      throw error;
    }
  });
};

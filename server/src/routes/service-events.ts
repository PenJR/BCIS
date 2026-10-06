import { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const { serviceEvents, serviceAccounts, subscribers, users } = schema;

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const querySchema = z.object({
  serviceAccountId: z.coerce.number().int().positive().optional(),
});

const createSchema = z.object({
  serviceAccountId: z.number().int().positive(),
  eventType: z.string().trim().min(1).max(50),
  eventDate: z.iso.datetime().optional(),
  description: z.string().nullable().optional(),
});

const createRoles = [
  'OWNER',
  'ADMINISTRATOR',
  'COLLECTION_SUPERVISOR',
];

const eventFields = {
  id: serviceEvents.id,
  serviceAccountId: serviceEvents.serviceAccountId,
  eventType: serviceEvents.eventType,
  eventDate: serviceEvents.eventDate,
  description: serviceEvents.description,
  actorId: serviceEvents.actorId,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberAccountNumber: subscribers.accountNumber,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  actorName: users.fullName,
};

export const serviceEventRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/service-events', async (request, reply) => {
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

    const parsedQuery = querySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid service event search parameters.',
        data: null,
      });
    }

    const baseQuery = db
      .select(eventFields)
      .from(serviceEvents)
      .innerJoin(
        serviceAccounts,
        eq(serviceEvents.serviceAccountId, serviceAccounts.id),
      )
      .innerJoin(
        subscribers,
        eq(serviceAccounts.subscriberId, subscribers.id),
      )
      .leftJoin(users, eq(serviceEvents.actorId, users.id));

    const events = parsedQuery.data.serviceAccountId
      ? await baseQuery
        .where(eq(serviceEvents.serviceAccountId, parsedQuery.data.serviceAccountId))
        .orderBy(desc(serviceEvents.eventDate))
      : await baseQuery.orderBy(desc(serviceEvents.eventDate));

    return reply.send({
      success: true,
      message: 'Service events loaded.',
      data: events,
    });
  });

  fastify.get('/api/v1/service-events/:id', async (request, reply) => {
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
        message: 'Invalid service event ID.',
        data: null,
      });
    }

    const [event] = await db
      .select(eventFields)
      .from(serviceEvents)
      .innerJoin(
        serviceAccounts,
        eq(serviceEvents.serviceAccountId, serviceAccounts.id),
      )
      .innerJoin(
        subscribers,
        eq(serviceAccounts.subscriberId, subscribers.id),
      )
      .leftJoin(users, eq(serviceEvents.actorId, users.id))
      .where(eq(serviceEvents.id, parsedParams.data.id))
      .limit(1);

    if (!event) {
      return reply.code(404).send({
        success: false,
        message: 'Service event not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Service event loaded.',
      data: event,
    });
  });

  fastify.post('/api/v1/service-events', async (request, reply) => {
    const session = requireRole(request, createRoles);

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
        message: 'You do not have permission to create service events.',
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
        message: 'Valid service event data is required.',
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

    const [created] = await db
      .insert(serviceEvents)
      .values({
        serviceAccountId: parsedBody.data.serviceAccountId,
        eventType: parsedBody.data.eventType,
        eventDate: parsedBody.data.eventDate
          ? new Date(parsedBody.data.eventDate)
          : undefined,
        description: parsedBody.data.description,
        actorId: session.userId,
      })
      .returning();

    if (created) {
      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'service_events',
        entityId: created.id,
        newValues: created,
        ipAddress: request.ip,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Service event created successfully.',
      data: created ?? null,
    });
  });
};

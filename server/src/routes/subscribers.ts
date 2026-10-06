import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, eq, ilike, or, desc } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { db } from '../lib/db';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';

const {
  subscribers,
  subscriberAddresses,
  subscriberContacts,
  collectionAreas,
  users,
} = schema;

export const subscriberRoutes: FastifyPluginAsync = async (fastify) => {
  // ============================================================
  // LIST SUBSCRIBERS
  // ============================================================
  fastify.get('/api/v1/subscribers', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const querySchema = z.object({
      search: z.string().optional(),
    });

    const parsed = querySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid search parameters.',
      });
    }

    const search = parsed.data.search?.trim();

    let items;

    if (search) {
      items = await db
        .select({
          id: subscribers.id,
          accountNumber: subscribers.accountNumber,
          firstName: subscribers.firstName,
          middleName: subscribers.middleName,
          lastName: subscribers.lastName,
          contactNumber: subscribers.contactNumber,
          email: subscribers.email,
          collectionAreaId: subscribers.collectionAreaId,
          assignedCollectorId: subscribers.assignedCollectorId,
          billingDay: subscribers.billingDay,
          dueDay: subscribers.dueDay,
          status: subscribers.status,
          notes: subscribers.notes,
          createdAt: subscribers.createdAt,
          updatedAt: subscribers.updatedAt,
          collectionAreaName: collectionAreas.areaName,
        })
        .from(subscribers)
        .leftJoin(
          collectionAreas,
          eq(subscribers.collectionAreaId, collectionAreas.id),
        )
        .where(
          or(
            ilike(subscribers.accountNumber, `%${search}%`),
            ilike(subscribers.firstName, `%${search}%`),
            ilike(subscribers.lastName, `%${search}%`),
            ilike(subscribers.contactNumber, `%${search}%`),
          ),
        )
        .orderBy(desc(subscribers.createdAt));
    } else {
      items = await db
        .select({
          id: subscribers.id,
          accountNumber: subscribers.accountNumber,
          firstName: subscribers.firstName,
          middleName: subscribers.middleName,
          lastName: subscribers.lastName,
          contactNumber: subscribers.contactNumber,
          email: subscribers.email,
          collectionAreaId: subscribers.collectionAreaId,
          assignedCollectorId: subscribers.assignedCollectorId,
          billingDay: subscribers.billingDay,
          dueDay: subscribers.dueDay,
          status: subscribers.status,
          notes: subscribers.notes,
          createdAt: subscribers.createdAt,
          updatedAt: subscribers.updatedAt,
          collectionAreaName: collectionAreas.areaName,
        })
        .from(subscribers)
        .leftJoin(
          collectionAreas,
          eq(subscribers.collectionAreaId, collectionAreas.id),
        )
        .orderBy(desc(subscribers.createdAt));
    }

    return reply.send({
      success: true,
      message: 'Subscribers loaded',
      data: items,
    });
  });

  // ============================================================
  // GET SUBSCRIBER
  // ============================================================
  fastify.get('/api/v1/subscribers/:id', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const paramsSchema = z.object({
      id: z.coerce.number().int().positive(),
    });

    const parsed = paramsSchema.safeParse(request.params);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid subscriber ID.',
      });
    }

    const subscriberRows = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, parsed.data.id))
      .limit(1);

    const subscriber = subscriberRows[0];

    if (!subscriber) {
      return reply.code(404).send({
        success: false,
        message: 'Subscriber not found.',
      });
    }

    const addresses = await db
      .select()
      .from(subscriberAddresses)
      .where(eq(subscriberAddresses.subscriberId, subscriber.id));

    const contacts = await db
      .select()
      .from(subscriberContacts)
      .where(eq(subscriberContacts.subscriberId, subscriber.id));

    return reply.send({
      success: true,
      message: 'Subscriber loaded',
      data: {
        ...subscriber,
        addresses,
        contacts,
      },
    });
  });

  // ============================================================
  // CREATE SUBSCRIBER
  // OWNER / ADMINISTRATOR / COLLECTION SUPERVISOR
  // ============================================================
  fastify.post('/api/v1/subscribers', async (request, reply) => {
    const session = requireRole(request, [
      'OWNER',
      'ADMINISTRATOR',
      'COLLECTION_SUPERVISOR',
    ]);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to create subscribers.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const subscriberSchema = z.object({
      accountNumber: z.string().min(2).max(30),
      firstName: z.string().min(1).max(80),
      middleName: z.string().max(80).optional(),
      lastName: z.string().min(1).max(80),
      contactNumber: z.string().max(30).optional(),
      email: z.string().email().max(150).optional(),
      collectionAreaId: z.number().int().positive().optional(),
      assignedCollectorId: z.number().int().positive().optional(),
      billingDay: z.number().int().min(1).max(31).default(1),
      dueDay: z.number().int().min(1).max(31).default(15),
      status: z.string().max(30).default('ACTIVE'),
      notes: z.string().optional(),
    });

    const parsed = subscriberSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid subscriber data is required.',
        errors: parsed.error.flatten(),
      });
    }

    if (parsed.data.collectionAreaId !== undefined) {
      const [area] = await db
        .select({ id: collectionAreas.id, status: collectionAreas.status })
        .from(collectionAreas)
        .where(eq(collectionAreas.id, parsed.data.collectionAreaId))
        .limit(1);
      if (!area) {
        return reply.code(404).send({ success: false, message: 'Collection area not found.', data: null });
      }
      if (area.status !== 'ACTIVE') {
        return reply.code(409).send({ success: false, message: 'Collection area is not active.', data: null });
      }
    }

    if (parsed.data.assignedCollectorId !== undefined) {
      const [collector] = await db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, parsed.data.assignedCollectorId))
        .limit(1);
      if (!collector) {
        return reply.code(404).send({ success: false, message: 'Assigned collector not found.', data: null });
      }
      if (collector.status !== 'ACTIVE') {
        return reply.code(409).send({ success: false, message: 'Assigned collector is not active.', data: null });
      }
    }

    const existing = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.accountNumber, parsed.data.accountNumber))
      .limit(1);

    if (existing[0]) {
      return reply.code(409).send({
        success: false,
        message: 'Account number already exists.',
      });
    }

    const created = await db
      .insert(subscribers)
      .values({
        accountNumber: parsed.data.accountNumber,
        firstName: parsed.data.firstName,
        middleName: parsed.data.middleName,
        lastName: parsed.data.lastName,
        contactNumber: parsed.data.contactNumber,
        email: parsed.data.email,
        collectionAreaId: parsed.data.collectionAreaId,
        assignedCollectorId: parsed.data.assignedCollectorId,
        billingDay: parsed.data.billingDay,
        dueDay: parsed.data.dueDay,
        status: parsed.data.status,
        notes: parsed.data.notes,
      })
      .returning();

    if (created[0]) {
      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'subscribers',
        entityId: created[0].id,
        newValues: created[0],
        ipAddress: request.ip,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Subscriber created successfully.',
      data: created[0] ?? null,
    });
  });

  // ============================================================
  // UPDATE SUBSCRIBER
  // OWNER / ADMINISTRATOR / COLLECTION SUPERVISOR
  // ============================================================
  fastify.put('/api/v1/subscribers/:id', async (request, reply) => {
    const session = requireRole(request, [
      'OWNER',
      'ADMINISTRATOR',
      'COLLECTION_SUPERVISOR',
    ]);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to update subscribers.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const paramsSchema = z.object({
      id: z.coerce.number().int().positive(),
    });

    const parsedParams = paramsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid subscriber ID.',
      });
    }

    const updateSchema = z.object({
      firstName: z.string().min(1).max(80).optional(),
      middleName: z.string().max(80).nullable().optional(),
      lastName: z.string().min(1).max(80).optional(),
      contactNumber: z.string().max(30).nullable().optional(),
      email: z.string().email().max(150).nullable().optional(),
      collectionAreaId: z.number().int().positive().nullable().optional(),
      assignedCollectorId: z.number().int().positive().nullable().optional(),
      billingDay: z.number().int().min(1).max(31).optional(),
      dueDay: z.number().int().min(1).max(31).optional(),
      status: z.string().max(30).optional(),
      notes: z.string().nullable().optional(),
    });

    const parsedBody = updateSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid subscriber data.',
        errors: parsedBody.error.flatten(),
      });
    }

    const existing = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, parsedParams.data.id))
      .limit(1);

    if (!existing[0]) {
      return reply.code(404).send({
        success: false,
        message: 'Subscriber not found.',
      });
    }

    const collectionAreaId = parsedBody.data.collectionAreaId === undefined
      ? existing[0].collectionAreaId
      : parsedBody.data.collectionAreaId;
    if (collectionAreaId !== null && collectionAreaId !== undefined) {
      const [area] = await db
        .select({ id: collectionAreas.id, status: collectionAreas.status })
        .from(collectionAreas)
        .where(eq(collectionAreas.id, collectionAreaId))
        .limit(1);
      if (!area) {
        return reply.code(404).send({ success: false, message: 'Collection area not found.', data: null });
      }
      if (area.status !== 'ACTIVE') {
        return reply.code(409).send({ success: false, message: 'Collection area is not active.', data: null });
      }
    }

    const assignedCollectorId = parsedBody.data.assignedCollectorId === undefined
      ? existing[0].assignedCollectorId
      : parsedBody.data.assignedCollectorId;
    if (assignedCollectorId !== null && assignedCollectorId !== undefined) {
      const [collector] = await db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, assignedCollectorId))
        .limit(1);
      if (!collector) {
        return reply.code(404).send({ success: false, message: 'Assigned collector not found.', data: null });
      }
      if (collector.status !== 'ACTIVE') {
        return reply.code(409).send({ success: false, message: 'Assigned collector is not active.', data: null });
      }
    }

    const updated = await db
      .update(subscribers)
      .set({
        ...parsedBody.data,
        updatedAt: new Date(),
      })
      .where(eq(subscribers.id, parsedParams.data.id))
      .returning();

    if (updated[0]) {
      await writeAuditLog({
        userId: session.userId,
        action: 'UPDATE',
        entityType: 'subscribers',
        entityId: updated[0].id,
        oldValues: existing[0],
        newValues: updated[0],
        ipAddress: request.ip,
      });
    }

    return reply.send({
      success: true,
      message: 'Subscriber updated successfully.',
      data: updated[0] ?? null,
    });
  });

  // ============================================================
  // ADD ADDRESS
  // ============================================================
  fastify.post(
    '/api/v1/subscribers/:id/addresses',
    async (request, reply) => {
      const session = requireRole(request, [
        'OWNER',
        'ADMINISTRATOR',
        'COLLECTION_SUPERVISOR',
      ]);

      if (!session) {
        const authenticatedSession = requireAuth(request);

        if (!authenticatedSession) {
          return reply.code(401).send({
            success: false,
            message: 'Authentication required.',
          });
        }

        return reply.code(403).send({
          success: false,
          message: 'You do not have permission to add addresses.',
        });
      }

      if (!db) {
        return reply.code(503).send({
          success: false,
          message: 'Database is not available.',
        });
      }

      const paramsSchema = z.object({
        id: z.coerce.number().int().positive(),
      });

      const bodySchema = z.object({
        addressType: z.string().max(30).default('SERVICE'),
        addressLine: z.string().min(1).max(255),
        barangay: z.string().max(100).optional(),
        city: z.string().max(100).optional(),
        province: z.string().max(100).optional(),
        isPrimary: z.boolean().default(false),
      });

      const parsedParams = paramsSchema.safeParse(request.params);
      const parsedBody = bodySchema.safeParse(request.body);

      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: 'Valid address data is required.',
        });
      }

      const subscriber = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.id, parsedParams.data.id))
        .limit(1);

      if (!subscriber[0]) {
        return reply.code(404).send({
          success: false,
          message: 'Subscriber not found.',
        });
      }

      if (parsedBody.data.isPrimary) {
        await db
          .update(subscriberAddresses)
          .set({ isPrimary: false })
          .where(
            eq(
              subscriberAddresses.subscriberId,
              parsedParams.data.id,
            ),
          );
      }

      const created = await db
        .insert(subscriberAddresses)
        .values({
          subscriberId: parsedParams.data.id,
          addressType: parsedBody.data.addressType,
          addressLine: parsedBody.data.addressLine,
          barangay: parsedBody.data.barangay,
          city: parsedBody.data.city,
          province: parsedBody.data.province,
          isPrimary: parsedBody.data.isPrimary,
        })
        .returning();

      if (created[0]) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'subscriber_addresses',
          entityId: created[0].id,
          newValues: created[0],
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Subscriber address added successfully.',
        data: created[0] ?? null,
      });
    },
  );

  fastify.put(
    '/api/v1/subscribers/:id/addresses/:addressId',
    async (request, reply) => {
      const session = requireRole(request, [
        'OWNER',
        'ADMINISTRATOR',
        'COLLECTION_SUPERVISOR',
      ]);

      if (!session) {
        const authenticatedSession = requireAuth(request);
        return reply.code(authenticatedSession ? 403 : 401).send({
          success: false,
          message: authenticatedSession
            ? 'You do not have permission to update addresses.'
            : 'Authentication required.',
          data: null,
        });
      }

      if (!db) {
        return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
      }

      const params = z.object({
        id: z.coerce.number().int().positive(),
        addressId: z.coerce.number().int().positive(),
      }).safeParse(request.params);
      const body = z.object({
        addressType: z.string().trim().min(1).max(30).optional(),
        addressLine: z.string().trim().min(1).max(255).optional(),
        barangay: z.string().max(100).nullable().optional(),
        city: z.string().max(100).nullable().optional(),
        province: z.string().max(100).nullable().optional(),
        isPrimary: z.boolean().optional(),
      }).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' })
        .safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({ success: false, message: 'Invalid subscriber/address ID or update data.', data: null });
      }

      const [existing] = await db.select().from(subscriberAddresses).where(and(
        eq(subscriberAddresses.id, params.data.addressId),
        eq(subscriberAddresses.subscriberId, params.data.id),
      )).limit(1);

      if (!existing) {
        return reply.code(404).send({ success: false, message: 'Subscriber address not found.', data: null });
      }

      const updated = await db.transaction(async (transaction) => {
        if (body.data.isPrimary === true) {
          await transaction.update(subscriberAddresses)
            .set({ isPrimary: false })
            .where(eq(subscriberAddresses.subscriberId, params.data.id));
        }

        const [address] = await transaction.update(subscriberAddresses)
          .set(body.data)
          .where(eq(subscriberAddresses.id, existing.id))
          .returning();
        return address;
      });

      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'subscriber_addresses',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }

      return reply.send({ success: true, message: 'Subscriber address updated.', data: updated ?? null });
    },
  );

  // ============================================================
  // ADD CONTACT
  // ============================================================
  fastify.post(
    '/api/v1/subscribers/:id/contacts',
    async (request, reply) => {
      const session = requireRole(request, [
        'OWNER',
        'ADMINISTRATOR',
        'COLLECTION_SUPERVISOR',
      ]);

      if (!session) {
        const authenticatedSession = requireAuth(request);

        if (!authenticatedSession) {
          return reply.code(401).send({
            success: false,
            message: 'Authentication required.',
          });
        }

        return reply.code(403).send({
          success: false,
          message: 'You do not have permission to add contacts.',
        });
      }

      if (!db) {
        return reply.code(503).send({
          success: false,
          message: 'Database is not available.',
        });
      }

      const paramsSchema = z.object({
        id: z.coerce.number().int().positive(),
      });

      const bodySchema = z.object({
        contactType: z.string().min(1).max(30),
        contactValue: z.string().min(1).max(150),
        isPrimary: z.boolean().default(false),
      });

      const parsedParams = paramsSchema.safeParse(request.params);
      const parsedBody = bodySchema.safeParse(request.body);

      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({
          success: false,
          message: 'Valid contact data is required.',
        });
      }

      const subscriber = await db
        .select()
        .from(subscribers)
        .where(eq(subscribers.id, parsedParams.data.id))
        .limit(1);

      if (!subscriber[0]) {
        return reply.code(404).send({
          success: false,
          message: 'Subscriber not found.',
        });
      }

      if (parsedBody.data.isPrimary) {
        await db
          .update(subscriberContacts)
          .set({ isPrimary: false })
          .where(
            eq(
              subscriberContacts.subscriberId,
              parsedParams.data.id,
            ),
          );
      }

      const created = await db
        .insert(subscriberContacts)
        .values({
          subscriberId: parsedParams.data.id,
          contactType: parsedBody.data.contactType,
          contactValue: parsedBody.data.contactValue,
          isPrimary: parsedBody.data.isPrimary,
        })
        .returning();

      if (created[0]) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'subscriber_contacts',
          entityId: created[0].id,
          newValues: created[0],
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Subscriber contact added successfully.',
        data: created[0] ?? null,
      });
    },
  );

  fastify.put(
    '/api/v1/subscribers/:id/contacts/:contactId',
    async (request, reply) => {
      const session = requireRole(request, [
        'OWNER',
        'ADMINISTRATOR',
        'COLLECTION_SUPERVISOR',
      ]);

      if (!session) {
        const authenticatedSession = requireAuth(request);
        return reply.code(authenticatedSession ? 403 : 401).send({
          success: false,
          message: authenticatedSession
            ? 'You do not have permission to update contacts.'
            : 'Authentication required.',
          data: null,
        });
      }

      if (!db) {
        return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
      }

      const params = z.object({
        id: z.coerce.number().int().positive(),
        contactId: z.coerce.number().int().positive(),
      }).safeParse(request.params);
      const body = z.object({
        contactType: z.string().trim().min(1).max(30).optional(),
        contactValue: z.string().trim().min(1).max(150).optional(),
        isPrimary: z.boolean().optional(),
      }).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' })
        .safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({ success: false, message: 'Invalid subscriber/contact ID or update data.', data: null });
      }

      const [existing] = await db.select().from(subscriberContacts).where(and(
        eq(subscriberContacts.id, params.data.contactId),
        eq(subscriberContacts.subscriberId, params.data.id),
      )).limit(1);

      if (!existing) {
        return reply.code(404).send({ success: false, message: 'Subscriber contact not found.', data: null });
      }

      const updated = await db.transaction(async (transaction) => {
        if (body.data.isPrimary === true) {
          await transaction.update(subscriberContacts)
            .set({ isPrimary: false })
            .where(eq(subscriberContacts.subscriberId, params.data.id));
        }

        const [contact] = await transaction.update(subscriberContacts)
          .set(body.data)
          .where(eq(subscriberContacts.id, existing.id))
          .returning();
        return contact;
      });

      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'subscriber_contacts',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }

      return reply.send({ success: true, message: 'Subscriber contact updated.', data: updated ?? null });
    },
  );
};
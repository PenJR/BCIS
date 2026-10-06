import { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { billingCycles } from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const createSchema = z.object({
  cycleCode: z.string().trim().min(1).max(30),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  dueDate: z.iso.date(),
  status: z.string().trim().min(1).max(20).default('OPEN'),
}).refine((value) => value.periodEnd >= value.periodStart, {
  message: 'Period end must be on or after period start.',
  path: ['periodEnd'],
});

const updateSchema = z.object({
  cycleCode: z.string().trim().min(1).max(30).optional(),
  periodStart: z.iso.date().optional(),
  periodEnd: z.iso.date().optional(),
  dueDate: z.iso.date().optional(),
  status: z.string().trim().min(1).max(20).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required.',
}).refine((value) => (
  !value.periodStart
  || !value.periodEnd
  || value.periodEnd >= value.periodStart
), {
  message: 'Period end must be on or after period start.',
  path: ['periodEnd'],
});

const writeRoles = ['OWNER', 'ADMINISTRATOR'];

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

export const billingCycleRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/billing-cycles', async (request, reply) => {
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
      .select()
      .from(billingCycles)
      .orderBy(desc(billingCycles.periodStart));

    return reply.send({
      success: true,
      message: 'Billing cycles loaded.',
      data: items,
    });
  });

  fastify.get('/api/v1/billing-cycles/:id', async (request, reply) => {
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
        message: 'Invalid billing cycle ID.',
        data: null,
      });
    }

    const [item] = await db
      .select()
      .from(billingCycles)
      .where(eq(billingCycles.id, parsedParams.data.id))
      .limit(1);

    if (!item) {
      return reply.code(404).send({
        success: false,
        message: 'Billing cycle not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Billing cycle loaded.',
      data: item,
    });
  });

  fastify.post('/api/v1/billing-cycles', async (request, reply) => {
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
        message: 'You do not have permission to create billing cycles.',
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
        message: 'Valid billing cycle data is required.',
        data: parsedBody.error.flatten(),
      });
    }

    try {
      const [created] = await db
        .insert(billingCycles)
        .values(parsedBody.data)
        .returning();

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'billing_cycles',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Billing cycle created successfully.',
        data: created ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          success: false,
          message: 'Billing cycle code already exists.',
          data: null,
        });
      }

      throw error;
    }
  });

  fastify.put('/api/v1/billing-cycles/:id', async (request, reply) => {
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
        message: 'You do not have permission to update billing cycles.',
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
        message: 'Invalid billing cycle ID or update data.',
        data: null,
      });
    }

    const [existing] = await db
      .select()
      .from(billingCycles)
      .where(eq(billingCycles.id, parsedParams.data.id))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({
        success: false,
        message: 'Billing cycle not found.',
        data: null,
      });
    }

    const periodStart = parsedBody.data.periodStart ?? existing.periodStart;
    const periodEnd = parsedBody.data.periodEnd ?? existing.periodEnd;

    if (periodEnd < periodStart) {
      return reply.code(400).send({
        success: false,
        message: 'Period end must be on or after period start.',
        data: null,
      });
    }

    try {
      const [updated] = await db
        .update(billingCycles)
        .set(parsedBody.data)
        .where(eq(billingCycles.id, parsedParams.data.id))
        .returning();

      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'billing_cycles',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }

      return reply.send({
        success: true,
        message: 'Billing cycle updated successfully.',
        data: updated ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          success: false,
          message: 'Billing cycle code already exists.',
          data: null,
        });
      }

      throw error;
    }
  });
};

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';
import { generateInvoicesForCycle } from '../services/billing';

const managerRoles = ['OWNER', 'ADMINISTRATOR'];

const requestSchema = z.object({
  billingCycleId: z.number().int().positive(),
});

export const billingGenerationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/api/v1/billing/generate', async (request, reply) => {
    const session = requireRole(request, managerRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to generate billing.'
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

    const parsed = requestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid billing cycle ID is required.',
        data: parsed.error.flatten(),
      });
    }

    const result = await generateInvoicesForCycle(parsed.data.billingCycleId);

    if (result.type === 'cycle_not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Billing cycle not found.',
        data: null,
      });
    }

    if (result.type === 'cycle_not_open') {
      return reply.code(409).send({
        success: false,
        message: `Billing cycle is not open (status: ${result.status}).`,
        data: null,
      });
    }

    await writeAuditLog({
      userId: session.userId,
      action: 'GENERATE_INVOICES',
      entityType: 'billing_cycles',
      entityId: parsed.data.billingCycleId,
      newValues: {
        cycleCode: result.cycleCode,
        created: result.created,
        skipped: result.skipped,
      },
      ipAddress: request.ip,
    });

    return reply.send({
      success: true,
      message: 'Billing generation completed.',
      data: {
        billingCycleId: parsed.data.billingCycleId,
        cycleCode: result.cycleCode,
        created: result.created,
        skipped: result.skipped,
      },
    });
  });
};

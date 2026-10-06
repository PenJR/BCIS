import { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';
import { NegativeInvoiceTotalError, recalculateDraftInvoiceTotals } from '../services/billing';

const { invoices, invoiceItems, invoiceAdjustments, users } = schema;

const invoiceParamsSchema = z.object({
  invoiceId: z.coerce.number().int().positive(),
});

const itemParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const numeric12Schema = z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, {
  message: 'Enter a valid amount with up to two decimal places.',
});

const positiveQuantitySchema = z.string().regex(/^(?=.*[1-9])\d{1,8}(\.\d{1,2})?$/, {
  message: 'Quantity must be greater than zero and have up to two decimal places.',
});

const createItemSchema = z.object({
  itemType: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(255),
  quantity: positiveQuantitySchema.default('1'),
  unitPrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, {
    message: 'Unit price must be a non-negative amount with up to two decimal places.',
  }),
  amount: numeric12Schema,
});

const updateItemSchema = z.object({
  itemType: z.string().trim().min(1).max(50).optional(),
  description: z.string().trim().min(1).max(255).optional(),
  quantity: positiveQuantitySchema.optional(),
  unitPrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).optional(),
  amount: numeric12Schema.optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required.',
});

const createAdjustmentSchema = z.object({
  adjustmentType: z.string().trim().min(1).max(30),
  amount: numeric12Schema,
  reason: z.string().trim().min(1),
});

const updateAdjustmentSchema = z.object({
  adjustmentType: z.string().trim().min(1).max(30).optional(),
  amount: numeric12Schema.optional(),
  reason: z.string().trim().min(1).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required.',
});

const writeRoles = ['OWNER', 'ADMINISTRATOR'];

async function getInvoiceState(invoiceId: number) {
  if (!db) {
    return null;
  }

  const [invoice] = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      finalizedAt: invoices.finalizedAt,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  return invoice ?? null;
}

function isDraft(invoice: { status: string; finalizedAt: Date | null }): boolean {
  return invoice.status === 'DRAFT' && invoice.finalizedAt === null;
}

export const invoiceDetailRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/invoices/:invoiceId/items', async (request, reply) => {
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

    const parsedParams = invoiceParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice ID.',
        data: null,
      });
    }

    const invoice = await getInvoiceState(parsedParams.data.invoiceId);

    if (!invoice) {
      return reply.code(404).send({
        success: false,
        message: 'Invoice not found.',
        data: null,
      });
    }

    const items = await db
      .select({
        id: invoiceItems.id,
        invoiceId: invoiceItems.invoiceId,
        itemType: invoiceItems.itemType,
        description: invoiceItems.description,
        quantity: invoiceItems.quantity,
        unitPrice: invoiceItems.unitPrice,
        amount: invoiceItems.amount,
        invoiceNumber: invoices.invoiceNumber,
      })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
      .where(eq(invoiceItems.invoiceId, parsedParams.data.invoiceId))
      .orderBy(desc(invoiceItems.id));

    return reply.send({
      success: true,
      message: 'Invoice items loaded.',
      data: items,
    });
  });

  fastify.post('/api/v1/invoices/:invoiceId/items', async (request, reply) => {
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
        message: 'You do not have permission to create invoice items.',
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

    const parsedParams = invoiceParamsSchema.safeParse(request.params);
    const parsedBody = createItemSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice ID or invoice item data.',
        data: null,
      });
    }

    let result;
    try {
      result = await db.transaction(async (transaction) => {
        const [invoice] = await transaction
          .select({ id: invoices.id, status: invoices.status, finalizedAt: invoices.finalizedAt })
          .from(invoices)
          .where(eq(invoices.id, parsedParams.data.invoiceId))
          .for('update')
          .limit(1);

        if (!invoice) return { type: 'invoice_not_found' as const };
        if (!isDraft(invoice)) return { type: 'invoice_not_draft' as const };

        const [item] = await transaction
          .insert(invoiceItems)
          .values({ invoiceId: invoice.id, ...parsedBody.data })
          .returning();
        await recalculateDraftInvoiceTotals(transaction, invoice.id);
        return { type: 'created' as const, item };
      });
    } catch (error) {
      if (error instanceof NegativeInvoiceTotalError) {
        return reply.code(409).send({ success: false, message: error.message, data: null });
      }
      throw error;
    }

    if (result.type === 'invoice_not_found') {
      return reply.code(404).send({ success: false, message: 'Invoice not found.', data: null });
    }
    if (result.type === 'invoice_not_draft') {
      return reply.code(409).send({ success: false, message: 'Invoice items can only be added to draft invoices.', data: null });
    }
    const created = result.item;

    if (created) {
      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'invoice_items',
        entityId: created.id,
        newValues: created,
        ipAddress: request.ip,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Invoice item created successfully.',
      data: created ?? null,
    });
  });

  fastify.put('/api/v1/invoice-items/:id', async (request, reply) => {
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
        message: 'You do not have permission to update invoice items.',
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

    const parsedParams = itemParamsSchema.safeParse(request.params);
    const parsedBody = updateItemSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice item ID or update data.',
        data: null,
      });
    }

    const [existing] = await db
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.id, parsedParams.data.id))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({
        success: false,
        message: 'Invoice item not found.',
        data: null,
      });
    }

    let result;
    try {
      result = await db.transaction(async (transaction) => {
        const [invoice] = await transaction
          .select({ id: invoices.id, status: invoices.status, finalizedAt: invoices.finalizedAt })
          .from(invoices)
          .where(eq(invoices.id, existing.invoiceId))
          .for('update')
          .limit(1);

        if (!invoice) return { type: 'invoice_not_found' as const };
        if (!isDraft(invoice)) return { type: 'invoice_not_draft' as const };

        const [item] = await transaction.update(invoiceItems)
          .set(parsedBody.data)
          .where(eq(invoiceItems.id, parsedParams.data.id))
          .returning();
        await recalculateDraftInvoiceTotals(transaction, invoice.id);
        return { type: 'updated' as const, item };
      });
    } catch (error) {
      if (error instanceof NegativeInvoiceTotalError) {
        return reply.code(409).send({ success: false, message: error.message, data: null });
      }
      throw error;
    }

    if (result.type === 'invoice_not_found') {
      return reply.code(404).send({ success: false, message: 'Invoice not found.', data: null });
    }
    if (result.type === 'invoice_not_draft') {
      return reply.code(409).send({ success: false, message: 'Invoice items on non-draft invoices cannot be updated.', data: null });
    }
    const updated = result.item;

    if (updated) {
      await writeAuditLog({
        userId: session.userId,
        action: 'UPDATE',
        entityType: 'invoice_items',
        entityId: updated.id,
        oldValues: existing,
        newValues: updated,
        ipAddress: request.ip,
      });
    }

    return reply.send({
      success: true,
      message: 'Invoice item updated successfully.',
      data: updated ?? null,
    });
  });

  fastify.get('/api/v1/invoices/:invoiceId/adjustments', async (request, reply) => {
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

    const parsedParams = invoiceParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice ID.',
        data: null,
      });
    }

    const invoice = await getInvoiceState(parsedParams.data.invoiceId);

    if (!invoice) {
      return reply.code(404).send({
        success: false,
        message: 'Invoice not found.',
        data: null,
      });
    }

    const adjustments = await db
      .select({
        id: invoiceAdjustments.id,
        invoiceId: invoiceAdjustments.invoiceId,
        adjustmentType: invoiceAdjustments.adjustmentType,
        amount: invoiceAdjustments.amount,
        reason: invoiceAdjustments.reason,
        createdBy: invoiceAdjustments.createdBy,
        createdAt: invoiceAdjustments.createdAt,
        invoiceNumber: invoices.invoiceNumber,
        createdByName: users.fullName,
      })
      .from(invoiceAdjustments)
      .innerJoin(invoices, eq(invoiceAdjustments.invoiceId, invoices.id))
      .leftJoin(users, eq(invoiceAdjustments.createdBy, users.id))
      .where(eq(invoiceAdjustments.invoiceId, parsedParams.data.invoiceId))
      .orderBy(desc(invoiceAdjustments.createdAt));

    return reply.send({
      success: true,
      message: 'Invoice adjustments loaded.',
      data: adjustments,
    });
  });

  fastify.post('/api/v1/invoices/:invoiceId/adjustments', async (request, reply) => {
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
        message: 'You do not have permission to create invoice adjustments.',
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

    const parsedParams = invoiceParamsSchema.safeParse(request.params);
    const parsedBody = createAdjustmentSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice ID or adjustment data.',
        data: null,
      });
    }

    let result;
    try {
      result = await db.transaction(async (transaction) => {
        const [invoice] = await transaction
          .select({ id: invoices.id, status: invoices.status, finalizedAt: invoices.finalizedAt })
          .from(invoices)
          .where(eq(invoices.id, parsedParams.data.invoiceId))
          .for('update')
          .limit(1);

        if (!invoice) return { type: 'invoice_not_found' as const };
        if (!isDraft(invoice)) return { type: 'invoice_not_draft' as const };

        const [adjustment] = await transaction
          .insert(invoiceAdjustments)
          .values({
            invoiceId: invoice.id,
            ...parsedBody.data,
            createdBy: session.userId,
          })
          .returning();
        await recalculateDraftInvoiceTotals(transaction, invoice.id);
        return { type: 'created' as const, adjustment };
      });
    } catch (error) {
      if (error instanceof NegativeInvoiceTotalError) {
        return reply.code(409).send({ success: false, message: error.message, data: null });
      }
      throw error;
    }

    if (result.type === 'invoice_not_found') {
      return reply.code(404).send({ success: false, message: 'Invoice not found.', data: null });
    }
    if (result.type === 'invoice_not_draft') {
      return reply.code(409).send({ success: false, message: 'Adjustments can only be added to draft invoices.', data: null });
    }
    const created = result.adjustment;

    if (created) {
      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'invoice_adjustments',
        entityId: created.id,
        newValues: created,
        ipAddress: request.ip,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Invoice adjustment created successfully.',
      data: created ?? null,
    });
  });

  fastify.put('/api/v1/invoice-adjustments/:id', async (request, reply) => {
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
        message: 'You do not have permission to update invoice adjustments.',
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

    const parsedParams = itemParamsSchema.safeParse(request.params);
    const parsedBody = updateAdjustmentSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid invoice adjustment ID or update data.',
        data: null,
      });
    }

    const [existing] = await db
      .select()
      .from(invoiceAdjustments)
      .where(eq(invoiceAdjustments.id, parsedParams.data.id))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({
        success: false,
        message: 'Invoice adjustment not found.',
        data: null,
      });
    }

    let result;
    try {
      result = await db.transaction(async (transaction) => {
        const [invoice] = await transaction
          .select({ id: invoices.id, status: invoices.status, finalizedAt: invoices.finalizedAt })
          .from(invoices)
          .where(eq(invoices.id, existing.invoiceId))
          .for('update')
          .limit(1);

        if (!invoice) return { type: 'invoice_not_found' as const };
        if (!isDraft(invoice)) return { type: 'invoice_not_draft' as const };

        const [adjustment] = await transaction.update(invoiceAdjustments)
          .set(parsedBody.data)
          .where(eq(invoiceAdjustments.id, parsedParams.data.id))
          .returning();
        await recalculateDraftInvoiceTotals(transaction, invoice.id);
        return { type: 'updated' as const, adjustment };
      });
    } catch (error) {
      if (error instanceof NegativeInvoiceTotalError) {
        return reply.code(409).send({ success: false, message: error.message, data: null });
      }
      throw error;
    }

    if (result.type === 'invoice_not_found') {
      return reply.code(404).send({ success: false, message: 'Invoice not found.', data: null });
    }
    if (result.type === 'invoice_not_draft') {
      return reply.code(409).send({ success: false, message: 'Adjustments on non-draft invoices cannot be updated.', data: null });
    }
    const updated = result.adjustment;

    if (updated) {
      await writeAuditLog({
        userId: session.userId,
        action: 'UPDATE',
        entityType: 'invoice_adjustments',
        entityId: updated.id,
        oldValues: existing,
        newValues: updated,
        ipAddress: request.ip,
      });
    }

    return reply.send({
      success: true,
      message: 'Invoice adjustment updated successfully.',
      data: updated ?? null,
    });
  });
};

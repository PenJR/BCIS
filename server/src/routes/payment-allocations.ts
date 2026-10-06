import { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  paymentAllocations,
  payments,
  invoices,
  billingCycles,
  serviceAccounts,
  subscribers,
  ledgerEntries,
} = schema;

const paymentParamsSchema = z.object({
  paymentId: z.coerce.number().int().positive(),
});

const allocationParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, {
  message: 'Amount must be greater than zero with up to two decimal places.',
}).refine((value) => /[1-9]/.test(value), {
  message: 'Amount must be greater than zero.',
});

const createAllocationSchema = z.object({
  invoiceId: z.number().int().positive(),
  amount: moneySchema,
});

const immutableUpdateSchema = z.object({
  amount: moneySchema,
});

const writeRoles = ['OWNER', 'ADMINISTRATOR', 'CASHIER'];

function amountToCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToAmount(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export const paymentAllocationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/payments/:paymentId/allocations', async (request, reply) => {
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

    const parsedParams = paymentParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID.',
        data: null,
      });
    }

    const [payment] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.id, parsedParams.data.paymentId))
      .limit(1);

    if (!payment) {
      return reply.code(404).send({
        success: false,
        message: 'Payment not found.',
        data: null,
      });
    }

    const allocations = await db
      .select({
        id: paymentAllocations.id,
        paymentId: paymentAllocations.paymentId,
        invoiceId: paymentAllocations.invoiceId,
        amount: paymentAllocations.amount,
        createdAt: paymentAllocations.createdAt,
        invoiceNumber: invoices.invoiceNumber,
        invoiceStatus: invoices.status,
        invoiceDate: invoices.invoiceDate,
        dueDate: invoices.dueDate,
        billingCycleCode: billingCycles.cycleCode,
        serviceAccountNumber: serviceAccounts.serviceAccountNumber,
        subscriberId: subscribers.id,
        subscriberAccountNumber: subscribers.accountNumber,
      })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
      .innerJoin(billingCycles, eq(invoices.billingCycleId, billingCycles.id))
      .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .where(eq(paymentAllocations.paymentId, payment.id))
      .orderBy(desc(paymentAllocations.createdAt), desc(paymentAllocations.id));

    return reply.send({
      success: true,
      message: 'Payment allocations loaded.',
      data: allocations,
    });
  });

  fastify.post('/api/v1/payments/:paymentId/allocations', async (request, reply) => {
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
        message: 'You do not have permission to create payment allocations.',
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

    const parsedParams = paymentParamsSchema.safeParse(request.params);
    const parsedBody = createAllocationSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID or allocation data.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [payment] = await transaction
        .select({
          id: payments.id,
          amount: payments.amount,
          status: payments.status,
          subscriberId: payments.subscriberId,
        })
        .from(payments)
        .where(eq(payments.id, parsedParams.data.paymentId))
        .for('update')
        .limit(1);

      if (!payment) {
        return { type: 'payment_not_found' as const };
      }

      if (payment.status !== 'POSTED') {
        return { type: 'payment_unavailable' as const };
      }

      const [invoice] = await transaction
        .select({
          id: invoices.id,
          totalAmount: invoices.totalAmount,
          status: invoices.status,
          dueDate: invoices.dueDate,
          subscriberId: serviceAccounts.subscriberId,
          serviceAccountId: invoices.serviceAccountId,
        })
        .from(invoices)
        .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
        .where(eq(invoices.id, parsedBody.data.invoiceId))
        .for('update')
        .limit(1);

      if (!invoice) {
        return { type: 'invoice_not_found' as const };
      }

      if (invoice.subscriberId !== payment.subscriberId) {
        return { type: 'subscriber_mismatch' as const };
      }

      if (!['UNPAID', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status)) {
        return { type: 'invoice_unavailable' as const };
      }

      const [existingAllocation] = await transaction
        .select({ id: paymentAllocations.id })
        .from(paymentAllocations)
        .where(and(
          eq(paymentAllocations.paymentId, payment.id),
          eq(paymentAllocations.invoiceId, invoice.id),
        ))
        .limit(1);

      if (existingAllocation) {
        return { type: 'duplicate_allocation' as const };
      }

      const paymentAllocationsForPayment = await transaction
        .select({ amount: paymentAllocations.amount })
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, payment.id));

      const paymentAllocated = paymentAllocationsForPayment.reduce(
        (total, allocation) => total + amountToCents(allocation.amount),
        0n,
      );
      const paymentRemaining = amountToCents(payment.amount) - paymentAllocated;
      const requestedAmount = amountToCents(parsedBody.data.amount);

      if (requestedAmount > paymentRemaining) {
        return { type: 'payment_balance_exceeded' as const };
      }

      const invoiceAllocations = await transaction
        .select({ amount: paymentAllocations.amount })
        .from(paymentAllocations)
        .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
        .where(and(
          eq(paymentAllocations.invoiceId, invoice.id),
          eq(payments.status, 'POSTED'),
        ));

      const invoiceAllocated = invoiceAllocations.reduce(
        (total, allocation) => total + amountToCents(allocation.amount),
        0n,
      );
      const invoiceRemaining = amountToCents(invoice.totalAmount) - invoiceAllocated;

      if (requestedAmount > invoiceRemaining) {
        return { type: 'invoice_balance_exceeded' as const };
      }

      const [created] = await transaction
        .insert(paymentAllocations)
        .values({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: parsedBody.data.amount,
        })
        .returning();

      await transaction.insert(ledgerEntries).values({
        serviceAccountId: invoice.serviceAccountId,
        invoiceId: invoice.id,
        paymentId: payment.id,
        entryType: 'PAYMENT',
        description: `Payment ${payment.id} allocated to invoice ${invoice.id}`,
        debit: '0.00',
        credit: parsedBody.data.amount,
        referenceNumber: `PAY-${payment.id}`,
      });

      const paidAfterAllocation = invoiceAllocated + requestedAmount;
      const invoiceStatus = paidAfterAllocation >= amountToCents(invoice.totalAmount)
        ? 'PAID'
        : paidAfterAllocation > 0n
          ? 'PARTIALLY_PAID'
          : invoice.dueDate < new Date().toISOString().slice(0, 10)
            ? 'OVERDUE'
            : 'UNPAID';
      await transaction
        .update(invoices)
        .set({ status: invoiceStatus, updatedAt: new Date() })
        .where(eq(invoices.id, invoice.id));

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'payment_allocations',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        }, transaction);
      }

      return { type: 'created' as const, allocation: created };
    });

    if (result.type === 'payment_not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Payment not found.',
        data: null,
      });
    }

    if (result.type === 'invoice_not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Invoice not found.',
        data: null,
      });
    }

    if (result.type === 'payment_unavailable') {
      return reply.code(409).send({
        success: false,
        message: 'Only posted, non-reversed payments can be allocated.',
        data: null,
      });
    }

    if (result.type === 'subscriber_mismatch') {
      return reply.code(409).send({
        success: false,
        message: 'Payment and invoice must belong to the same subscriber.',
        data: null,
      });
    }

    if (result.type === 'invoice_unavailable') {
      return reply.code(409).send({
        success: false,
        message: 'Invoice status does not allow payment allocation.',
        data: null,
      });
    }

    if (result.type === 'duplicate_allocation') {
      return reply.code(409).send({
        success: false,
        message: 'This payment is already allocated to the invoice.',
        data: null,
      });
    }

    if (result.type === 'payment_balance_exceeded') {
      return reply.code(409).send({
        success: false,
        message: 'Allocation exceeds the unapplied payment amount.',
        data: null,
      });
    }

    if (result.type === 'invoice_balance_exceeded') {
      return reply.code(409).send({
        success: false,
        message: 'Allocation exceeds the invoice remaining balance.',
        data: null,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Payment allocation created successfully.',
      data: result.allocation ?? null,
    });
  });

  fastify.post('/api/v1/payments/:paymentId/allocate-oldest', async (request, reply) => {
    const session = requireRole(request, writeRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to allocate payments.'
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

    const parsedParams = paymentParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [payment] = await transaction
        .select({
          id: payments.id,
          amount: payments.amount,
          status: payments.status,
          subscriberId: payments.subscriberId,
        })
        .from(payments)
        .where(eq(payments.id, parsedParams.data.paymentId))
        .for('update')
        .limit(1);

      if (!payment) return { type: 'payment_not_found' as const };
      if (payment.status !== 'POSTED') return { type: 'payment_unavailable' as const };

      const currentAllocations = await transaction
        .select({ amount: paymentAllocations.amount })
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, payment.id));
      let remaining = amountToCents(payment.amount) - currentAllocations.reduce(
        (sum, allocation) => sum + amountToCents(allocation.amount),
        0n,
      );
      if (remaining <= 0n) {
        return { type: 'allocated' as const, allocations: [], remaining };
      }

      const candidates = await transaction
        .select({
          id: invoices.id,
          serviceAccountId: invoices.serviceAccountId,
        })
        .from(invoices)
        .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
        .where(and(
          eq(serviceAccounts.subscriberId, payment.subscriberId),
          inArray(invoices.status, ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE']),
        ))
        .orderBy(asc(invoices.dueDate), asc(invoices.invoiceDate), asc(invoices.id));

      const createdAllocations: typeof paymentAllocations.$inferSelect[] = [];
      for (const candidate of candidates) {
        if (remaining <= 0n) break;

        const [invoice] = await transaction
          .select({
            id: invoices.id,
            serviceAccountId: invoices.serviceAccountId,
            totalAmount: invoices.totalAmount,
            status: invoices.status,
            dueDate: invoices.dueDate,
          })
          .from(invoices)
          .where(eq(invoices.id, candidate.id))
          .for('update')
          .limit(1);
        if (!invoice || !['UNPAID', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status)) continue;

        const [alreadyAllocated] = await transaction
          .select({ id: paymentAllocations.id })
          .from(paymentAllocations)
          .where(and(
            eq(paymentAllocations.paymentId, payment.id),
            eq(paymentAllocations.invoiceId, invoice.id),
          ))
          .limit(1);
        if (alreadyAllocated) continue;

        const activeAllocations = await transaction
          .select({ amount: paymentAllocations.amount })
          .from(paymentAllocations)
          .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
          .where(and(
            eq(paymentAllocations.invoiceId, invoice.id),
            eq(payments.status, 'POSTED'),
          ));
        const invoicePaid = activeAllocations.reduce(
          (sum, allocation) => sum + amountToCents(allocation.amount),
          0n,
        );
        const invoiceRemaining = amountToCents(invoice.totalAmount) - invoicePaid;
        if (invoiceRemaining <= 0n) continue;

        const applied = remaining < invoiceRemaining ? remaining : invoiceRemaining;
        const appliedAmount = centsToAmount(applied);
        const [created] = await transaction
          .insert(paymentAllocations)
          .values({
            paymentId: payment.id,
            invoiceId: invoice.id,
            amount: appliedAmount,
          })
          .returning();
        if (!created) {
          throw new Error('Payment allocation insert returned no record.');
        }
        await transaction.insert(ledgerEntries).values({
          serviceAccountId: invoice.serviceAccountId,
          invoiceId: invoice.id,
          paymentId: payment.id,
          entryType: 'PAYMENT',
          description: `Payment ${payment.id} allocated to invoice ${invoice.id}`,
          debit: '0.00',
          credit: appliedAmount,
          referenceNumber: `PAY-${payment.id}`,
        });
        const paidAfterAllocation = invoicePaid + applied;
        const invoiceStatus = paidAfterAllocation >= amountToCents(invoice.totalAmount)
          ? 'PAID'
          : 'PARTIALLY_PAID';
        await transaction
          .update(invoices)
          .set({ status: invoiceStatus, updatedAt: new Date() })
          .where(eq(invoices.id, invoice.id));
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'payment_allocations',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        }, transaction);
        createdAllocations.push(created);
        remaining -= applied;
      }

      return { type: 'allocated' as const, allocations: createdAllocations, remaining };
    });

    if (result.type === 'payment_not_found') {
      return reply.code(404).send({ success: false, message: 'Payment not found.', data: null });
    }
    if (result.type === 'payment_unavailable') {
      return reply.code(409).send({
        success: false,
        message: 'Only posted, non-reversed payments can be allocated.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Payment allocated to the oldest outstanding invoices.',
      data: {
        allocations: result.allocations,
        unappliedAmount: centsToAmount(result.remaining),
      },
    });
  });

  fastify.put('/api/v1/payment-allocations/:id', async (request, reply) => {
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
        message: 'You do not have permission to update payment allocations.',
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

    const parsedParams = allocationParamsSchema.safeParse(request.params);
    const parsedBody = immutableUpdateSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid allocation ID or update data.',
        data: null,
      });
    }

    const [allocation] = await db
      .select({ id: paymentAllocations.id })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.id, parsedParams.data.id))
      .limit(1);

    if (!allocation) {
      return reply.code(404).send({
        success: false,
        message: 'Payment allocation not found.',
        data: null,
      });
    }

    return reply.code(409).send({
      success: false,
      message: 'Payment allocations are immutable; a controlled reversal or adjustment is required.',
      data: null,
    });
  });
};

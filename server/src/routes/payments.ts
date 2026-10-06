import { randomUUID } from 'node:crypto';
import { FastifyPluginAsync } from 'fastify';
import {
  and,
  desc,
  eq,
  gte,
  lte,
  ne,
  sql,
  SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  payments,
  paymentProofs,
  paymentReversals,
  paymentAllocations,
  invoices,
  serviceAccounts,
  ledgerEntries,
  subscribers,
  users,
} = schema;

const paymentMethods = [
  'Cash',
  'GCash',
  'Bank Transfer',
  'Cheque',
  'Other',
] as const;

const paymentStatuses = ['PENDING', 'POSTED', 'REVERSED'] as const;
const cashierRoles = ['OWNER', 'ADMINISTRATOR', 'CASHIER'];
const reversalRoles = ['OWNER', 'ADMINISTRATOR'];

const paymentIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const amountSchema = z.string().regex(/^(?=.*[1-9])\d{1,10}(\.\d{1,2})?$/, {
  message: 'Amount must be greater than zero with up to two decimal places.',
});

const normalizePaymentMethod = z.string().trim().transform((value) => {
  const methods: Record<string, typeof paymentMethods[number]> = {
    cash: 'Cash',
    gcash: 'GCash',
    'bank transfer': 'Bank Transfer',
    cheque: 'Cheque',
    other: 'Other',
  };
  return methods[value.toLowerCase()] ?? value;
});

const createPaymentSchema = z.object({
  subscriberId: z.number().int().positive(),
  paymentDate: z.iso.datetime().optional(),
  amount: amountSchema,
  paymentMethod: normalizePaymentMethod.pipe(z.enum(paymentMethods)),
  referenceNumber: z.string().trim().min(1).max(100).optional(),
  notes: z.string().nullable().optional(),
}).superRefine((value, context) => {
  if (value.paymentMethod === 'GCash' && !value.referenceNumber) {
    context.addIssue({
      code: 'custom',
      path: ['referenceNumber'],
      message: 'GCash payments require a reference number.',
    });
  }
});

const querySchema = z.object({
  subscriberId: z.coerce.number().int().positive().optional(),
  paymentMethod: z.enum(paymentMethods).optional(),
  status: z.enum(paymentStatuses).optional(),
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

const proofSchema = z.object({
  referenceNumber: z.string().trim().min(1).max(100),
  senderName: z.string().trim().max(150).nullable().optional(),
  amount: amountSchema.optional(),
  filePath: z.string().trim().max(500).nullable().optional(),
});

const reversalSchema = z.object({
  reason: z.string().trim().min(1),
});

const verifySchema = z.object({
  proofId: z.number().int().positive().optional(),
});

function amountToCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToAmount(amount: bigint): string {
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}

type DatabaseTransaction = Parameters<
  Parameters<NonNullable<typeof db>['transaction']>[0]
>[0];

async function lockReference(
  transaction: DatabaseTransaction,
  referenceNumber: string,
): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${referenceNumber}))`);
}

async function hasPaymentReference(
  transaction: DatabaseTransaction,
  referenceNumber: string,
  excludePaymentId?: number,
): Promise<boolean> {
  const [paymentMatch] = await transaction
    .select({ id: payments.id })
    .from(payments)
    .where(and(
      eq(payments.referenceNumber, referenceNumber),
      excludePaymentId === undefined ? undefined : ne(payments.id, excludePaymentId),
    ))
    .limit(1);

  if (paymentMatch) {
    return true;
  }

  const [proofMatch] = await transaction
    .select({ id: paymentProofs.id })
    .from(paymentProofs)
    .where(and(
      eq(paymentProofs.referenceNumber, referenceNumber),
      excludePaymentId === undefined ? undefined : ne(paymentProofs.paymentId, excludePaymentId),
    ))
    .limit(1);

  return Boolean(proofMatch);
}

async function refreshInvoicePaymentState(
  transaction: DatabaseTransaction,
  invoiceId: number,
): Promise<void> {
  const [invoice] = await transaction
    .select({
      totalAmount: invoices.totalAmount,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for('update')
    .limit(1);

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} disappeared while refreshing payment state.`);
  }

  const allocations = await transaction
    .select({
      amount: paymentAllocations.amount,
      status: payments.status,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(eq(paymentAllocations.invoiceId, invoiceId));
  const paid = allocations.reduce(
    (sum, allocation) => allocation.status === 'POSTED'
      ? sum + amountToCents(allocation.amount)
      : sum,
    0n,
  );
  const total = amountToCents(invoice.totalAmount);
  const status = paid >= total
    ? 'PAID'
    : paid > 0n
      ? 'PARTIALLY_PAID'
      : invoice.dueDate < new Date().toISOString().slice(0, 10)
        ? 'OVERDUE'
        : 'UNPAID';

  await transaction
    .update(invoices)
    .set({ status, updatedAt: new Date() })
    .where(eq(invoices.id, invoiceId));
}

async function insertAllocationLedgerEntry(
  transaction: DatabaseTransaction,
  details: {
    paymentId: number;
    invoiceId: number;
    serviceAccountId: number;
    amount: string;
    description: string;
    reversal?: boolean;
  },
): Promise<void> {
  await transaction.insert(ledgerEntries).values({
    serviceAccountId: details.serviceAccountId,
    invoiceId: details.invoiceId,
    paymentId: details.paymentId,
    entryType: details.reversal ? 'PAYMENT_REVERSAL' : 'PAYMENT',
    description: details.description,
    debit: details.reversal ? details.amount : '0.00',
    credit: details.reversal ? '0.00' : details.amount,
    referenceNumber: `PAY-${details.paymentId}`,
  });
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

const paymentListFields = {
  id: payments.id,
  paymentNumber: payments.paymentNumber,
  subscriberId: payments.subscriberId,
  paymentDate: payments.paymentDate,
  amount: payments.amount,
  allocatedAmount: sql<string>`CASE
    WHEN ${payments.status} = 'POSTED' THEN COALESCE((
      SELECT SUM(${paymentAllocations.amount})
      FROM ${paymentAllocations}
      WHERE ${paymentAllocations.paymentId} = ${payments.id}
    ), 0)::numeric
    ELSE 0::numeric
  END`,
  unappliedAmount: sql<string>`CASE
    WHEN ${payments.status} = 'POSTED' THEN ${payments.amount} - COALESCE((
      SELECT SUM(${paymentAllocations.amount})
      FROM ${paymentAllocations}
      WHERE ${paymentAllocations.paymentId} = ${payments.id}
    ), 0)::numeric
    ELSE 0::numeric
  END`,
  paymentMethod: payments.paymentMethod,
  referenceNumber: payments.referenceNumber,
  notes: payments.notes,
  status: payments.status,
  receivedBy: payments.receivedBy,
  createdAt: payments.createdAt,
  subscriberAccountNumber: subscribers.accountNumber,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  receivedByName: users.fullName,
};

export const paymentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/payments', async (request, reply) => {
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
        message: 'Invalid payment filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const filters = parsedQuery.data;
    const conditions: SQL[] = [];

    if (filters.subscriberId !== undefined) {
      conditions.push(eq(payments.subscriberId, filters.subscriberId));
    }
    if (filters.paymentMethod !== undefined) {
      conditions.push(eq(payments.paymentMethod, filters.paymentMethod));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(payments.status, filters.status));
    }
    if (filters.startDate !== undefined) {
      conditions.push(gte(payments.paymentDate, new Date(filters.startDate)));
    }
    if (filters.endDate !== undefined) {
      conditions.push(lte(payments.paymentDate, new Date(filters.endDate)));
    }

    const baseQuery = db
      .select(paymentListFields)
      .from(payments)
      .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
      .innerJoin(users, eq(payments.receivedBy, users.id));

    const results = conditions.length > 0
      ? await baseQuery
        .where(and(...conditions))
        .orderBy(desc(payments.paymentDate), desc(payments.id))
      : await baseQuery.orderBy(desc(payments.paymentDate), desc(payments.id));

    return reply.send({
      success: true,
      message: 'Payments loaded.',
      data: results,
    });
  });

  fastify.get('/api/v1/payments/:id', async (request, reply) => {
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

    const parsedParams = paymentIdParamsSchema.safeParse(request.params);

    if (!parsedParams.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID.',
        data: null,
      });
    }

    const [payment] = await db
      .select(paymentListFields)
      .from(payments)
      .innerJoin(subscribers, eq(payments.subscriberId, subscribers.id))
      .innerJoin(users, eq(payments.receivedBy, users.id))
      .where(eq(payments.id, parsedParams.data.id))
      .limit(1);

    if (!payment) {
      return reply.code(404).send({
        success: false,
        message: 'Payment not found.',
        data: null,
      });
    }

    const proofs = await db
      .select({
        id: paymentProofs.id,
        paymentId: paymentProofs.paymentId,
        referenceNumber: paymentProofs.referenceNumber,
        senderName: paymentProofs.senderName,
        amount: paymentProofs.amount,
        filePath: paymentProofs.filePath,
        status: paymentProofs.status,
        verifiedBy: paymentProofs.verifiedBy,
        verifiedAt: paymentProofs.verifiedAt,
        rejectionReason: paymentProofs.rejectionReason,
        createdAt: paymentProofs.createdAt,
      })
      .from(paymentProofs)
      .where(eq(paymentProofs.paymentId, payment.id))
      .orderBy(desc(paymentProofs.createdAt));

    const reversals = await db
      .select({
        id: paymentReversals.id,
        paymentId: paymentReversals.paymentId,
        reason: paymentReversals.reason,
        reversedBy: paymentReversals.reversedBy,
        reversedAt: paymentReversals.reversedAt,
      })
      .from(paymentReversals)
      .where(eq(paymentReversals.paymentId, payment.id))
      .orderBy(desc(paymentReversals.reversedAt));

    return reply.send({
      success: true,
      message: 'Payment loaded.',
      data: {
        ...payment,
        proofs,
        reversals,
      },
    });
  });

  fastify.post('/api/v1/payments', async (request, reply) => {
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
        message: 'You do not have permission to create payments.',
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

    const parsedBody = createPaymentSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid payment data is required.',
        data: parsedBody.error.flatten(),
      });
    }

    const paymentNumber = `PAY-${randomUUID()}`;

    try {
      const result = await db.transaction(async (transaction) => {
        const [subscriber] = await transaction
          .select({ id: subscribers.id })
          .from(subscribers)
          .where(eq(subscribers.id, parsedBody.data.subscriberId))
          .limit(1);

        if (!subscriber) {
          return { type: 'subscriber_not_found' as const };
        }

        if (parsedBody.data.referenceNumber) {
          await lockReference(transaction, parsedBody.data.referenceNumber);
          if (await hasPaymentReference(transaction, parsedBody.data.referenceNumber)) {
            return { type: 'duplicate_reference' as const };
          }
        }

        const [created] = await transaction
          .insert(payments)
          .values({
            paymentNumber,
            subscriberId: parsedBody.data.subscriberId,
            paymentDate: parsedBody.data.paymentDate
              ? new Date(parsedBody.data.paymentDate)
              : undefined,
            amount: parsedBody.data.amount,
            paymentMethod: parsedBody.data.paymentMethod,
            referenceNumber: parsedBody.data.referenceNumber,
            notes: parsedBody.data.notes,
            status: parsedBody.data.paymentMethod === 'GCash' ? 'PENDING' : 'POSTED',
            receivedBy: session.userId,
          })
          .returning();

        if (created) {
          await writeAuditLog({
            userId: session.userId,
            action: 'CREATE',
            entityType: 'payments',
            entityId: created.id,
            newValues: created,
            ipAddress: request.ip,
          }, transaction);
        }

        return { type: 'created' as const, payment: created };
      });

      if (result.type === 'subscriber_not_found') {
        return reply.code(404).send({
          success: false,
          message: 'Subscriber not found.',
          data: null,
        });
      }

      if (result.type === 'duplicate_reference') {
        return reply.code(409).send({
          success: false,
          message: 'Payment reference number has already been used.',
          data: null,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Payment created successfully.',
        data: result.payment ?? null,
      });
    } catch (error) {
      if (isPostgresError(error, '23505')) {
        return reply.code(409).send({
          success: false,
          message: 'Payment number already exists.',
          data: null,
        });
      }

      if (isPostgresError(error, '23503')) {
        return reply.code(404).send({
          success: false,
          message: 'Subscriber or receiving user not found.',
          data: null,
        });
      }

      throw error;
    }
  });

  fastify.post('/api/v1/payments/:id/proof', async (request, reply) => {
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
        message: 'You do not have permission to add payment proof.',
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

    const parsedParams = paymentIdParamsSchema.safeParse(request.params);
    const parsedBody = proofSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID or proof data.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [payment] = await transaction
        .select()
        .from(payments)
        .where(eq(payments.id, parsedParams.data.id))
        .for('update')
        .limit(1);

      if (!payment) {
        return { type: 'not_found' as const };
      }

      if (payment.paymentMethod !== 'GCash') {
        return { type: 'not_gcash' as const };
      }

      if (payment.status !== 'PENDING') {
        return { type: 'not_pending' as const };
      }

      if (
        payment.referenceNumber
        && payment.referenceNumber !== parsedBody.data.referenceNumber
      ) {
        return { type: 'reference_mismatch' as const };
      }

      await lockReference(transaction, parsedBody.data.referenceNumber);
      if (await hasPaymentReference(
        transaction,
        parsedBody.data.referenceNumber,
        payment.id,
      )) {
        return { type: 'duplicate_reference' as const };
      }

      const [created] = await transaction
        .insert(paymentProofs)
        .values({
          paymentId: payment.id,
          referenceNumber: parsedBody.data.referenceNumber,
          senderName: parsedBody.data.senderName,
          amount: parsedBody.data.amount,
          filePath: parsedBody.data.filePath,
          status: 'PENDING',
        })
        .returning();

      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE_PROOF',
          entityType: 'payment_proofs',
          entityId: created.id,
          reason: 'Payment proof recorded.',
          newValues: {
            id: created.id,
            paymentId: created.paymentId,
            referenceNumber: created.referenceNumber,
            status: created.status,
          },
          ipAddress: request.ip,
        }, transaction);
      }

      return { type: 'created' as const, proof: created };
    });

    if (result.type === 'not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Payment not found.',
        data: null,
      });
    }

    if (result.type === 'not_gcash') {
      return reply.code(400).send({
        success: false,
        message: 'Payment proof is only supported for GCash payments.',
        data: null,
      });
    }

    if (result.type === 'not_pending') {
      return reply.code(409).send({
        success: false,
        message: 'Proof can only be added to a pending GCash payment.',
        data: null,
      });
    }

    if (result.type === 'reference_mismatch') {
      return reply.code(400).send({
        success: false,
        message: 'Proof reference number must match the payment reference number.',
        data: null,
      });
    }

    if (result.type === 'duplicate_reference') {
      return reply.code(409).send({
        success: false,
        message: 'GCash reference number has already been used.',
        data: null,
      });
    }

    return reply.code(201).send({
      success: true,
      message: 'Payment proof recorded successfully.',
      data: result.proof ?? null,
    });
  });

  fastify.post('/api/v1/payments/:id/verify', async (request, reply) => {
    const session = requireRole(request, reversalRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to verify payments.'
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

    const parsedParams = paymentIdParamsSchema.safeParse(request.params);
    const parsedBody = verifySchema.safeParse(request.body ?? {});

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID or verification data.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [payment] = await transaction
        .select({
          id: payments.id,
          status: payments.status,
          amount: payments.amount,
          paymentMethod: payments.paymentMethod,
        })
        .from(payments)
        .where(eq(payments.id, parsedParams.data.id))
        .for('update')
        .limit(1);

      if (!payment) return { type: 'not_found' as const };
      if (payment.paymentMethod !== 'GCash') return { type: 'not_gcash' as const };
      if (payment.status !== 'PENDING') return { type: 'not_pending' as const };

      const [proof] = await transaction
        .select()
        .from(paymentProofs)
        .where(and(
          eq(paymentProofs.paymentId, payment.id),
          eq(paymentProofs.status, 'PENDING'),
          parsedBody.data.proofId === undefined
            ? undefined
            : eq(paymentProofs.id, parsedBody.data.proofId),
        ))
        .for('update')
        .limit(1);

      if (!proof) return { type: 'proof_not_found' as const };
      if (proof.amount && amountToCents(proof.amount) !== amountToCents(payment.amount)) {
        return { type: 'amount_mismatch' as const };
      }

      const [verifiedProof] = await transaction
        .update(paymentProofs)
        .set({
          status: 'VERIFIED',
          verifiedBy: session.userId,
          verifiedAt: new Date(),
        })
        .where(eq(paymentProofs.id, proof.id))
        .returning();
      const [postedPayment] = await transaction
        .update(payments)
        .set({ status: 'POSTED' })
        .where(eq(payments.id, payment.id))
        .returning();

      await writeAuditLog({
        userId: session.userId,
        action: 'VERIFY',
        entityType: 'payments',
        entityId: payment.id,
        oldValues: { status: 'PENDING', proofStatus: 'PENDING' },
        newValues: { status: 'POSTED', proofId: proof.id, proofStatus: 'VERIFIED' },
        ipAddress: request.ip,
      }, transaction);

      return { type: 'verified' as const, payment: postedPayment, proof: verifiedProof };
    });

    if (result.type === 'not_found') {
      return reply.code(404).send({ success: false, message: 'Payment not found.', data: null });
    }
    if (result.type === 'not_gcash') {
      return reply.code(400).send({ success: false, message: 'Only GCash payments require verification.', data: null });
    }
    if (result.type === 'not_pending') {
      return reply.code(409).send({ success: false, message: 'Only pending payments can be verified.', data: null });
    }
    if (result.type === 'proof_not_found') {
      return reply.code(404).send({ success: false, message: 'Pending payment proof not found.', data: null });
    }
    if (result.type === 'amount_mismatch') {
      return reply.code(409).send({ success: false, message: 'Proof amount does not match the payment amount.', data: null });
    }

    return reply.send({
      success: true,
      message: 'Payment verified successfully.',
      data: { payment: result.payment, proof: result.proof },
    });
  });

  fastify.post('/api/v1/payments/:id/reverse', async (request, reply) => {
    const session = requireRole(request, reversalRoles);

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
        message: 'You do not have permission to reverse payments.',
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

    const parsedParams = paymentIdParamsSchema.safeParse(request.params);
    const parsedBody = reversalSchema.safeParse(request.body);

    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({
        success: false,
        message: 'Invalid payment ID or reversal data.',
        data: null,
      });
    }

    const result = await db.transaction(async (transaction) => {
      const [payment] = await transaction
        .select({
          id: payments.id,
          status: payments.status,
        })
        .from(payments)
        .where(eq(payments.id, parsedParams.data.id))
        .for('update')
        .limit(1);

      if (!payment) {
        return { type: 'not_found' as const };
      }

      const [existingReversal] = await transaction
        .select({ id: paymentReversals.id })
        .from(paymentReversals)
        .where(eq(paymentReversals.paymentId, payment.id))
        .limit(1);

      if (payment.status === 'REVERSED' || existingReversal) {
        return { type: 'already_reversed' as const };
      }

      const allocations = await transaction
        .select({
          invoiceId: paymentAllocations.invoiceId,
          amount: paymentAllocations.amount,
          serviceAccountId: invoices.serviceAccountId,
        })
        .from(paymentAllocations)
        .innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
        .where(eq(paymentAllocations.paymentId, payment.id))
        .orderBy(paymentAllocations.invoiceId);

      const [reversal] = await transaction
        .insert(paymentReversals)
        .values({
          paymentId: payment.id,
          reason: parsedBody.data.reason,
          reversedBy: session.userId,
        })
        .returning();

      await transaction
        .update(payments)
        .set({ status: 'REVERSED' })
        .where(eq(payments.id, payment.id));

      for (const allocation of allocations) {
        await insertAllocationLedgerEntry(transaction, {
          paymentId: payment.id,
          invoiceId: allocation.invoiceId,
          serviceAccountId: allocation.serviceAccountId,
          amount: allocation.amount,
          description: `Payment ${payment.id} reversed: ${parsedBody.data.reason}`,
          reversal: true,
        });
      }

      for (const invoiceId of [...new Set(allocations.map((allocation) => allocation.invoiceId))]) {
        await refreshInvoicePaymentState(transaction, invoiceId);
      }

      await writeAuditLog({
        userId: session.userId,
        action: 'REVERSE',
        entityType: 'payments',
        entityId: payment.id,
        reason: parsedBody.data.reason,
        oldValues: { status: payment.status },
        newValues: { status: 'REVERSED', reversalId: reversal?.id },
        ipAddress: request.ip,
      }, transaction);

      return { type: 'reversed' as const, reversal };
    });

    if (result.type === 'not_found') {
      return reply.code(404).send({
        success: false,
        message: 'Payment not found.',
        data: null,
      });
    }

    if (result.type === 'already_reversed') {
      return reply.code(409).send({
        success: false,
        message: 'Payment has already been reversed.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Payment reversed successfully.',
      data: result.reversal ?? null,
    });
  });
};

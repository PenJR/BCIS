import { FastifyPluginAsync } from 'fastify';
import {
  and,
  desc,
  eq,
  gte,
  lte,
  SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth, requireRole } from '../lib/auth';
import { db } from '../lib/db';

const {
  ledgerEntries,
  serviceAccounts,
  subscribers,
  invoices,
  payments,
} = schema;

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const querySchema = z.object({
  serviceAccountId: z.coerce.number().int().positive().optional(),
  subscriberId: z.coerce.number().int().positive().optional(),
  invoiceId: z.coerce.number().int().positive().optional(),
  paymentId: z.coerce.number().int().positive().optional(),
  entryType: z.string().trim().min(1).max(30).optional(),
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

const viewRoles = [
  'OWNER',
  'ADMINISTRATOR',
  'ACCOUNTING_AUDITOR',
  'COLLECTION_SUPERVISOR',
  'VIEWER',
  'READ_ONLY_VIEWER',
  'READ_ONLY',
];

const ledgerFields = {
  id: ledgerEntries.id,
  serviceAccountId: ledgerEntries.serviceAccountId,
  invoiceId: ledgerEntries.invoiceId,
  paymentId: ledgerEntries.paymentId,
  entryDate: ledgerEntries.entryDate,
  entryType: ledgerEntries.entryType,
  description: ledgerEntries.description,
  debit: ledgerEntries.debit,
  credit: ledgerEntries.credit,
  referenceNumber: ledgerEntries.referenceNumber,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberId: subscribers.id,
  subscriberAccountNumber: subscribers.accountNumber,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  invoiceNumber: invoices.invoiceNumber,
  paymentNumber: payments.paymentNumber,
  paymentReferenceNumber: payments.referenceNumber,
};

export const ledgerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/ledger', async (request, reply) => {
    const session = requireRole(request, viewRoles);

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
        message: 'You do not have permission to view ledger entries.',
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
        message: 'Invalid ledger filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const filters = parsedQuery.data;
    const conditions: SQL[] = [];

    if (filters.serviceAccountId !== undefined) {
      conditions.push(eq(ledgerEntries.serviceAccountId, filters.serviceAccountId));
    }
    if (filters.subscriberId !== undefined) {
      conditions.push(eq(serviceAccounts.subscriberId, filters.subscriberId));
    }
    if (filters.invoiceId !== undefined) {
      conditions.push(eq(ledgerEntries.invoiceId, filters.invoiceId));
    }
    if (filters.paymentId !== undefined) {
      conditions.push(eq(ledgerEntries.paymentId, filters.paymentId));
    }
    if (filters.entryType !== undefined) {
      conditions.push(eq(ledgerEntries.entryType, filters.entryType));
    }
    if (filters.startDate !== undefined) {
      conditions.push(gte(ledgerEntries.entryDate, new Date(filters.startDate)));
    }
    if (filters.endDate !== undefined) {
      conditions.push(lte(ledgerEntries.entryDate, new Date(filters.endDate)));
    }

    const baseQuery = db
      .select(ledgerFields)
      .from(ledgerEntries)
      .innerJoin(
        serviceAccounts,
        eq(ledgerEntries.serviceAccountId, serviceAccounts.id),
      )
      .innerJoin(
        subscribers,
        eq(serviceAccounts.subscriberId, subscribers.id),
      )
      .leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id))
      .leftJoin(payments, eq(ledgerEntries.paymentId, payments.id));

    const entries = conditions.length > 0
      ? await baseQuery
        .where(and(...conditions))
        .orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.id))
      : await baseQuery.orderBy(desc(ledgerEntries.entryDate), desc(ledgerEntries.id));

    return reply.send({
      success: true,
      message: 'Ledger entries loaded.',
      data: entries,
    });
  });

  fastify.get('/api/v1/ledger/:id', async (request, reply) => {
    const session = requireRole(request, viewRoles);

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
        message: 'You do not have permission to view ledger entries.',
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
        message: 'Invalid ledger entry ID.',
        data: null,
      });
    }

    const [entry] = await db
      .select(ledgerFields)
      .from(ledgerEntries)
      .innerJoin(
        serviceAccounts,
        eq(ledgerEntries.serviceAccountId, serviceAccounts.id),
      )
      .innerJoin(
        subscribers,
        eq(serviceAccounts.subscriberId, subscribers.id),
      )
      .leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id))
      .leftJoin(payments, eq(ledgerEntries.paymentId, payments.id))
      .where(eq(ledgerEntries.id, parsedParams.data.id))
      .limit(1);

    if (!entry) {
      return reply.code(404).send({
        success: false,
        message: 'Ledger entry not found.',
        data: null,
      });
    }

    return reply.send({
      success: true,
      message: 'Ledger entry loaded.',
      data: entry,
    });
  });
};

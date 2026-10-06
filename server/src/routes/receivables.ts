import { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { requireAuth } from '../lib/auth';
import { db } from '../lib/db';

const {
  invoices,
  paymentAllocations,
  payments,
  serviceAccounts,
  subscribers,
} = schema;

const querySchema = z.object({
  subscriberId: z.coerce.number().int().positive().optional(),
  serviceAccountId: z.coerce.number().int().positive().optional(),
});

const paidAmountExpression = sql<string>`COALESCE((
  SELECT SUM(${paymentAllocations.amount})
  FROM ${paymentAllocations}
  INNER JOIN ${payments} ON ${paymentAllocations.paymentId} = ${payments.id}
  WHERE ${paymentAllocations.invoiceId} = ${invoices.id}
    AND ${payments.status} = 'POSTED'
), 0)::numeric`;

function amountToCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToAmount(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

function daysOverdue(dueDate: string, today: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  return Math.floor((current - due) / 86_400_000);
}

type AgingAmounts = {
  current: bigint;
  days1To30: bigint;
  days31To60: bigint;
  days61To90: bigint;
  over90Days: bigint;
};

function emptyAging(): AgingAmounts {
  return {
    current: 0n,
    days1To30: 0n,
    days31To60: 0n,
    days61To90: 0n,
    over90Days: 0n,
  };
}

export const receivableRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/receivables', async (request, reply) => {
    if (!requireAuth(request)) {
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
        message: 'Invalid receivables filters.',
        data: parsedQuery.error.flatten(),
      });
    }

    const { subscriberId, serviceAccountId } = parsedQuery.data;
    const rows = await db
      .select({
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceDate: invoices.invoiceDate,
        dueDate: invoices.dueDate,
        totalAmount: invoices.totalAmount,
        amountPaid: paidAmountExpression,
        status: invoices.status,
        serviceAccountId: serviceAccounts.id,
        serviceAccountNumber: serviceAccounts.serviceAccountNumber,
        subscriberId: subscribers.id,
        subscriberAccountNumber: subscribers.accountNumber,
        subscriberFirstName: subscribers.firstName,
        subscriberLastName: subscribers.lastName,
      })
      .from(invoices)
      .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .where(and(
        subscriberId === undefined ? undefined : eq(subscribers.id, subscriberId),
        serviceAccountId === undefined ? undefined : eq(serviceAccounts.id, serviceAccountId),
        sql`${invoices.status} <> 'DRAFT'`,
      ));

    const today = new Date().toISOString().slice(0, 10);
    const accounts = new Map<number, {
      serviceAccountId: number;
      serviceAccountNumber: string;
      subscriberId: number;
      subscriberAccountNumber: string;
      subscriberFirstName: string;
      subscriberLastName: string;
      outstandingCents: bigint;
      overdueCents: bigint;
      aging: AgingAmounts;
      invoices: Array<{
        invoiceId: number;
        invoiceNumber: string;
        invoiceDate: string;
        dueDate: string;
        totalAmount: string;
        amountPaid: string;
        balance: string;
        status: string;
        daysOverdue: number;
        agingBucket: string;
      }>;
    }>();

    for (const row of rows) {
      const balance = amountToCents(row.totalAmount) - amountToCents(row.amountPaid);
      if (balance <= 0n) continue;
      const overdueDays = Math.max(0, daysOverdue(row.dueDate, today));
      const agingBucket = overdueDays === 0
        ? 'CURRENT'
        : overdueDays <= 30
          ? '1_30_DAYS'
          : overdueDays <= 60
            ? '31_60_DAYS'
            : overdueDays <= 90
              ? '61_90_DAYS'
              : 'OVER_90_DAYS';
      let account = accounts.get(row.serviceAccountId);
      if (!account) {
        account = {
          serviceAccountId: row.serviceAccountId,
          serviceAccountNumber: row.serviceAccountNumber,
          subscriberId: row.subscriberId,
          subscriberAccountNumber: row.subscriberAccountNumber,
          subscriberFirstName: row.subscriberFirstName,
          subscriberLastName: row.subscriberLastName,
          outstandingCents: 0n,
          overdueCents: 0n,
          aging: emptyAging(),
          invoices: [],
        };
        accounts.set(row.serviceAccountId, account);
      }
      account.outstandingCents += balance;
      if (overdueDays > 0) account.overdueCents += balance;
      if (agingBucket === 'CURRENT') account.aging.current += balance;
      else if (agingBucket === '1_30_DAYS') account.aging.days1To30 += balance;
      else if (agingBucket === '31_60_DAYS') account.aging.days31To60 += balance;
      else if (agingBucket === '61_90_DAYS') account.aging.days61To90 += balance;
      else account.aging.over90Days += balance;

      account.invoices.push({
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate,
        dueDate: row.dueDate,
        totalAmount: row.totalAmount,
        amountPaid: row.amountPaid,
        balance: centsToAmount(balance),
        status: row.status,
        daysOverdue: overdueDays,
        agingBucket,
      });
    }

    const data = [...accounts.values()].map((account) => ({
      serviceAccountId: account.serviceAccountId,
      serviceAccountNumber: account.serviceAccountNumber,
      subscriberId: account.subscriberId,
      subscriberAccountNumber: account.subscriberAccountNumber,
      subscriberFirstName: account.subscriberFirstName,
      subscriberLastName: account.subscriberLastName,
      outstandingBalance: centsToAmount(account.outstandingCents),
      overdueBalance: centsToAmount(account.overdueCents),
      aging: {
        current: centsToAmount(account.aging.current),
        days1To30: centsToAmount(account.aging.days1To30),
        days31To60: centsToAmount(account.aging.days31To60),
        days61To90: centsToAmount(account.aging.days61To90),
        over90Days: centsToAmount(account.aging.over90Days),
      },
      invoices: account.invoices,
    }));

    return reply.send({
      success: true,
      message: 'Receivables loaded.',
      data,
    });
  });
};

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as tables from '../../db/schema';
import { db } from '../lib/db';

type DatabaseTransaction = Parameters<
  Parameters<NonNullable<typeof db>['transaction']>[0]
>[0];

type BillingGenerationResult =
  | { type: 'cycle_not_found' }
  | { type: 'cycle_not_open'; status: string }
  | { type: 'generated'; cycleCode: string; created: number; skipped: number };

type InvoiceTotalResult =
  | { type: 'invoice_not_found' }
  | { type: 'invoice_not_draft' }
  | { type: 'negative_total' }
  | {
      type: 'updated';
      invoice: typeof tables.invoices.$inferSelect;
      amountPaid: string;
      balance: string;
    };

export class NegativeInvoiceTotalError extends Error {
  constructor() {
    super('Invoice adjustments cannot make the total negative.');
    this.name = 'NegativeInvoiceTotalError';
  }
}

function toCents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fractional = ''] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
  return negative ? -cents : cents;
}

function fromCents(amount: bigint): string {
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function amountClass(type: string): 'discount' | 'penalty' | 'other' {
  const normalized = type.trim().toUpperCase();
  if (normalized.includes('DISCOUNT')) return 'discount';
  if (normalized.includes('PENALTY')) return 'penalty';
  return 'other';
}

export async function generateInvoicesForCycle(
  cycleId: number,
): Promise<BillingGenerationResult> {
  if (!db) {
    throw new Error('Database is not available.');
  }

  return db.transaction(async (transaction) => {
    const [cycle] = await transaction
      .select({
        id: tables.billingCycles.id,
        cycleCode: tables.billingCycles.cycleCode,
        periodStart: tables.billingCycles.periodStart,
        dueDate: tables.billingCycles.dueDate,
        status: tables.billingCycles.status,
      })
      .from(tables.billingCycles)
      .where(eq(tables.billingCycles.id, cycleId))
      .for('update')
      .limit(1);

    if (!cycle) {
      return { type: 'cycle_not_found' as const };
    }

    if (cycle.status !== 'OPEN') {
      return { type: 'cycle_not_open' as const, status: cycle.status };
    }

    const accounts = await transaction
      .select({
        id: tables.serviceAccounts.id,
        serviceAccountNumber: tables.serviceAccounts.serviceAccountNumber,
        currentRate: tables.serviceAccounts.currentRate,
        planName: tables.servicePlans.planName,
      })
      .from(tables.serviceAccounts)
      .innerJoin(tables.servicePlans, eq(tables.serviceAccounts.planId, tables.servicePlans.id))
      .where(and(
        eq(tables.serviceAccounts.status, 'ACTIVE'),
        eq(tables.servicePlans.status, 'ACTIVE'),
      ));

    const existingInvoices = await transaction
      .select({ serviceAccountId: tables.invoices.serviceAccountId })
      .from(tables.invoices)
      .where(eq(tables.invoices.billingCycleId, cycle.id));
    const existingAccountIds = new Set(existingInvoices.map((invoice) => invoice.serviceAccountId));

    let createdCount = 0;
    let skippedCount = existingAccountIds.size;

    for (const account of accounts) {
      if (existingAccountIds.has(account.id)) {
        continue;
      }

      const amount = fromCents(toCents(account.currentRate));
      const invoiceNumber = `INV-${cryptoRandomId()}`;
      const [invoice] = await transaction
        .insert(tables.invoices)
        .values({
          invoiceNumber,
          serviceAccountId: account.id,
          billingCycleId: cycle.id,
          invoiceDate: cycle.periodStart,
          dueDate: cycle.dueDate,
          subtotal: amount,
          discountAmount: '0.00',
          penaltyAmount: '0.00',
          totalAmount: amount,
          status: 'UNPAID',
          finalizedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [tables.invoices.serviceAccountId, tables.invoices.billingCycleId],
        })
        .returning();

      if (!invoice) {
        skippedCount += 1;
        continue;
      }

      await transaction.insert(tables.invoiceItems).values({
        invoiceId: invoice.id,
        itemType: 'SUBSCRIPTION',
        description: `Monthly subscription - ${account.planName}`,
        quantity: '1.00',
        unitPrice: amount,
        amount,
      });

      await transaction.insert(tables.ledgerEntries).values({
        serviceAccountId: account.id,
        invoiceId: invoice.id,
        entryType: 'INVOICE',
        description: `Invoice ${invoice.invoiceNumber} generated for ${cycle.cycleCode}`,
        debit: amount,
        credit: '0.00',
        referenceNumber: invoice.invoiceNumber,
      });

      createdCount += 1;
      existingAccountIds.add(account.id);
    }

    return {
      type: 'generated' as const,
      cycleCode: cycle.cycleCode,
      created: createdCount,
      skipped: skippedCount,
    };
  });
}

export async function recalculateDraftInvoiceTotals(
  transaction: DatabaseTransaction,
  invoiceId: number,
): Promise<InvoiceTotalResult> {
  const [invoice] = await transaction
    .select({
      id: tables.invoices.id,
      status: tables.invoices.status,
      finalizedAt: tables.invoices.finalizedAt,
      totalAmount: tables.invoices.totalAmount,
    })
    .from(tables.invoices)
    .where(eq(tables.invoices.id, invoiceId))
    .for('update')
    .limit(1);

  if (!invoice) {
    return { type: 'invoice_not_found' };
  }

  if (invoice.status !== 'DRAFT' || invoice.finalizedAt !== null) {
    return { type: 'invoice_not_draft' };
  }

  const items = await transaction
    .select({ itemType: tables.invoiceItems.itemType, amount: tables.invoiceItems.amount })
    .from(tables.invoiceItems)
    .where(eq(tables.invoiceItems.invoiceId, invoiceId));

  const adjustments = await transaction
    .select({ adjustmentType: tables.invoiceAdjustments.adjustmentType, amount: tables.invoiceAdjustments.amount })
    .from(tables.invoiceAdjustments)
    .where(eq(tables.invoiceAdjustments.invoiceId, invoiceId));

  let subtotalCents = 0n;
  let discountCents = 0n;
  let penaltyCents = 0n;
  let otherAdjustmentsCents = 0n;

  for (const item of items) {
    const amount = toCents(item.amount);
    const category = amountClass(item.itemType);
    if (category === 'discount') {
      discountCents += amount < 0n ? -amount : amount;
    } else if (category === 'penalty') {
      penaltyCents += amount < 0n ? -amount : amount;
    } else {
      subtotalCents += amount;
    }
  }

  for (const adjustment of adjustments) {
    const amount = toCents(adjustment.amount);
    const category = amountClass(adjustment.adjustmentType);
    if (category === 'discount') {
      discountCents += amount < 0n ? -amount : amount;
    } else if (category === 'penalty') {
      penaltyCents += amount < 0n ? -amount : amount;
    } else {
      otherAdjustmentsCents += amount;
    }
  }

  const totalCents = subtotalCents - discountCents + penaltyCents + otherAdjustmentsCents;
  if (totalCents < 0n) {
    throw new NegativeInvoiceTotalError();
  }

  const [updated] = await transaction
    .update(tables.invoices)
    .set({
      subtotal: fromCents(subtotalCents),
      discountAmount: fromCents(discountCents),
      penaltyAmount: fromCents(penaltyCents),
      totalAmount: fromCents(totalCents),
      updatedAt: new Date(),
    })
    .where(eq(tables.invoices.id, invoiceId))
    .returning();

  const allocations = await transaction
    .select({
      amount: tables.paymentAllocations.amount,
      paymentStatus: tables.payments.status,
    })
    .from(tables.paymentAllocations)
    .innerJoin(tables.payments, eq(tables.paymentAllocations.paymentId, tables.payments.id))
    .where(eq(tables.paymentAllocations.invoiceId, invoiceId));

  const paidCents = allocations.reduce(
    (sum, allocation) => allocation.paymentStatus === 'REVERSED'
      ? sum
      : sum + toCents(allocation.amount),
    0n,
  );
  const balanceCents = totalCents - paidCents;

  return {
    type: 'updated',
    invoice: updated,
    amountPaid: fromCents(paidCents),
    balance: fromCents(balanceCents),
  };
}

function cryptoRandomId(): string {
  return randomUUID().replaceAll('-', '');
}

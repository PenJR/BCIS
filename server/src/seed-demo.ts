import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hashPassword } from './lib/auth';
import { closeDatabase, db, initializeDatabase } from './lib/db';

const {
  batchAccounts,
  billingCycles,
  collectionAreas,
  collectionBatches,
  collectorAssignments,
  collectorRemittances,
  invoiceItems,
  invoices,
  ledgerEntries,
  paymentAllocations,
  paymentReversals,
  payments,
  receipts,
  reconnectionRecords,
  roles,
  serviceAccounts,
  servicePlans,
  serviceTypes,
  subscriberAddresses,
  subscribers,
  suspensionRecords,
  userRoles,
  users,
} = schema;

const demoPrefix = 'DEMO13';
const demoPassword = process.env.BCIS_DEMO_PASSWORD ?? 'Demo13!Only';

const demoUsers = [
  { username: 'demo13_owner', fullName: 'Demo Owner', role: 'OWNER' },
  { username: 'demo13_cashier', fullName: 'Demo Cashier', role: 'CASHIER' },
  { username: 'demo13_collector_north', fullName: 'Demo Collector North', role: 'COLLECTION_SUPERVISOR' },
  { username: 'demo13_auditor', fullName: 'Demo Accounting Auditor', role: 'ACCOUNTING_AUDITOR' },
  { username: 'demo13_technician', fullName: 'Demo Technician', role: 'TECHNICIAN' },
] as const;

const demoAreas = [
  { areaCode: 'DEMO13-NORTH', areaName: 'Demo North District' },
  { areaCode: 'DEMO13-CENTRAL', areaName: 'Demo Central District' },
  { areaCode: 'DEMO13-SOUTH', areaName: 'Demo South District' },
] as const;

const demoPlanSpecs = [
  { code: 'DEMO13-INET-100', name: 'Demo Internet 100 Mbps', type: 'Internet', price: '899.00', speed: 100 },
  { code: 'DEMO13-INET-300', name: 'Demo Internet 300 Mbps', type: 'Internet', price: '1299.00', speed: 300 },
  { code: 'DEMO13-INET-500', name: 'Demo Internet 500 Mbps', type: 'Internet', price: '1799.00', speed: 500 },
  { code: 'DEMO13-CABLE-80', name: 'Demo Cable Basic', type: 'Cable', price: '549.00', channels: 80 },
  { code: 'DEMO13-CABLE-150', name: 'Demo Cable Plus', type: 'Cable', price: '799.00', channels: 150 },
  { code: 'DEMO13-COMBO-100', name: 'Demo Combo 100 Mbps + Cable', type: 'Combo', price: '1499.00', speed: 100, channels: 80 },
  { code: 'DEMO13-COMBO-300', name: 'Demo Combo 300 Mbps + Cable', type: 'Combo', price: '2099.00', speed: 300, channels: 150 },
] as const;

function monthDates(month: string): { start: string; end: string; due: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstDay = `${month}-01`;
  const lastDate = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { start: firstDay, end: lastDate, due: `${month}-15` };
}

function addCents(left: string, right: string): string {
  return fromCents(toCents(left) + toCents(right));
}

function toCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function fromCents(amount: bigint): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function amountFraction(amount: string, numerator: bigint, denominator: bigint): string {
  return fromCents(toCents(amount) * numerator / denominator);
}

function currentStatus(amountPaid: bigint, total: string, dueDate: string): string {
  const totalCents = toCents(total);
  if (amountPaid >= totalCents) return 'PAID';
  if (amountPaid > 0n) return 'PARTIALLY_PAID';
  return dueDate < new Date().toISOString().slice(0, 10) ? 'OVERDUE' : 'UNPAID';
}

export type DemoSeedCounts = {
  users: number;
  servicePlans: number;
  subscribers: number;
  serviceAccounts: number;
  collectionAreas: number;
  billingCycles: number;
  invoices: number;
  payments: number;
  collectionBatches: number;
  remittances: number;
  suspensions: number;
  reconnections: number;
};

type SeededMasterData = {
  usersByUsername: Map<string, number>;
  areas: Array<typeof collectionAreas.$inferSelect>;
  subscriberRows: Array<typeof subscribers.$inferSelect>;
  accounts: Array<typeof serviceAccounts.$inferSelect>;
};

export async function seedDemoData(): Promise<DemoSeedCounts> {
  if (!db) {
    throw new Error('Database is not available.');
  }
  if (!demoPassword.trim()) {
    throw new Error('BCIS_DEMO_PASSWORD must not be empty.');
  }

  const seeded = await db.transaction(async (transaction) => {
    const roleNames = [...new Set([
      ...demoUsers.map((user) => user.role),
      'ADMINISTRATOR',
      'COLLECTION_SUPERVISOR',
      'CASHIER',
      'OWNER',
      'ACCOUNTING_AUDITOR',
      'TECHNICIAN',
    ])];
    await transaction.insert(roles).values(roleNames.map((name) => ({ name }))).onConflictDoNothing();
    const roleRows = await transaction.select().from(roles);
    const roleIdByName = new Map(roleRows.map((role) => [role.name, role.id]));
    const usersByUsername = new Map<string, number>();

    for (const demoUser of demoUsers) {
      await transaction.insert(users).values({
        username: demoUser.username,
        passwordHash: hashPassword(demoPassword),
        fullName: demoUser.fullName,
        email: `${demoUser.username}@bcis.local`,
        status: 'ACTIVE',
      }).onConflictDoNothing();
      const [user] = await transaction.select({ id: users.id })
        .from(users)
        .where(eq(users.username, demoUser.username))
        .limit(1);
      const roleId = roleIdByName.get(demoUser.role);
      if (!user || roleId === undefined) {
        throw new Error(`Could not resolve seeded user or role: ${demoUser.username}.`);
      }
      usersByUsername.set(demoUser.username, user.id);
      await transaction.insert(userRoles).values({ userId: user.id, roleId }).onConflictDoNothing();
    }

    await transaction.insert(collectionAreas).values(demoAreas.map((area) => ({
      ...area,
      description: 'Synthetic training collection area.',
      status: 'ACTIVE',
    }))).onConflictDoNothing();
    const areas = await transaction.select().from(collectionAreas)
      .where(inArray(collectionAreas.areaCode, demoAreas.map((area) => area.areaCode)));
    const areaByCode = new Map(areas.map((area) => [area.areaCode, area.id]));

    const typeNames = [...new Set(demoPlanSpecs.map((plan) => plan.type))];
    await transaction.insert(serviceTypes).values(typeNames.map((name) => ({
      name,
      description: 'Demo service type.',
    }))).onConflictDoNothing();
    const types = await transaction.select().from(serviceTypes)
      .where(inArray(serviceTypes.name, typeNames));
    const typeByName = new Map(types.map((type) => [type.name, type.id]));
    await transaction.insert(servicePlans).values(demoPlanSpecs.map((plan) => {
      const serviceTypeId = typeByName.get(plan.type);
      if (serviceTypeId === undefined) {
        throw new Error(`Missing demo service type ${plan.type}.`);
      }
      return {
        serviceTypeId,
        planCode: plan.code,
        planName: plan.name,
        price: plan.price,
        installationFee: '0.00',
        reconnectionFee: '75.00',
        speedMbps: 'speed' in plan ? plan.speed : null,
        channelCount: 'channels' in plan ? plan.channels : null,
        description: 'Synthetic training plan; not for customer billing.',
        status: 'ACTIVE',
      };
    })).onConflictDoNothing();
    const plans = await transaction.select().from(servicePlans)
      .where(inArray(servicePlans.planCode, demoPlanSpecs.map((plan) => plan.code)));
    const planByCode = new Map(plans.map((plan) => [plan.planCode, plan]));

    const subscriberNumbers = Array.from({ length: 50 }, (_, index) => (
      `${demoPrefix}-SUB-${String(index + 1).padStart(4, '0')}`
    ));
    await transaction.insert(subscribers).values(subscriberNumbers.map((accountNumber, index) => {
      const areaId = areaByCode.get(demoAreas[index % demoAreas.length].areaCode);
      if (areaId === undefined) throw new Error('A demo collection area is missing.');
      return {
        accountNumber,
        firstName: `Demo${String(index + 1).padStart(2, '0')}`,
        middleName: null,
        lastName: 'Subscriber',
        contactNumber: `0917${String(index + 1).padStart(7, '0')}`,
        email: `subscriber${index + 1}@demo.bcis.local`,
        collectionAreaId: areaId,
        billingDay: 1,
        dueDay: 15,
        status: 'ACTIVE',
        notes: 'Synthetic training record.',
      };
    })).onConflictDoNothing();
    const subscriberRows = await transaction.select().from(subscribers)
      .where(inArray(subscribers.accountNumber, subscriberNumbers));
    const subscriberByNumber = new Map(subscriberRows.map((subscriber) => [subscriber.accountNumber, subscriber]));

    const addressBySubscriberId = new Map<number, number>();
    const knownAddresses = await transaction.select({
      id: subscriberAddresses.id,
      subscriberId: subscriberAddresses.subscriberId,
    }).from(subscriberAddresses)
      .where(inArray(subscriberAddresses.subscriberId, subscriberRows.map((subscriber) => subscriber.id)));
    for (const address of knownAddresses) {
      if (!addressBySubscriberId.has(address.subscriberId)) {
        addressBySubscriberId.set(address.subscriberId, address.id);
      }
    }
    const missingAddressRows = subscriberRows
      .filter((subscriber) => !addressBySubscriberId.has(subscriber.id))
      .map((subscriber, index) => {
        const areaName = demoAreas[Number(subscriber.accountNumber.slice(-4)) % demoAreas.length].areaName;
        return {
          subscriberId: subscriber.id,
          addressType: 'SERVICE',
          addressLine: `${100 + index} Demo Avenue`,
          barangay: areaName,
          city: 'Demo City',
          province: 'Demo Province',
          isPrimary: true,
        };
      });
    if (missingAddressRows.length > 0) {
      const insertedAddresses = await transaction.insert(subscriberAddresses)
        .values(missingAddressRows)
        .returning({ id: subscriberAddresses.id, subscriberId: subscriberAddresses.subscriberId });
      for (const address of insertedAddresses) addressBySubscriberId.set(address.subscriberId, address.id);
    }

    const serviceAccountNumbers = Array.from({ length: 60 }, (_, index) => (
      `${demoPrefix}-SVC-${String(index + 1).padStart(4, '0')}`
    ));
    const cashierId = usersByUsername.get('demo13_cashier');
    const collectorId = usersByUsername.get('demo13_collector_north');
    if (cashierId === undefined || collectorId === undefined) throw new Error('Demo collector users are missing.');

    await transaction.insert(serviceAccounts).values(serviceAccountNumbers.map((serviceAccountNumber, index) => {
      const subscriberIndex = index < 50 ? index : index - 50;
      const subscriberNumber = subscriberNumbers[subscriberIndex];
      const subscriber = subscriberByNumber.get(subscriberNumber);
      const addressId = subscriber ? addressBySubscriberId.get(subscriber.id) : undefined;
      const planSpec = demoPlanSpecs[index % demoPlanSpecs.length];
      const plan = planByCode.get(planSpec.code);
      if (!subscriber || !plan || !addressId) {
        throw new Error(`Demo account references are incomplete for ${serviceAccountNumber}.`);
      }
      return {
        serviceAccountNumber,
        subscriberId: subscriber.id,
        planId: plan.id,
        installationAddressId: addressId,
        activationDate: '2025-01-01',
        billingStartDate: '2025-01-01',
        billingDay: 1,
        dueDay: 15,
        currentRate: plan.price,
        assignedCollectorId: index % 2 === 0 ? cashierId : collectorId,
        status: 'ACTIVE',
      };
    })).onConflictDoNothing();
    const accounts = (await transaction.select().from(serviceAccounts)
      .where(inArray(serviceAccounts.serviceAccountNumber, serviceAccountNumbers)));
    accounts.sort((left, right) => left.serviceAccountNumber.localeCompare(right.serviceAccountNumber));

    return {
      usersByUsername,
      areas,
      subscriberRows,
      accounts,
    };
  });

  const months = ['2026-07', '2026-08', '2026-09'];
  await db.transaction(async (transaction) => {
    for (const month of months) {
      const code = `${demoPrefix}-${month.replace('-', '')}`;
      const dates = monthDates(month);
      await transaction.insert(billingCycles).values({
        cycleCode: code,
        periodStart: dates.start,
        periodEnd: dates.end,
        dueDate: dates.due,
        status: 'CLOSED',
      }).onConflictDoNothing();
      const [cycle] = await transaction.select({ id: billingCycles.id })
        .from(billingCycles)
        .where(eq(billingCycles.cycleCode, code))
        .limit(1);
      if (!cycle) throw new Error(`Could not resolve demo billing cycle ${code}.`);
      const expectedInvoices = seeded.accounts.map((account) => ({
        account,
        cycleId: cycle.id,
        number: `${demoPrefix}-INV-${month.replace('-', '')}-${account.serviceAccountNumber.slice(-4)}`,
      }));
      const existingNumbers = new Set((await transaction.select({ invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(inArray(invoices.invoiceNumber, expectedInvoices.map((item) => item.number))))
        .map((invoice) => invoice.invoiceNumber));
      for (const item of expectedInvoices) {
        if (existingNumbers.has(item.number)) continue;
        const dueDate = dates.due;
        const amount = item.account.currentRate;
        const [invoice] = await transaction.insert(invoices).values({
          invoiceNumber: item.number,
          serviceAccountId: item.account.id,
          billingCycleId: item.cycleId,
          invoiceDate: dates.start,
          dueDate,
          subtotal: amount,
          discountAmount: '0.00',
          penaltyAmount: '0.00',
          totalAmount: amount,
          status: dueDate < new Date().toISOString().slice(0, 10) ? 'OVERDUE' : 'UNPAID',
          finalizedAt: new Date(),
        }).onConflictDoNothing().returning();
        if (!invoice) continue;
        await transaction.insert(invoiceItems).values({
          invoiceId: invoice.id,
          itemType: 'SUBSCRIPTION',
          description: 'Demo monthly subscription',
          quantity: '1.00',
          unitPrice: amount,
          amount,
        });
        await transaction.insert(ledgerEntries).values({
          serviceAccountId: item.account.id,
          invoiceId: invoice.id,
          entryType: 'INVOICE',
          description: `Demo invoice ${invoice.invoiceNumber}`,
          debit: amount,
          credit: '0.00',
          referenceNumber: invoice.invoiceNumber,
        });
      }
    }

    const invoiceRows = await transaction.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      serviceAccountId: invoices.serviceAccountId,
      totalAmount: invoices.totalAmount,
      dueDate: invoices.dueDate,
    }).from(invoices)
      .where(inArray(invoices.invoiceNumber, seeded.accounts.flatMap((account) => (
        months.map((month) => `${demoPrefix}-INV-${month.replace('-', '')}-${account.serviceAccountNumber.slice(-4)}`)
      ))));
    const invoicesByNumber = new Map(invoiceRows.map((invoice) => [invoice.invoiceNumber, invoice]));
    const cyclesForAccount = (index: number) => months.map((month) => {
      const invoiceNumber = `${demoPrefix}-INV-${month.replace('-', '')}-${String(index + 1).padStart(4, '0')}`;
      const invoice = invoicesByNumber.get(invoiceNumber);
      if (!invoice) throw new Error(`Seeded invoice ${invoiceNumber} is missing.`);
      return invoice;
    });
    const touchedInvoiceIds = new Set<number>();

    async function addPayment(input: {
      number: string;
      accountIndex: number;
      amount: string;
      allocations: Array<{ invoiceId: number; amount: string }>;
      note: string;
      reverse?: boolean;
      paymentMethod?: 'Cash' | 'GCash' | 'Bank Transfer';
    }): Promise<void> {
      const [existing] = await transaction.select({ id: payments.id })
        .from(payments)
        .where(eq(payments.paymentNumber, input.number))
        .limit(1);
      if (existing) return;
      const subscriberIndex = input.accountIndex < 50 ? input.accountIndex : input.accountIndex - 50;
      const subscriber = seeded.subscriberRows.find((row) => (
        row.accountNumber === `${demoPrefix}-SUB-${String(subscriberIndex + 1).padStart(4, '0')}`
      ));
      if (!subscriber) throw new Error(`Demo subscriber for payment ${input.number} is missing.`);

      const [payment] = await transaction.insert(payments).values({
        paymentNumber: input.number,
        subscriberId: subscriber.id,
        paymentDate: new Date(`${months[2]}-20T10:00:00.000Z`),
        amount: input.amount,
        paymentMethod: input.paymentMethod ?? 'Cash',
        referenceNumber: `REF-${input.number}`,
        notes: input.note,
        status: 'POSTED',
        receivedBy: cashierIdFor(seeded.usersByUsername),
      }).returning();
      if (!payment) throw new Error(`Could not create demo payment ${input.number}.`);

      for (const allocation of input.allocations) {
        await transaction.insert(paymentAllocations).values({
          paymentId: payment.id,
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
        });
        const invoice = invoiceRows.find((row) => row.id === allocation.invoiceId);
        if (!invoice) throw new Error(`Invoice ${allocation.invoiceId} was not found.`);
        touchedInvoiceIds.add(invoice.id);
        await transaction.insert(ledgerEntries).values({
          serviceAccountId: invoice.serviceAccountId,
          invoiceId: invoice.id,
          paymentId: payment.id,
          entryType: 'PAYMENT',
          description: `Demo payment ${payment.paymentNumber}`,
          debit: '0.00',
          credit: allocation.amount,
          referenceNumber: `PAY-${payment.id}`,
        });
      }

      if (input.reverse) {
        const ownerId = seeded.usersByUsername.get('demo13_owner');
        if (ownerId === undefined) throw new Error('Demo owner is missing.');
        await transaction.insert(paymentReversals).values({
          paymentId: payment.id,
          reason: 'Synthetic demo reversal.',
          reversedBy: ownerId,
        });
        await transaction.update(payments).set({ status: 'REVERSED' }).where(eq(payments.id, payment.id));
        for (const allocation of input.allocations) {
          const invoice = invoiceRows.find((row) => row.id === allocation.invoiceId);
          if (!invoice) throw new Error(`Invoice ${allocation.invoiceId} was not found.`);
          await transaction.insert(ledgerEntries).values({
            serviceAccountId: invoice.serviceAccountId,
            invoiceId: invoice.id,
            paymentId: payment.id,
            entryType: 'PAYMENT_REVERSAL',
            description: `Demo payment ${payment.paymentNumber} reversed`,
            debit: allocation.amount,
            credit: '0.00',
            referenceNumber: `PAY-${payment.id}`,
          });
        }
      }

      await transaction.insert(receipts).values({
        receiptNumber: `${demoPrefix}-RCT-${input.number.slice(-4)}`,
        paymentId: payment.id,
        status: input.reverse ? 'VOID' : 'ACTIVE',
        voidReason: input.reverse ? 'Payment reversed in demo data.' : null,
        voidedBy: input.reverse ? seeded.usersByUsername.get('demo13_owner') ?? null : null,
        voidedAt: input.reverse ? new Date() : null,
      }).onConflictDoNothing();
    }

    const invoiceGroups = Array.from({ length: 60 }, (_, index) => cyclesForAccount(index));
    const latest = (index: number) => invoiceGroups[index][2];
    const oldest = (index: number) => invoiceGroups[index][0];
    const partialAmount = amountFraction(latest(0).totalAmount, 2n, 5n);
    await addPayment({
      number: `${demoPrefix}-PAY-PARTIAL`,
      accountIndex: 0,
      amount: partialAmount,
      allocations: [{ invoiceId: latest(0).id, amount: partialAmount }],
      note: 'Partial payment against the latest invoice.',
      paymentMethod: 'Cash',
    });
    await addPayment({
      number: `${demoPrefix}-PAY-EXACT`,
      accountIndex: 1,
      amount: latest(1).totalAmount,
      allocations: [{ invoiceId: latest(1).id, amount: latest(1).totalAmount }],
      note: 'Exact payment of the latest invoice.',
    });
    const advanceCredit = amountFraction(latest(2).totalAmount, 1n, 2n);
    await addPayment({
      number: `${demoPrefix}-PAY-ADVANCE`,
      accountIndex: 2,
      amount: addCents(latest(2).totalAmount, advanceCredit),
      allocations: [{ invoiceId: latest(2).id, amount: latest(2).totalAmount }],
      note: 'Advance payment with unapplied account credit.',
      paymentMethod: 'Bank Transfer',
    });
    await addPayment({
      number: `${demoPrefix}-PAY-ARREARS`,
      accountIndex: 3,
      amount: oldest(3).totalAmount,
      allocations: [{ invoiceId: oldest(3).id, amount: oldest(3).totalAmount }],
      note: 'Arrears payment allocated to the oldest outstanding invoice.',
    });
    await addPayment({
      number: `${demoPrefix}-PAY-REVERSED`,
      accountIndex: 4,
      amount: latest(4).totalAmount,
      allocations: [{ invoiceId: latest(4).id, amount: latest(4).totalAmount }],
      note: 'Payment retained with a demo reversal record.',
      reverse: true,
    });
    for (let index = 5; index < 15; index += 1) {
      await addPayment({
        number: `${demoPrefix}-PAY-EXACT-${String(index + 1).padStart(2, '0')}`,
        accountIndex: index,
        amount: latest(index).totalAmount,
        allocations: [{ invoiceId: latest(index).id, amount: latest(index).totalAmount }],
        note: 'Exact monthly invoice payment.',
        paymentMethod: index % 2 === 0 ? 'Cash' : 'Bank Transfer',
      });
    }

    for (const invoice of invoiceRows) {
      const postedAllocations = await transaction.select({
        amount: paymentAllocations.amount,
        status: payments.status,
      }).from(paymentAllocations)
        .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
        .where(eq(paymentAllocations.invoiceId, invoice.id));
      const paid = postedAllocations.reduce(
        (sum, allocation) => allocation.status === 'POSTED' ? sum + toCents(allocation.amount) : sum,
        0n,
      );
      const nextStatus = currentStatus(paid, invoice.totalAmount, invoice.dueDate);
      if (touchedInvoiceIds.has(invoice.id)) {
        await transaction.update(invoices)
          .set({ status: nextStatus })
          .where(and(eq(invoices.id, invoice.id), eq(invoices.invoiceNumber, invoice.invoiceNumber)));
      }
    }

    const eventDate = monthDates(months[2]).end;
    await createCollectionFixtures(transaction, seeded, eventDate, cashierIdFor(seeded.usersByUsername));
    await createSuspensionFixtures(transaction, seeded, eventDate);
  });

  const totals = await Promise.all([
    db.select({ id: users.id }).from(users).where(inArray(users.username, demoUsers.map((user) => user.username))),
    db.select({ id: servicePlans.id }).from(servicePlans).where(inArray(servicePlans.planCode, demoPlanSpecs.map((plan) => plan.code))),
    db.select({ id: subscribers.id }).from(subscribers).where(inArray(subscribers.accountNumber, Array.from({ length: 50 }, (_, i) => `${demoPrefix}-SUB-${String(i + 1).padStart(4, '0')}`))),
    db.select({ id: serviceAccounts.id }).from(serviceAccounts).where(inArray(serviceAccounts.serviceAccountNumber, Array.from({ length: 60 }, (_, i) => `${demoPrefix}-SVC-${String(i + 1).padStart(4, '0')}`))),
    db.select({ id: collectionAreas.id }).from(collectionAreas).where(inArray(collectionAreas.areaCode, demoAreas.map((area) => area.areaCode))),
    db.select({ id: billingCycles.id }).from(billingCycles).where(inArray(billingCycles.cycleCode, months.map((month) => `${demoPrefix}-${month.replace('-', '')}`))),
    db.select({ id: invoices.id }).from(invoices).where(inArray(invoices.invoiceNumber, seeded.accounts.flatMap((account) => months.map((month) => `${demoPrefix}-INV-${month.replace('-', '')}-${account.serviceAccountNumber.slice(-4)}`)))),
    db.select({ id: payments.id }).from(payments).where(inArray(payments.paymentNumber, await demoPaymentNumbers())),
    db.select({ id: collectionBatches.id }).from(collectionBatches).where(inArray(collectionBatches.batchNumber, [`${demoPrefix}-BATCH-NORTH`, `${demoPrefix}-BATCH-CENTRAL`])),
    db.select({ id: collectorRemittances.id }).from(collectorRemittances).where(inArray(collectorRemittances.batchId, (await db.select({ id: collectionBatches.id }).from(collectionBatches).where(inArray(collectionBatches.batchNumber, [`${demoPrefix}-BATCH-NORTH`, `${demoPrefix}-BATCH-CENTRAL`]))).map((batch) => batch.id))),
    db.select({ id: suspensionRecords.id }).from(suspensionRecords).where(inArray(suspensionRecords.serviceAccountId, seeded.accounts.slice(56, 59).map((account) => account.id))),
    db.select({ id: reconnectionRecords.id }).from(reconnectionRecords).where(inArray(reconnectionRecords.serviceAccountId, seeded.accounts.slice(57, 59).map((account) => account.id))),
  ]);

  return {
    users: totals[0].length,
    servicePlans: totals[1].length,
    subscribers: totals[2].length,
    serviceAccounts: totals[3].length,
    collectionAreas: totals[4].length,
    billingCycles: totals[5].length,
    invoices: totals[6].length,
    payments: totals[7].length,
    collectionBatches: totals[8].length,
    remittances: totals[9].length,
    suspensions: totals[10].length,
    reconnections: totals[11].length,
  };
}

function cashierIdFor(usersByUsername: Map<string, number>): number {
  const id = usersByUsername.get('demo13_cashier');
  if (id === undefined) throw new Error('Demo cashier is missing.');
  return id;
}

async function demoPaymentNumbers(): Promise<string[]> {
  return [
    `${demoPrefix}-PAY-PARTIAL`,
    `${demoPrefix}-PAY-EXACT`,
    `${demoPrefix}-PAY-ADVANCE`,
    `${demoPrefix}-PAY-ARREARS`,
    `${demoPrefix}-PAY-REVERSED`,
    ...Array.from({ length: 10 }, (_, index) => `${demoPrefix}-PAY-EXACT-${String(index + 6).padStart(2, '0')}`),
    `${demoPrefix}-COLL-PAY-NORTH-CASH`,
    `${demoPrefix}-COLL-PAY-NORTH-NONCASH`,
    `${demoPrefix}-COLL-PAY-CENTRAL-CASH`,
    `${demoPrefix}-COLL-PAY-CENTRAL-NONCASH`,
  ];
}

async function createCollectionFixtures(
  transaction: Parameters<Parameters<NonNullable<typeof db>['transaction']>[0]>[0],
  seeded: SeededMasterData,
  collectionDate: string,
  cashierId: number,
): Promise<void> {
  const supervisorCollectorId = seeded.usersByUsername.get('demo13_collector_north');
  const ownerId = seeded.usersByUsername.get('demo13_owner');
  if (supervisorCollectorId === undefined || ownerId === undefined) throw new Error('Demo collection users are missing.');
  const batchSpecs = [
    { number: `${demoPrefix}-BATCH-NORTH`, areaCode: 'DEMO13-NORTH', collectorId: supervisorCollectorId, accountIndexes: [20, 21] as const, cash: '45.00', nonCash: '25.00' },
    { number: `${demoPrefix}-BATCH-CENTRAL`, areaCode: 'DEMO13-CENTRAL', collectorId: cashierId, accountIndexes: [22, 23] as const, cash: '60.00', nonCash: '35.00' },
  ];
  for (const spec of batchSpecs) {
    const areaId = seeded.areas.find((area) => area.areaCode === spec.areaCode)?.id;
    if (areaId === undefined) throw new Error(`Demo area ${spec.areaCode} is missing.`);
    const [assignment] = await transaction.select({ id: collectorAssignments.id })
      .from(collectorAssignments)
      .where(and(
        eq(collectorAssignments.collectorId, spec.collectorId),
        eq(collectorAssignments.collectionAreaId, areaId),
      )).limit(1);
    if (!assignment) {
      await transaction.insert(collectorAssignments).values({
        collectorId: spec.collectorId,
        collectionAreaId: areaId,
        assignedFrom: collectionDate,
        status: 'ACTIVE',
      });
    }

    const [existingBatch] = await transaction.select({ id: collectionBatches.id })
      .from(collectionBatches).where(eq(collectionBatches.batchNumber, spec.number)).limit(1);
    if (existingBatch) continue;
    const [batch] = await transaction.insert(collectionBatches).values({
      batchNumber: spec.number,
      collectorId: spec.collectorId,
      collectionAreaId: areaId,
      collectionDate,
      status: 'RECONCILED',
      expectedCash: spec.cash,
      expectedNonCash: spec.nonCash,
      notes: 'Synthetic demo collection and remittance.',
    }).returning();
    if (!batch) throw new Error(`Could not create demo batch ${spec.number}.`);
    const collectedAmounts = [spec.cash, spec.nonCash];
    const methods = ['Cash', 'Bank Transfer'] as const;
    for (let index = 0; index < spec.accountIndexes.length; index += 1) {
      const account = seeded.accounts[spec.accountIndexes[index]];
      if (!account) throw new Error(`Demo collection service account is missing for ${spec.number}.`);
      const [subscriber] = await transaction.select({ id: subscribers.id })
        .from(subscribers).where(eq(subscribers.id, account.subscriberId)).limit(1);
      if (!subscriber) throw new Error('Demo collection subscriber is missing.');
      const amount = collectedAmounts[index];
      const [payment] = await transaction.insert(payments).values({
        paymentNumber: `${demoPrefix}-COLL-PAY-${spec.number.endsWith('NORTH') ? 'NORTH' : 'CENTRAL'}-${index === 0 ? 'CASH' : 'NONCASH'}`,
        subscriberId: subscriber.id,
        paymentDate: new Date(`${collectionDate}T10:00:00.000Z`),
        amount,
        paymentMethod: methods[index],
        referenceNumber: `REF-${demoPrefix}-${spec.number}-${index + 1}`,
        notes: 'Collection batch payment recorded for training.',
        status: 'POSTED',
        receivedBy: spec.collectorId,
      }).onConflictDoNothing().returning();
      if (!payment) continue;
      await transaction.insert(batchAccounts).values({
        batchId: batch.id,
        serviceAccountId: account.id,
        expectedAmount: amount,
        collectedAmount: amount,
        status: 'PAID',
      });
      await transaction.insert(ledgerEntries).values({
        serviceAccountId: account.id,
        paymentId: payment.id,
        entryType: 'COLLECTION',
        description: `Demo collection received for batch ${batch.id}`,
        debit: '0.00',
        credit: amount,
        referenceNumber: `BATCH-${batch.id}`,
      });
    }
    await transaction.insert(collectorRemittances).values({
      batchId: batch.id,
      remittanceDate: new Date(`${collectionDate}T16:00:00.000Z`),
      expectedCash: spec.cash,
      remittedCash: spec.cash,
      difference: '0.00',
      receivedBy: ownerId,
      status: 'RECONCILED',
    });
  }
}

async function createSuspensionFixtures(
  transaction: Parameters<Parameters<NonNullable<typeof db>['transaction']>[0]>[0],
  seeded: SeededMasterData,
  eventDate: string,
): Promise<void> {
  const ownerId = seeded.usersByUsername.get('demo13_owner');
  const technicianId = seeded.usersByUsername.get('demo13_technician');
  if (ownerId === undefined || technicianId === undefined) throw new Error('Demo lifecycle users are missing.');
  for (const accountIndex of [56, 57, 58]) {
    const account = seeded.accounts[accountIndex];
    if (!account) throw new Error('Demo lifecycle service account is missing.');
    const [existing] = await transaction.select({ id: suspensionRecords.id })
      .from(suspensionRecords)
      .where(and(
        eq(suspensionRecords.serviceAccountId, account.id),
        eq(suspensionRecords.reason, 'Demo overdue suspension'),
      )).limit(1);
    if (existing) continue;
    const [suspension] = await transaction.insert(suspensionRecords).values({
      serviceAccountId: account.id,
      suspensionDate: eventDate,
      reason: 'Demo overdue suspension',
      approvedBy: ownerId,
      notes: 'Demo13 lifecycle fixture.',
      status: accountIndex === 56 ? 'ACTIVE' : 'RECONNECTED',
    }).returning();
    if (!suspension) throw new Error('Could not create a demo suspension record.');
    if (accountIndex === 56) {
      await transaction.update(serviceAccounts).set({ status: 'SUSPENDED' })
        .where(eq(serviceAccounts.id, account.id));
      continue;
    }
    await transaction.insert(reconnectionRecords).values({
      serviceAccountId: account.id,
      suspensionId: suspension.id,
      requestDate: eventDate,
      completionDate: eventDate,
      reconnectionFee: '75.00',
      requestedBy: ownerId,
      technicianId,
      status: 'COMPLETED',
      notes: 'Demo service restoration completed.',
    });
    await transaction.update(serviceAccounts).set({ status: 'ACTIVE' })
      .where(eq(serviceAccounts.id, account.id));
  }
}

async function runDemoSeedCli(): Promise<void> {
  if (process.env.BCIS_DEMO_SEED !== 'true') {
    throw new Error('Set BCIS_DEMO_SEED=true to enable demo data seeding.');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Demo data seeding is disabled when NODE_ENV=production.');
  }
  if (!await initializeDatabase() || !db) {
    throw new Error('Could not connect to PostgreSQL; demo data was not seeded.');
  }
  try {
    const counts = await seedDemoData();
    console.log('Demo data seed completed:', JSON.stringify(counts));
  } finally {
    await closeDatabase();
  }
}

if (require.main === module) {
  void runDemoSeedCli().catch((error: unknown) => {
    console.error('Demo data seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

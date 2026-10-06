import assert from 'node:assert/strict';
import { randomUUID, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { after, before, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import {
  auditLogs,
  billingCycles,
  collectionAreas,
  collectorAssignments,
  collectionBatches,
  batchAccounts,
  collectorRemittances,
  reconnectionRecords,
  suspensionRecords,
  invoiceAdjustments,
  invoiceItems,
  invoices,
  ledgerEntries,
  paymentAllocations,
  paymentProofs,
  paymentReversals,
  payments,
  receipts,
  roles,
  serviceAccounts,
  serviceEvents,
  servicePlans,
  serviceTypes,
  subscriberAddresses,
  subscriberContacts,
  subscribers,
  userRoles,
  users,
} from '../db/schema';
import { authRoutes } from '../src/routes/auth';
import { auditRoutes } from '../src/routes/audit';
import { billingCycleRoutes } from '../src/routes/billing-cycles';
import { billingGenerationRoutes } from '../src/routes/billing-generation';
import { collectionRoutes } from '../src/routes/collections';
import { invoiceDetailRoutes } from '../src/routes/invoice-details';
import { invoiceRoutes } from '../src/routes/invoices';
import { ledgerRoutes } from '../src/routes/ledger';
import { paymentAllocationRoutes } from '../src/routes/payment-allocations';
import { paymentRoutes } from '../src/routes/payments';
import { receivableRoutes } from '../src/routes/receivables';
import { receiptRoutes } from '../src/routes/receipts';
import { suspensionRoutes } from '../src/routes/suspension';
import { subscriberRoutes } from '../src/routes/subscribers';
import { serviceAccountRoutes } from '../src/routes/service-accounts';
import { serviceEventRoutes } from '../src/routes/service-events';
import { seedDemoData } from '../src/seed-demo';
import {
  authSessions,
  ensureDemoAdmin,
  hashPassword,
  verifyPassword,
} from '../src/lib/auth';
import {
  closeDatabase,
  db,
  initializeDatabase,
} from '../src/lib/db';

const usernameSuffix = randomUUID().slice(0, 8);
const usernames = [
  `phase5_owner_${usernameSuffix}`,
  `phase5_inactive_${usernameSuffix}`,
  `phase5_legacy_${usernameSuffix}`,
];
const testPassword = 'Synthetic123!';

function moneyToCents(value: string): bigint {
  const [whole, fractional = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0'));
}

const testUserIds: number[] = [];
const issuedTokens: string[] = [];
const masterDataIds: {
  serviceTypeId?: number;
  collectionAreaId?: number;
  servicePlanId?: number;
  subscriberId?: number;
  addressId?: number;
  contactId?: number;
  serviceAccountId?: number;
  inactiveServiceAccountId?: number;
} = {};
const billingCycleIds: number[] = [];
const paymentCycleIds: number[] = [];
const paymentInvoiceIds: number[] = [];
const paymentIds: number[] = [];
const collectionAssignmentIds: number[] = [];
const collectionBatchIds: number[] = [];
const collectionPaymentIds: number[] = [];
const receivableCycleIds: number[] = [];
const receivableInvoiceIds: number[] = [];
const receivablePaymentIds: number[] = [];
const suspensionRecordIds: number[] = [];
const reconnectionRecordIds: number[] = [];
const phase12AuditIds: number[] = [];
const phase12ReceiptIds: number[] = [];
let app: Fastify.FastifyInstance | undefined;
let databaseAvailable = false;
let ownerRoleId = 0;

before(async () => {
  databaseAvailable = await initializeDatabase();
  if (!databaseAvailable || !db) {
    return;
  }

  const database = db;
  await ensureDemoAdmin();

  const [ownerRole] = await database
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'OWNER'))
    .limit(1);

  if (!ownerRole) {
    throw new Error('OWNER role is unavailable for auth tests.');
  }
  ownerRoleId = ownerRole.id;

  const legacyHash = pbkdf2Sync(
    'LegacyPass123!',
    'bcis-salt-v1',
    100000,
    64,
    'sha512',
  ).toString('hex');

  const insertedUsers = await database
    .insert(users)
    .values([
      {
        username: usernames[0],
        passwordHash: hashPassword(testPassword),
        fullName: 'Synthetic Test Owner',
        email: null,
        status: 'ACTIVE',
      },
      {
        username: usernames[1],
        passwordHash: hashPassword(testPassword),
        fullName: 'Synthetic Inactive User',
        email: null,
        status: 'INACTIVE',
      },
      {
        username: usernames[2],
        passwordHash: legacyHash,
        fullName: 'Synthetic Legacy User',
        email: null,
        status: 'ACTIVE',
      },
    ])
    .returning({ id: users.id });

  testUserIds.push(...insertedUsers.map((user) => user.id));
  await database.insert(userRoles).values(
    testUserIds.map((userId) => ({ userId, roleId: ownerRole.id })),
  );

  app = Fastify();
  await app.register(authRoutes);
  await app.register(auditRoutes);
  await app.register(subscriberRoutes);
  await app.register(serviceAccountRoutes);
  await app.register(serviceEventRoutes);
  await app.register(billingCycleRoutes);
  await app.register(billingGenerationRoutes);
  await app.register(invoiceRoutes);
  await app.register(invoiceDetailRoutes);
  await app.register(ledgerRoutes);
  await app.register(paymentRoutes);
  await app.register(paymentAllocationRoutes);
  await app.register(collectionRoutes);
  await app.register(suspensionRoutes);
  await app.register(receivableRoutes);
  await app.register(receiptRoutes);
  await app.ready();
});

after(async () => {
  if (app) {
    await app.close();
  }

  for (const token of issuedTokens) {
    authSessions.delete(token);
  }

  if (db && testUserIds.length > 0) {
    const database = db;
    if (phase12ReceiptIds.length > 0) {
      await database.delete(receipts).where(inArray(receipts.id, phase12ReceiptIds));
    }
    if (paymentIds.length > 0) {
      await database.delete(paymentAllocations).where(inArray(paymentAllocations.paymentId, paymentIds));
      await database.delete(ledgerEntries).where(inArray(ledgerEntries.paymentId, paymentIds));
      await database.delete(paymentProofs).where(inArray(paymentProofs.paymentId, paymentIds));
      await database.delete(paymentReversals).where(inArray(paymentReversals.paymentId, paymentIds));
      await database.delete(payments).where(inArray(payments.id, paymentIds));
    }
    if (collectionPaymentIds.length > 0) {
      await database.delete(ledgerEntries).where(inArray(ledgerEntries.paymentId, collectionPaymentIds));
      await database.delete(payments).where(inArray(payments.id, collectionPaymentIds));
    }
    if (collectionBatchIds.length > 0) {
      await database.delete(collectorRemittances).where(inArray(collectorRemittances.batchId, collectionBatchIds));
      await database.delete(batchAccounts).where(inArray(batchAccounts.batchId, collectionBatchIds));
      await database.delete(collectionBatches).where(inArray(collectionBatches.id, collectionBatchIds));
    }
    if (collectionAssignmentIds.length > 0) {
      await database.delete(collectorAssignments).where(inArray(collectorAssignments.id, collectionAssignmentIds));
    }
    if (reconnectionRecordIds.length > 0) {
      await database.delete(reconnectionRecords).where(inArray(reconnectionRecords.id, reconnectionRecordIds));
    }
    if (phase12AuditIds.length > 0) {
      await database.delete(auditLogs).where(inArray(auditLogs.id, phase12AuditIds));
    }
    if (suspensionRecordIds.length > 0) {
      await database.delete(suspensionRecords).where(inArray(suspensionRecords.id, suspensionRecordIds));
    }
    if (receivablePaymentIds.length > 0) {
      await database.delete(paymentAllocations).where(inArray(paymentAllocations.paymentId, receivablePaymentIds));
      await database.delete(ledgerEntries).where(inArray(ledgerEntries.paymentId, receivablePaymentIds));
      await database.delete(payments).where(inArray(payments.id, receivablePaymentIds));
    }
    if (receivableInvoiceIds.length > 0) {
      await database.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, receivableInvoiceIds));
      await database.delete(invoiceAdjustments).where(inArray(invoiceAdjustments.invoiceId, receivableInvoiceIds));
      await database.delete(ledgerEntries).where(inArray(ledgerEntries.invoiceId, receivableInvoiceIds));
      await database.delete(invoices).where(inArray(invoices.id, receivableInvoiceIds));
    }
    if (receivableCycleIds.length > 0) {
      await database.delete(billingCycles).where(inArray(billingCycles.id, receivableCycleIds));
    }
    if (paymentInvoiceIds.length > 0) {
      await database.delete(paymentAllocations).where(inArray(paymentAllocations.invoiceId, paymentInvoiceIds));
      await database.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, paymentInvoiceIds));
      await database.delete(invoiceAdjustments).where(inArray(invoiceAdjustments.invoiceId, paymentInvoiceIds));
      await database.delete(ledgerEntries).where(inArray(ledgerEntries.invoiceId, paymentInvoiceIds));
      await database.delete(invoices).where(inArray(invoices.id, paymentInvoiceIds));
    }
    if (paymentCycleIds.length > 0) {
      await database.delete(billingCycles).where(inArray(billingCycles.id, paymentCycleIds));
    }
    if (billingCycleIds.length > 0) {
      const generatedInvoices = await database.select({ id: invoices.id })
        .from(invoices).where(inArray(invoices.billingCycleId, billingCycleIds));
      const generatedInvoiceIds = generatedInvoices.map((invoice) => invoice.id);
      if (generatedInvoiceIds.length > 0) {
        await database.delete(paymentAllocations).where(inArray(paymentAllocations.invoiceId, generatedInvoiceIds));
        await database.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, generatedInvoiceIds));
        await database.delete(invoiceAdjustments).where(inArray(invoiceAdjustments.invoiceId, generatedInvoiceIds));
        await database.delete(ledgerEntries).where(inArray(ledgerEntries.invoiceId, generatedInvoiceIds));
        await database.delete(invoices).where(inArray(invoices.id, generatedInvoiceIds));
      }
      await database.delete(billingCycles).where(inArray(billingCycles.id, billingCycleIds));
    }
    if (masterDataIds.serviceAccountId) {
      await database.delete(serviceEvents).where(eq(serviceEvents.serviceAccountId, masterDataIds.serviceAccountId));
      await database.delete(serviceAccounts).where(eq(serviceAccounts.id, masterDataIds.serviceAccountId));
    }
    if (masterDataIds.inactiveServiceAccountId) {
      await database.delete(serviceAccounts).where(eq(serviceAccounts.id, masterDataIds.inactiveServiceAccountId));
    }
    if (masterDataIds.addressId) {
      await database.delete(subscriberAddresses).where(eq(subscriberAddresses.id, masterDataIds.addressId));
    }
    if (masterDataIds.contactId) {
      await database.delete(subscriberContacts).where(eq(subscriberContacts.id, masterDataIds.contactId));
    }
    if (masterDataIds.subscriberId) {
      await database.delete(subscribers).where(eq(subscribers.id, masterDataIds.subscriberId));
    }
    if (masterDataIds.servicePlanId) {
      await database.delete(servicePlans).where(eq(servicePlans.id, masterDataIds.servicePlanId));
    }
    if (masterDataIds.collectionAreaId) {
      await database.delete(collectionAreas).where(eq(collectionAreas.id, masterDataIds.collectionAreaId));
    }
    if (masterDataIds.serviceTypeId) {
      await database.delete(serviceTypes).where(eq(serviceTypes.id, masterDataIds.serviceTypeId));
    }
    await database.delete(auditLogs).where(inArray(auditLogs.userId, testUserIds));
    await database.delete(userRoles).where(inArray(userRoles.userId, testUserIds));
    await database.delete(users).where(inArray(users.id, testUserIds));
  }

  await closeDatabase();
});

test('authentication and role authorization behavior', async (context) => {
  if (!databaseAvailable || !app || !db) {
    context.skip('PostgreSQL is unavailable for auth integration tests.');
    return;
  }

  const database = db;
  assert.equal(verifyPassword(testPassword, hashPassword(testPassword)), true);
  assert.equal(verifyPassword('WrongPass123!', hashPassword(testPassword)), false);

  const legacyHash = pbkdf2Sync(
    'LegacyPass123!',
    'bcis-salt-v1',
    100000,
    64,
    'sha512',
  ).toString('hex');
  assert.equal(verifyPassword('LegacyPass123!', legacyHash), true);

  const validLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(validLogin.statusCode, 200);
  const validToken = validLogin.json().data.token as string;
  issuedTokens.push(validToken);

  const invalidPassword = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: 'WrongPass123!' },
  });
  assert.equal(invalidPassword.statusCode, 401);

  const inactiveLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[1], password: testPassword },
  });
  assert.equal(inactiveLogin.statusCode, 403);

  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users' })).statusCode, 401);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/users',
    headers: { authorization: 'Bearer invalid-token' },
  })).statusCode, 401);

  const userList = await app.inject({
    method: 'GET',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${validToken}` },
  });
  assert.equal(userList.statusCode, 200);
  assert.ok(userList.json().data.every((user: Record<string, unknown>) => !('passwordHash' in user)));

  const cashierToken = `phase5-cashier-${usernameSuffix}`;
  issuedTokens.push(cashierToken);
  authSessions.set(cashierToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Test Owner',
    role: 'CASHIER',
    expiresAt: Date.now() + 60_000,
  });
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${cashierToken}` },
  })).statusCode, 403);

  const expiredToken = `phase5-expired-${usernameSuffix}`;
  issuedTokens.push(expiredToken);
  authSessions.set(expiredToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Test Owner',
    role: 'OWNER',
    expiresAt: Date.now() - 1,
  });
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${expiredToken}` },
  })).statusCode, 401);

  const logout = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { authorization: `Bearer ${validToken}` },
  });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${validToken}` },
  })).statusCode, 401);

  const legacyLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[2], password: 'LegacyPass123!' },
  });
  assert.equal(legacyLogin.statusCode, 200);
  const [upgradedUser] = await database
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, testUserIds[2]))
    .limit(1);
  assert.ok(upgradedUser?.passwordHash.startsWith('pbkdf2-sha512$'));
  assert.equal(verifyPassword('LegacyPass123!', upgradedUser!.passwordHash), true);

  const roleChangeLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(roleChangeLogin.statusCode, 200);
  const roleChangeToken = roleChangeLogin.json().data.token as string;
  issuedTokens.push(roleChangeToken);

  const roleUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/users/${testUserIds[0]}/role`,
    headers: { authorization: `Bearer ${roleChangeToken}` },
    payload: { roleId: ownerRoleId },
  });
  assert.equal(roleUpdate.statusCode, 200);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${roleChangeToken}` },
  })).statusCode, 401);
});

test('subscriber master-data workflow reaches service events', async (context) => {
  if (!databaseAvailable || !app || !db) {
    context.skip('PostgreSQL is unavailable for master-data integration tests.');
    return;
  }

  const tokenResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(tokenResponse.statusCode, 200);
  const token = tokenResponse.json().data.token as string;
  issuedTokens.push(token);
  const authHeaders = { authorization: `Bearer ${token}` };
  const suffix = randomUUID().slice(0, 8).toUpperCase();

  const serviceTypeResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/service-types',
    headers: authHeaders,
    payload: { name: `Test Internet ${suffix}`, description: 'Synthetic test type' },
  });
  assert.equal(serviceTypeResponse.statusCode, 201);
  masterDataIds.serviceTypeId = serviceTypeResponse.json().data.id;

  const serviceTypeUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/service-types/${masterDataIds.serviceTypeId}`,
    headers: authHeaders,
    payload: { description: 'Updated synthetic service type' },
  });
  assert.equal(serviceTypeUpdate.statusCode, 200);

  const areaResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/collection-areas',
    headers: authHeaders,
    payload: { areaCode: `T-${suffix}`, areaName: `Test Area ${suffix}` },
  });
  assert.equal(areaResponse.statusCode, 201);
  masterDataIds.collectionAreaId = areaResponse.json().data.id;

  const areaUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/collection-areas/${masterDataIds.collectionAreaId}`,
    headers: authHeaders,
    payload: { description: 'Updated synthetic collection area' },
  });
  assert.equal(areaUpdate.statusCode, 200);

  const rolesResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/roles',
    headers: authHeaders,
  });
  assert.equal(rolesResponse.statusCode, 200);
  for (const roleName of [
    'OWNER',
    'ADMINISTRATOR',
    'CASHIER',
    'COLLECTION_SUPERVISOR',
    'ACCOUNTING_AUDITOR',
    'TECHNICIAN',
    'VIEWER',
  ]) {
    assert.ok(rolesResponse.json().data.some((role: { name: string }) => role.name === roleName));
  }

  const planResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/service-plans',
    headers: authHeaders,
    payload: {
      serviceTypeId: masterDataIds.serviceTypeId,
      planCode: `TP-${suffix}`,
      planName: `Test Plan ${suffix}`,
      price: '1200.00',
      installationFee: '500.00',
      reconnectionFee: '100.00',
    },
  });
  assert.equal(planResponse.statusCode, 201);
  masterDataIds.servicePlanId = planResponse.json().data.id;

  const subscriberResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/subscribers',
    headers: authHeaders,
    payload: {
      accountNumber: `TST-${suffix}`,
      firstName: 'Synthetic',
      lastName: `Subscriber ${suffix}`,
      contactNumber: '09000000000',
      collectionAreaId: masterDataIds.collectionAreaId,
    },
  });
  assert.equal(subscriberResponse.statusCode, 201);
  masterDataIds.subscriberId = subscriberResponse.json().data.id;

  const addressResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/subscribers/${masterDataIds.subscriberId}/addresses`,
    headers: authHeaders,
    payload: {
      addressLine: '100 Synthetic Test Road',
      barangay: 'Demo',
      city: 'Test City',
      province: 'Bukidnon',
      isPrimary: true,
    },
  });
  assert.equal(addressResponse.statusCode, 201);
  masterDataIds.addressId = addressResponse.json().data.id;

  const addressUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/subscribers/${masterDataIds.subscriberId}/addresses/${masterDataIds.addressId}`,
    headers: authHeaders,
    payload: { addressLine: 'Updated Synthetic Test Road' },
  });
  assert.equal(addressUpdate.statusCode, 200);

  const contactResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/subscribers/${masterDataIds.subscriberId}/contacts`,
    headers: authHeaders,
    payload: { contactType: 'PHONE', contactValue: '09000000000', isPrimary: true },
  });
  assert.equal(contactResponse.statusCode, 201);
  masterDataIds.contactId = contactResponse.json().data.id;

  const contactUpdate = await app.inject({
    method: 'PUT',
    url: `/api/v1/subscribers/${masterDataIds.subscriberId}/contacts/${masterDataIds.contactId}`,
    headers: authHeaders,
    payload: { contactValue: '09000000001' },
  });
  assert.equal(contactUpdate.statusCode, 200);

  const accountResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/service-accounts',
    headers: authHeaders,
    payload: {
      serviceAccountNumber: `SA-${suffix}`,
      subscriberId: masterDataIds.subscriberId,
      planId: masterDataIds.servicePlanId,
      installationAddressId: masterDataIds.addressId,
      activationDate: '2026-10-06',
      billingStartDate: '2026-10-06',
      billingDay: 1,
      dueDay: 15,
      currentRate: '1200.00',
    },
  });
  assert.equal(accountResponse.statusCode, 201);
  masterDataIds.serviceAccountId = accountResponse.json().data.id;

  const inactiveAccountResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/service-accounts',
    headers: authHeaders,
    payload: {
      serviceAccountNumber: `SAI-${suffix}`,
      subscriberId: masterDataIds.subscriberId,
      planId: masterDataIds.servicePlanId,
      installationAddressId: masterDataIds.addressId,
      billingStartDate: '2026-10-06',
      billingDay: 1,
      dueDay: 15,
      currentRate: '1200.00',
      status: 'INACTIVE',
    },
  });
  assert.equal(inactiveAccountResponse.statusCode, 201);
  masterDataIds.inactiveServiceAccountId = inactiveAccountResponse.json().data.id;

  const eventResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/service-events',
    headers: authHeaders,
    payload: {
      serviceAccountId: masterDataIds.serviceAccountId,
      eventType: 'ACTIVATED',
      description: 'Synthetic workflow verification',
    },
  });
  assert.equal(eventResponse.statusCode, 201);

  const eventsResponse = await app.inject({
    method: 'GET',
    url: `/api/v1/service-events?serviceAccountId=${masterDataIds.serviceAccountId}`,
    headers: authHeaders,
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.ok(eventsResponse.json().data.some((event: { eventType: string }) => event.eventType === 'ACTIVATED'));

  const subscriberDetail = await app.inject({
    method: 'GET',
    url: `/api/v1/subscribers/${masterDataIds.subscriberId}`,
    headers: authHeaders,
  });
  assert.equal(subscriberDetail.statusCode, 200);
  assert.equal(subscriberDetail.json().data.addresses.length, 1);
  assert.equal(subscriberDetail.json().data.contacts.length, 1);

  const accountDetail = await app.inject({
    method: 'GET',
    url: `/api/v1/service-accounts/${masterDataIds.serviceAccountId}`,
    headers: authHeaders,
  });
  assert.equal(accountDetail.statusCode, 200);
  assert.equal(accountDetail.json().data.planName, `Test Plan ${suffix}`);
  assert.equal(accountDetail.json().data.subscriberAccountNumber, `TST-${suffix}`);
});

test('billing generation is idempotent, exact, ledgered, and transactional', async (context) => {
  if (!databaseAvailable || !app || !db || !masterDataIds.serviceAccountId || !masterDataIds.inactiveServiceAccountId) {
    context.skip('PostgreSQL or master-data workflow fixtures are unavailable.');
    return;
  }

  const database = db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(login.statusCode, 200);
  const token = login.json().data.token as string;
  issuedTokens.push(token);
  const authHeaders = { authorization: `Bearer ${token}` };

  const activeAccounts = await database
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .innerJoin(servicePlans, eq(serviceAccounts.planId, servicePlans.id))
    .where(and(
      eq(serviceAccounts.status, 'ACTIVE'),
      eq(servicePlans.status, 'ACTIVE'),
    ));
  assert.ok(activeAccounts.some((account) => account.id === masterDataIds.serviceAccountId));
  assert.ok(!activeAccounts.some((account) => account.id === masterDataIds.inactiveServiceAccountId));

  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const cycleResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/billing-cycles',
    headers: authHeaders,
    payload: {
      cycleCode: `TST-${suffix}`,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      dueDate: '2026-11-15',
    },
  });
  assert.equal(cycleResponse.statusCode, 201);
  const cycleId = cycleResponse.json().data.id as number;
  billingCycleIds.push(cycleId);

  const cashierToken = `phase7-cashier-${randomUUID().slice(0, 8)}`;
  issuedTokens.push(cashierToken);
  authSessions.set(cashierToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Test Owner',
    role: 'CASHIER',
    expiresAt: Date.now() + 60_000,
  });
  const unauthorizedGeneration = await app.inject({
    method: 'POST',
    url: '/api/v1/billing/generate',
    headers: { authorization: `Bearer ${cashierToken}` },
    payload: { billingCycleId: cycleId },
  });
  assert.equal(unauthorizedGeneration.statusCode, 403);

  const concurrentGenerations = await Promise.all([1, 2].map(() => app!.inject({
    method: 'POST',
    url: '/api/v1/billing/generate',
    headers: authHeaders,
    payload: { billingCycleId: cycleId },
  })));
  assert.ok(concurrentGenerations.every((response) => response.statusCode === 200));
  assert.equal(concurrentGenerations.reduce(
    (total, response) => total + response.json().data.created,
    0,
  ), activeAccounts.length);
  assert.equal(concurrentGenerations.reduce(
    (total, response) => total + response.json().data.skipped,
    0,
  ), activeAccounts.length);
  const generatedRows = await database.select({ id: invoices.id })
    .from(invoices).where(eq(invoices.billingCycleId, cycleId));
  assert.equal(generatedRows.length, activeAccounts.length);

  const [generatedInvoice] = await database.select().from(invoices).where(and(
    eq(invoices.billingCycleId, cycleId),
    eq(invoices.serviceAccountId, masterDataIds.serviceAccountId),
  )).limit(1);
  assert.ok(generatedInvoice);
  assert.equal(generatedInvoice.status, 'UNPAID');
  assert.equal(moneyToCents(generatedInvoice.subtotal), 120000n);
  assert.equal(moneyToCents(generatedInvoice.totalAmount), 120000n);

  const invoiceItemsResponse = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${generatedInvoice.id}/items`,
    headers: authHeaders,
  });
  assert.equal(invoiceItemsResponse.statusCode, 200);
  assert.equal(invoiceItemsResponse.json().data.length, 1);
  assert.equal(invoiceItemsResponse.json().data[0].itemType, 'SUBSCRIPTION');
  assert.equal(moneyToCents(invoiceItemsResponse.json().data[0].amount), 120000n);

  const invoiceRead = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${generatedInvoice.id}`,
    headers: authHeaders,
  });
  assert.equal(invoiceRead.statusCode, 200);
  assert.equal(moneyToCents(invoiceRead.json().data.amountPaid), 0n);
  assert.equal(moneyToCents(invoiceRead.json().data.balance), 120000n);

  const ledgerForInvoice = await database.select().from(ledgerEntries)
    .where(eq(ledgerEntries.invoiceId, generatedInvoice.id));
  assert.equal(ledgerForInvoice.length, 1);
  assert.equal(ledgerForInvoice[0].entryType, 'INVOICE');
  assert.equal(moneyToCents(ledgerForInvoice[0].debit), 120000n);

  const inactiveAccountInvoice = await database.select({ id: invoices.id }).from(invoices).where(and(
    eq(invoices.billingCycleId, cycleId),
    eq(invoices.serviceAccountId, masterDataIds.inactiveServiceAccountId),
  )).limit(1);
  assert.equal(inactiveAccountInvoice.length, 0);

  const repeatedGeneration = await app.inject({
    method: 'POST',
    url: '/api/v1/billing/generate',
    headers: authHeaders,
    payload: { billingCycleId: cycleId },
  });
  assert.equal(repeatedGeneration.statusCode, 200);
  assert.equal(repeatedGeneration.json().data.created, 0);
  assert.equal(repeatedGeneration.json().data.skipped, activeAccounts.length);

  const failureCycleResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/billing-cycles',
    headers: authHeaders,
    payload: {
      cycleCode: `FAIL-${suffix}`,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      dueDate: '2026-12-15',
    },
  });
  assert.equal(failureCycleResponse.statusCode, 201);
  const failureCycleId = failureCycleResponse.json().data.id as number;
  billingCycleIds.push(failureCycleId);

  const draftInvoiceResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/invoices',
    headers: authHeaders,
    payload: {
      invoiceNumber: `DRAFT-${suffix}`,
      serviceAccountId: masterDataIds.inactiveServiceAccountId,
      billingCycleId: failureCycleId,
      invoiceDate: '2026-11-01',
      dueDate: '2026-12-15',
      subtotal: '0.00',
      totalAmount: '0.00',
      status: 'DRAFT',
    },
  });
  assert.equal(draftInvoiceResponse.statusCode, 201);
  const draftInvoiceId = draftInvoiceResponse.json().data.id as number;

  const draftItemResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${draftInvoiceId}/items`,
    headers: authHeaders,
    payload: {
      itemType: 'SUBSCRIPTION',
      description: 'Synthetic draft subscription',
      quantity: '1.00',
      unitPrice: '100.00',
      amount: '100.00',
    },
  });
  assert.equal(draftItemResponse.statusCode, 201);

  const discountResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${draftInvoiceId}/adjustments`,
    headers: authHeaders,
    payload: { adjustmentType: 'DISCOUNT', amount: '10.00', reason: 'Synthetic test discount' },
  });
  assert.equal(discountResponse.statusCode, 201);

  const adjustedDraft = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${draftInvoiceId}`,
    headers: authHeaders,
  });
  assert.equal(adjustedDraft.statusCode, 200);
  assert.equal(moneyToCents(adjustedDraft.json().data.subtotal), 10000n);
  assert.equal(moneyToCents(adjustedDraft.json().data.discountAmount), 1000n);
  assert.equal(moneyToCents(adjustedDraft.json().data.totalAmount), 9000n);

  const negativeTotalAdjustment = await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${draftInvoiceId}/adjustments`,
    headers: authHeaders,
    payload: { adjustmentType: 'DISCOUNT', amount: '200.00', reason: 'Would make invoice total negative' },
  });
  assert.equal(negativeTotalAdjustment.statusCode, 409);
  const unchangedAfterRejectedAdjustment = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${draftInvoiceId}`,
    headers: authHeaders,
  });
  assert.equal(moneyToCents(unchangedAfterRejectedAdjustment.json().data.totalAmount), 9000n);
  const savedAdjustments = await database.select({ id: invoiceAdjustments.id })
    .from(invoiceAdjustments).where(eq(invoiceAdjustments.invoiceId, draftInvoiceId));
  assert.equal(savedAdjustments.length, 1);

  await database.$client.query('DROP TRIGGER IF EXISTS phase7_fail_invoice_ledger ON ledger_entries');
  await database.$client.query('DROP FUNCTION IF EXISTS phase7_fail_invoice_ledger()');
  await database.$client.query(`
    CREATE FUNCTION phase7_fail_invoice_ledger() RETURNS trigger AS $phase7$
    BEGIN
      IF NEW.entry_type = 'INVOICE' THEN
        RAISE EXCEPTION 'forced Phase 7 transaction rollback test';
      END IF;
      RETURN NEW;
    END;
    $phase7$ LANGUAGE plpgsql
  `);
  await database.$client.query('CREATE TRIGGER phase7_fail_invoice_ledger BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION phase7_fail_invoice_ledger()');

  try {
    const failedGeneration = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/generate',
      headers: authHeaders,
      payload: { billingCycleId: failureCycleId },
    });
    assert.equal(failedGeneration.statusCode, 500);
    const rolledBackInvoices = await database.select({ id: invoices.id }).from(invoices).where(and(
      eq(invoices.billingCycleId, failureCycleId),
      eq(invoices.serviceAccountId, masterDataIds.serviceAccountId!),
    ));
    assert.equal(rolledBackInvoices.length, 0);
  } finally {
    await database.$client.query('DROP TRIGGER IF EXISTS phase7_fail_invoice_ledger ON ledger_entries');
    await database.$client.query('DROP FUNCTION IF EXISTS phase7_fail_invoice_ledger()');
  }
});

test('payment workflow preserves exact balances, allocation order, audit, and ledger', async (context) => {
  if (!databaseAvailable || !app || !db || !masterDataIds.subscriberId || !masterDataIds.serviceAccountId) {
    context.skip('PostgreSQL or master-data workflow fixtures are unavailable.');
    return;
  }

  const database = db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(login.statusCode, 200);
  const ownerToken = login.json().data.token as string;
  issuedTokens.push(ownerToken);
  const authHeaders = { authorization: `Bearer ${ownerToken}` };
  const suffix = randomUUID().slice(0, 8).toUpperCase();

  const viewerToken = `phase8-viewer-${suffix}`;
  issuedTokens.push(viewerToken);
  authSessions.set(viewerToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Viewer',
    role: 'VIEWER',
    expiresAt: Date.now() + 60_000,
  });
  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    payload: {
      subscriberId: masterDataIds.subscriberId,
      amount: '1.00',
      paymentMethod: 'CASH',
    },
  });
  assert.equal(unauthorized.statusCode, 401);
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: {
      subscriberId: masterDataIds.subscriberId,
      amount: '1.00',
      paymentMethod: 'CASH',
    },
  });
  assert.equal(forbidden.statusCode, 403);

  const invalidPrecision = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: authHeaders,
    payload: {
      subscriberId: masterDataIds.subscriberId,
      amount: '1.001',
      paymentMethod: 'CASH',
    },
  });
  assert.equal(invalidPrecision.statusCode, 400);

  const cycles = await database.insert(billingCycles).values([
    {
      cycleCode: `P8-A-${suffix}`,
      periodStart: '2025-01-01',
      periodEnd: '2025-01-31',
      dueDate: '2025-02-15',
      status: 'CLOSED',
    },
    {
      cycleCode: `P8-B-${suffix}`,
      periodStart: '2025-02-01',
      periodEnd: '2025-02-28',
      dueDate: '2025-03-15',
      status: 'CLOSED',
    },
    {
      cycleCode: `P8-C-${suffix}`,
      periodStart: '2025-03-01',
      periodEnd: '2025-03-31',
      dueDate: '2025-04-15',
      status: 'CLOSED',
    },
    {
      cycleCode: `P8-D-${suffix}`,
      periodStart: '2025-04-01',
      periodEnd: '2025-04-30',
      dueDate: '2025-05-15',
      status: 'CLOSED',
    },
  ]).returning({ id: billingCycles.id });
  paymentCycleIds.push(...cycles.map((cycle) => cycle.id));

  const fixtureInvoices = await database.insert(invoices).values([
    {
      invoiceNumber: `P8-A-${suffix}`,
      serviceAccountId: masterDataIds.serviceAccountId,
      billingCycleId: cycles[0].id,
      invoiceDate: '2025-01-01',
      dueDate: '2025-02-15',
      subtotal: '30.10',
      discountAmount: '0.00',
      penaltyAmount: '0.00',
      totalAmount: '30.10',
      status: 'UNPAID',
    },
    {
      invoiceNumber: `P8-B-${suffix}`,
      serviceAccountId: masterDataIds.serviceAccountId,
      billingCycleId: cycles[1].id,
      invoiceDate: '2025-02-01',
      dueDate: '2025-03-15',
      subtotal: '50.00',
      discountAmount: '0.00',
      penaltyAmount: '0.00',
      totalAmount: '50.00',
      status: 'UNPAID',
    },
    {
      invoiceNumber: `P8-C-${suffix}`,
      serviceAccountId: masterDataIds.serviceAccountId,
      billingCycleId: cycles[2].id,
      invoiceDate: '2025-03-01',
      dueDate: '2025-04-15',
      subtotal: '20.00',
      discountAmount: '0.00',
      penaltyAmount: '0.00',
      totalAmount: '20.00',
      status: 'UNPAID',
    },
    {
      invoiceNumber: `P8-D-${suffix}`,
      serviceAccountId: masterDataIds.serviceAccountId,
      billingCycleId: cycles[3].id,
      invoiceDate: '2025-04-01',
      dueDate: '2025-05-15',
      subtotal: '40.00',
      discountAmount: '0.00',
      penaltyAmount: '0.00',
      totalAmount: '40.00',
      status: 'UNPAID',
    },
  ]).returning({ id: invoices.id });
  paymentInvoiceIds.push(...fixtureInvoices.map((invoice) => invoice.id));

  async function createPayment(
    amount: string,
    paymentMethod = 'CASH',
    referenceNumber?: string,
  ): Promise<number> {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: authHeaders,
      payload: {
        subscriberId: masterDataIds.subscriberId,
        amount,
        paymentMethod,
        referenceNumber,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const paymentId = response.json().data.id as number;
    paymentIds.push(paymentId);
    return paymentId;
  }

  const exactPaymentId = await createPayment('30.10');
  const exactAllocation = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${exactPaymentId}/allocations`,
    headers: authHeaders,
    payload: { invoiceId: fixtureInvoices[0].id, amount: '30.10' },
  });
  assert.equal(exactAllocation.statusCode, 201, exactAllocation.body);
  const paidInvoice = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${fixtureInvoices[0].id}`,
    headers: authHeaders,
  });
  assert.equal(moneyToCents(paidInvoice.json().data.amountPaid), 3010n);
  assert.equal(moneyToCents(paidInvoice.json().data.balance), 0n);
  assert.equal(paidInvoice.json().data.status, 'PAID');

  const partialPaymentId = await createPayment('10.00');
  const partialAllocation = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${partialPaymentId}/allocations`,
    headers: authHeaders,
    payload: { invoiceId: fixtureInvoices[1].id, amount: '10.00' },
  });
  assert.equal(partialAllocation.statusCode, 201, partialAllocation.body);
  const partialInvoice = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${fixtureInvoices[1].id}`,
    headers: authHeaders,
  });
  assert.equal(moneyToCents(partialInvoice.json().data.amountPaid), 1000n);
  assert.equal(moneyToCents(partialInvoice.json().data.balance), 4000n);
  assert.equal(partialInvoice.json().data.status, 'PARTIALLY_PAID');

  const advancePaymentId = await createPayment('15.00');
  const advanceAllocation = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${advancePaymentId}/allocations`,
    headers: authHeaders,
    payload: { invoiceId: fixtureInvoices[1].id, amount: '10.00' },
  });
  assert.equal(advanceAllocation.statusCode, 201, advanceAllocation.body);
  const advanceRead = await app.inject({
    method: 'GET',
    url: `/api/v1/payments/${advancePaymentId}`,
    headers: authHeaders,
  });
  assert.equal(moneyToCents(advanceRead.json().data.allocatedAmount), 1000n);
  assert.equal(moneyToCents(advanceRead.json().data.unappliedAmount), 500n);

  const arrearsPaymentId = await createPayment('55.00');
  const oldestFirst = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${arrearsPaymentId}/allocate-oldest`,
    headers: authHeaders,
  });
  assert.equal(oldestFirst.statusCode, 200, oldestFirst.body);
  const oldestAllocations = oldestFirst.json().data.allocations as Array<{
    invoiceId: number;
    amount: string;
  }>;
  assert.deepEqual(oldestAllocations.map((allocation) => allocation.invoiceId), [
    fixtureInvoices[1].id,
    fixtureInvoices[2].id,
    fixtureInvoices[3].id,
  ]);
  assert.deepEqual(oldestAllocations.map((allocation) => allocation.amount), ['30.00', '20.00', '5.00']);

  const overpaymentId = await createPayment('50.00');
  const overpayment = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${overpaymentId}/allocations`,
    headers: authHeaders,
    payload: { invoiceId: fixtureInvoices[1].id, amount: '31.00' },
  });
  assert.equal(overpayment.statusCode, 409);
  const rejectedAllocations = await database.select({ id: paymentAllocations.id })
    .from(paymentAllocations).where(eq(paymentAllocations.paymentId, overpaymentId));
  assert.equal(rejectedAllocations.length, 0);

  const concurrentCycle = await database.insert(billingCycles).values({
    cycleCode: `P8-CONCURRENT-${suffix}`,
    periodStart: '2025-05-01',
    periodEnd: '2025-05-31',
    dueDate: '2025-06-15',
    status: 'CLOSED',
  }).returning({ id: billingCycles.id });
  paymentCycleIds.push(concurrentCycle[0].id);
  const concurrentInvoice = await database.insert(invoices).values({
    invoiceNumber: `P8-CONCURRENT-${suffix}`,
    serviceAccountId: masterDataIds.serviceAccountId,
    billingCycleId: concurrentCycle[0].id,
    invoiceDate: '2025-05-01',
    dueDate: '2025-06-15',
    subtotal: '20.00',
    discountAmount: '0.00',
    penaltyAmount: '0.00',
    totalAmount: '20.00',
    status: 'UNPAID',
  }).returning({ id: invoices.id });
  paymentInvoiceIds.push(concurrentInvoice[0].id);
  const [racePaymentA, racePaymentB] = await Promise.all([
    createPayment('15.00'),
    createPayment('15.00'),
  ]);
  const raceResults = await Promise.all([racePaymentA, racePaymentB].map((paymentId) => app!.inject({
    method: 'POST',
    url: `/api/v1/payments/${paymentId}/allocations`,
    headers: authHeaders,
    payload: { invoiceId: concurrentInvoice[0].id, amount: '15.00' },
  })));
  assert.deepEqual(raceResults.map((response) => response.statusCode).sort(), [201, 409]);
  const concurrentRead = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${concurrentInvoice[0].id}`,
    headers: authHeaders,
  });
  assert.equal(concurrentRead.statusCode, 200);
  assert.equal(concurrentRead.json().data.amountPaid, '15.00');
  assert.equal(concurrentRead.json().data.balance, '5.00');
  const raceLedger = await database.select().from(ledgerEntries)
    .where(eq(ledgerEntries.invoiceId, concurrentInvoice[0].id));
  assert.equal(raceLedger.length, 1);
  assert.equal(raceLedger[0].credit, '15.00');

  const gcashReference = `GC-${suffix}`;
  const gcashPaymentId = await createPayment('12.34', 'GCASH', gcashReference);
  const duplicateGcash = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: authHeaders,
    payload: {
      subscriberId: masterDataIds.subscriberId,
      amount: '12.34',
      paymentMethod: 'GCash',
      referenceNumber: gcashReference,
    },
  });
  assert.equal(duplicateGcash.statusCode, 409);
  const concurrentReference = `GC-RACE-${suffix}`;
  const cashierToken = `phase14-cashier-${suffix}`;
  issuedTokens.push(cashierToken);
  authSessions.set(cashierToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Test Cashier',
    role: 'CASHIER',
    expiresAt: Date.now() + 60_000,
  });
  const referenceRace = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: authHeaders,
      payload: {
        subscriberId: masterDataIds.subscriberId,
        amount: '2.50',
        paymentMethod: 'GCash',
        referenceNumber: concurrentReference,
      },
    }),
    app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: {
        subscriberId: masterDataIds.subscriberId,
        amount: '2.50',
        paymentMethod: 'GCash',
        referenceNumber: concurrentReference,
      },
    }),
  ]);
  assert.deepEqual(referenceRace.map((response) => response.statusCode).sort(), [201, 409]);
  const createdRacePayment = referenceRace.find((response) => response.statusCode === 201);
  assert.ok(createdRacePayment);
  paymentIds.push(createdRacePayment.json().data.id as number);
  const proof = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${gcashPaymentId}/proof`,
    headers: authHeaders,
    payload: {
      referenceNumber: gcashReference,
      senderName: 'Synthetic sender',
      amount: '12.34',
    },
  });
  assert.equal(proof.statusCode, 201, proof.body);
  const duplicateProofPaymentId = await createPayment('1.00', 'GCASH', `GC2-${suffix}`);
  const duplicateProof = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${duplicateProofPaymentId}/proof`,
    headers: authHeaders,
    payload: { referenceNumber: gcashReference },
  });
  assert.equal(duplicateProof.statusCode, 400);
  const verification = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${gcashPaymentId}/verify`,
    headers: authHeaders,
    payload: {},
  });
  assert.equal(verification.statusCode, 200, verification.body);
  assert.equal(verification.json().data.payment.status, 'POSTED');
  const duplicateReference = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: authHeaders,
    payload: {
      subscriberId: masterDataIds.subscriberId,
      amount: '1.00',
      paymentMethod: 'BANK TRANSFER',
      referenceNumber: gcashReference,
    },
  });
  assert.equal(duplicateReference.statusCode, 409);

  const reversal = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${exactPaymentId}/reverse`,
    headers: authHeaders,
    payload: { reason: 'Synthetic reversal test' },
  });
  assert.equal(reversal.statusCode, 200, reversal.body);
  const reversedInvoice = await app.inject({
    method: 'GET',
    url: `/api/v1/invoices/${fixtureInvoices[0].id}`,
    headers: authHeaders,
  });
  assert.equal(moneyToCents(reversedInvoice.json().data.amountPaid), 0n);
  assert.equal(moneyToCents(reversedInvoice.json().data.balance), 3010n);
  assert.equal(reversedInvoice.json().data.status, 'OVERDUE');
  const retainedPayment = await database.select({ id: payments.id, status: payments.status })
    .from(payments).where(eq(payments.id, exactPaymentId)).limit(1);
  assert.deepEqual(retainedPayment, [{ id: exactPaymentId, status: 'REVERSED' }]);
  const exactLedger = await database.select().from(ledgerEntries)
    .where(eq(ledgerEntries.paymentId, exactPaymentId));
  assert.equal(exactLedger.reduce((sum, entry) => sum + moneyToCents(entry.credit), 0n), 3010n);
  assert.equal(exactLedger.reduce((sum, entry) => sum + moneyToCents(entry.debit), 0n), 3010n);
  const postedPaymentBeforeDelete = await database.select({
    amount: payments.amount,
    status: payments.status,
  }).from(payments).where(eq(payments.id, exactPaymentId)).limit(1);
  const paidInvoiceBeforeDelete = await database.select({
    totalAmount: invoices.totalAmount,
    status: invoices.status,
  }).from(invoices).where(eq(invoices.id, fixtureInvoices[0].id)).limit(1);
  for (const path of [
    `/api/v1/payments/${exactPaymentId}`,
    `/api/v1/invoices/${fixtureInvoices[0].id}`,
  ]) {
    const deletionAttempt = await app.inject({
      method: 'DELETE',
      url: path,
      headers: authHeaders,
    });
    assert.equal(deletionAttempt.statusCode, 404);
  }
  assert.deepEqual(await database.select({
    amount: payments.amount,
    status: payments.status,
  }).from(payments).where(eq(payments.id, exactPaymentId)).limit(1), postedPaymentBeforeDelete);
  assert.deepEqual(await database.select({
    totalAmount: invoices.totalAmount,
    status: invoices.status,
  }).from(invoices).where(eq(invoices.id, fixtureInvoices[0].id)).limit(1), paidInvoiceBeforeDelete);

  const rollbackPaymentId = await createPayment('5.00');
  await database.$client.query('DROP TRIGGER IF EXISTS phase8_fail_payment_ledger ON ledger_entries');
  await database.$client.query('DROP FUNCTION IF EXISTS phase8_fail_payment_ledger()');
  await database.$client.query(`
    CREATE FUNCTION phase8_fail_payment_ledger() RETURNS trigger AS $phase8$
    BEGIN
      IF NEW.entry_type = 'PAYMENT' THEN
        RAISE EXCEPTION 'forced Phase 8 transaction rollback test';
      END IF;
      RETURN NEW;
    END;
    $phase8$ LANGUAGE plpgsql
  `);
  await database.$client.query('CREATE TRIGGER phase8_fail_payment_ledger BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION phase8_fail_payment_ledger()');
  try {
    const failedAllocation = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${rollbackPaymentId}/allocations`,
      headers: authHeaders,
      payload: { invoiceId: fixtureInvoices[3].id, amount: '5.00' },
    });
    assert.equal(failedAllocation.statusCode, 500);
    const rolledBackAllocations = await database.select({ id: paymentAllocations.id })
      .from(paymentAllocations).where(eq(paymentAllocations.paymentId, rollbackPaymentId));
    const rolledBackLedger = await database.select({ id: ledgerEntries.id })
      .from(ledgerEntries).where(eq(ledgerEntries.paymentId, rollbackPaymentId));
    assert.equal(rolledBackAllocations.length, 0);
    assert.equal(rolledBackLedger.length, 0);
  } finally {
    await database.$client.query('DROP TRIGGER IF EXISTS phase8_fail_payment_ledger ON ledger_entries');
    await database.$client.query('DROP FUNCTION IF EXISTS phase8_fail_payment_ledger()');
  }

  const paymentAudit = await database.select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.entityType, 'payments'),
      eq(auditLogs.entityId, exactPaymentId),
    ));
  assert.ok(paymentAudit.some((entry) => entry.action === 'CREATE'));
  assert.ok(paymentAudit.some((entry) => entry.action === 'REVERSE'));
});

test('collection remittances reconcile totals and preserve atomic ledger records', async (context) => {
  if (!databaseAvailable || !app || !db || !masterDataIds.subscriberId
    || !masterDataIds.serviceAccountId || !masterDataIds.collectionAreaId) {
    context.skip('PostgreSQL or master-data workflow fixtures are unavailable.');
    return;
  }

  const database = db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(login.statusCode, 200);
  const token = login.json().data.token as string;
  issuedTokens.push(token);
  const authHeaders = { authorization: `Bearer ${token}` };
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const collectionDate = new Date().toISOString().slice(0, 10);

  const assignment = await app.inject({
    method: 'POST',
    url: '/api/v1/collection-assignments',
    headers: authHeaders,
    payload: {
      collectorId: testUserIds[0],
      collectionAreaId: masterDataIds.collectionAreaId,
      assignedFrom: collectionDate,
    },
  });
  assert.equal(assignment.statusCode, 201, assignment.body);
  collectionAssignmentIds.push(assignment.json().data.id);

  async function createBatch(code: string): Promise<number> {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/v1/collection-batches',
      headers: authHeaders,
      payload: {
        batchNumber: `COL-${code}-${suffix}`,
        collectorId: testUserIds[0],
        collectionAreaId: masterDataIds.collectionAreaId,
        collectionDate,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const batchId = response.json().data.id as number;
    collectionBatchIds.push(batchId);
    return batchId;
  }

  async function addBatchAccount(batchId: number, expectedAmount: string): Promise<number> {
    const response = await app!.inject({
      method: 'POST',
      url: `/api/v1/collection-batches/${batchId}/accounts`,
      headers: authHeaders,
      payload: {
        serviceAccountId: masterDataIds.serviceAccountId,
        expectedAmount,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().data.id as number;
  }

  async function recordCollection(
    batchId: number,
    accountId: number,
    amount: string,
    paymentMethod = 'Cash',
  ): Promise<number> {
    const response = await app!.inject({
      method: 'POST',
      url: `/api/v1/collection-batches/${batchId}/accounts/${accountId}/payments`,
      headers: authHeaders,
      payload: { amount, paymentMethod },
    });
    assert.equal(response.statusCode, 201, response.body);
    const paymentId = response.json().data.payment.id as number;
    collectionPaymentIds.push(paymentId);
    return paymentId;
  }

  const balancedBatch = await createBatch('BAL');
  const balancedAccount = await addBatchAccount(balancedBatch, '25.50');
  const balancedPaymentId = await recordCollection(balancedBatch, balancedAccount, '25.50');
  const balancedLedger = await database.select().from(ledgerEntries)
    .where(eq(ledgerEntries.paymentId, balancedPaymentId));
  assert.equal(balancedLedger.length, 1);
  assert.equal(balancedLedger[0].entryType, 'COLLECTION');
  assert.equal(moneyToCents(balancedLedger[0].credit), 2550n);

  const balancedBatchResponse = await app.inject({
    method: 'GET',
    url: `/api/v1/collection-batches/${balancedBatch}`,
    headers: authHeaders,
  });
  assert.equal(moneyToCents(balancedBatchResponse.json().data.expectedCash), 2550n);
  const balancedRemittance = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: authHeaders,
    payload: { batchId: balancedBatch, remittedCash: '25.50' },
  });
  assert.equal(balancedRemittance.statusCode, 201, balancedRemittance.body);
  assert.equal(moneyToCents(balancedRemittance.json().data.difference), 0n);
  assert.equal(balancedRemittance.json().data.status, 'RECONCILED');
  const duplicateRemittance = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: authHeaders,
    payload: { batchId: balancedBatch, remittedCash: '25.50' },
  });
  assert.equal(duplicateRemittance.statusCode, 409);

  const shortageBatch = await createBatch('SHORT');
  const shortageAccount = await addBatchAccount(shortageBatch, '20.00');
  await recordCollection(shortageBatch, shortageAccount, '20.00');
  const shortageWithoutReason = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: authHeaders,
    payload: { batchId: shortageBatch, remittedCash: '15.00' },
  });
  assert.equal(shortageWithoutReason.statusCode, 400);
  const shortage = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: authHeaders,
    payload: {
      batchId: shortageBatch,
      remittedCash: '15.00',
      shortageReason: 'Synthetic shortage test',
    },
  });
  assert.equal(shortage.statusCode, 201, shortage.body);
  assert.equal(moneyToCents(shortage.json().data.expectedCash), 2000n);
  assert.equal(moneyToCents(shortage.json().data.difference), 500n);
  assert.equal(shortage.json().data.status, 'PENDING');

  const overageBatch = await createBatch('OVER');
  const overageAccount = await addBatchAccount(overageBatch, '12.00');
  await recordCollection(overageBatch, overageAccount, '12.00');
  const overage = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: authHeaders,
    payload: { batchId: overageBatch, remittedCash: '15.00' },
  });
  assert.equal(overage.statusCode, 201, overage.body);
  assert.equal(moneyToCents(overage.json().data.difference), -300n);
  assert.equal(overage.json().data.status, 'PENDING');

  const invalidBatch = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: authHeaders,
    payload: { batchId: 999999999, remittedCash: '1.00' },
  });
  assert.equal(invalidBatch.statusCode, 404);
  const invalidAccount = await app.inject({
    method: 'POST',
    url: `/api/v1/collection-batches/${balancedBatch}/accounts`,
    headers: authHeaders,
    payload: { serviceAccountId: 999999999, expectedAmount: '1.00' },
  });
  assert.equal(invalidAccount.statusCode, 404);
  const invalidPayment = await app.inject({
    method: 'POST',
    url: `/api/v1/collection-batches/${balancedBatch}/accounts/${balancedAccount}/payments`,
    headers: authHeaders,
    payload: { amount: '0.01', paymentMethod: 'Cash' },
  });
  assert.equal(invalidPayment.statusCode, 409);

  const unauthorized = await app.inject({
    method: 'POST',
    url: `/api/v1/collection-batches/${balancedBatch}/accounts/${balancedAccount}/payments`,
    payload: { amount: '1.00', paymentMethod: 'Cash' },
  });
  assert.equal(unauthorized.statusCode, 401);
  const viewerToken = `phase9-viewer-${suffix}`;
  issuedTokens.push(viewerToken);
  authSessions.set(viewerToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Viewer',
    role: 'VIEWER',
    expiresAt: Date.now() + 60_000,
  });
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/v1/collector-remittances',
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: { batchId: balancedBatch, remittedCash: '25.50' },
  });
  assert.equal(forbidden.statusCode, 403);

  const rollbackBatch = await createBatch('ROLLBACK');
  const rollbackAccount = await addBatchAccount(rollbackBatch, '5.00');
  await database.$client.query('DROP TRIGGER IF EXISTS phase9_fail_collection_ledger ON ledger_entries');
  await database.$client.query('DROP FUNCTION IF EXISTS phase9_fail_collection_ledger()');
  await database.$client.query(`
    CREATE FUNCTION phase9_fail_collection_ledger() RETURNS trigger AS $phase9$
    BEGIN
      IF NEW.entry_type = 'COLLECTION' THEN
        RAISE EXCEPTION 'forced Phase 9 transaction rollback test';
      END IF;
      RETURN NEW;
    END;
    $phase9$ LANGUAGE plpgsql
  `);
  await database.$client.query('CREATE TRIGGER phase9_fail_collection_ledger BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION phase9_fail_collection_ledger()');
  try {
    const failedCollection = await app.inject({
      method: 'POST',
      url: `/api/v1/collection-batches/${rollbackBatch}/accounts/${rollbackAccount}/payments`,
      headers: authHeaders,
      payload: { amount: '5.00', paymentMethod: 'Cash' },
    });
    assert.equal(failedCollection.statusCode, 500);
    const [unmodifiedAccount] = await database.select({
      collectedAmount: batchAccounts.collectedAmount,
    }).from(batchAccounts).where(eq(batchAccounts.id, rollbackAccount)).limit(1);
    assert.equal(moneyToCents(unmodifiedAccount.collectedAmount), 0n);
    const [unmodifiedBatch] = await database.select({
      expectedCash: collectionBatches.expectedCash,
      status: collectionBatches.status,
    }).from(collectionBatches).where(eq(collectionBatches.id, rollbackBatch)).limit(1);
    assert.equal(moneyToCents(unmodifiedBatch.expectedCash), 0n);
    assert.equal(unmodifiedBatch.status, 'OPEN');
    const partialLedger = await database.select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(
        eq(ledgerEntries.entryType, 'COLLECTION'),
        eq(ledgerEntries.referenceNumber, `BATCH-${rollbackBatch}`),
      ));
    assert.equal(partialLedger.length, 0);
  } finally {
    await database.$client.query('DROP TRIGGER IF EXISTS phase9_fail_collection_ledger ON ledger_entries');
    await database.$client.query('DROP FUNCTION IF EXISTS phase9_fail_collection_ledger()');
  }

  const remittanceAudit = await database.select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.entityType, 'collector_remittances'),
      eq(auditLogs.entityId, balancedRemittance.json().data.id),
    ));
  assert.ok(remittanceAudit.some((entry) => entry.action === 'REMIT'));
});

test('receivables aging and suspension lifecycle use outstanding balances', async (context) => {
  if (!databaseAvailable || !app || !db || !masterDataIds.subscriberId || !masterDataIds.serviceAccountId) {
    context.skip('PostgreSQL or master-data workflow fixtures are unavailable.');
    return;
  }

  const database = db;
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: usernames[0], password: testPassword },
  });
  assert.equal(login.statusCode, 200);
  const token = login.json().data.token as string;
  issuedTokens.push(token);
  const authHeaders = { authorization: `Bearer ${token}` };
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(`${today}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() - 45);
  const dueDate = due.toISOString().slice(0, 10);
  const invoiceDate = new Date(`${dueDate}T00:00:00Z`);
  invoiceDate.setUTCDate(invoiceDate.getUTCDate() - 30);
  const invoiceDateString = invoiceDate.toISOString().slice(0, 10);

  const cycle = await database.insert(billingCycles).values({
    cycleCode: `P10-${suffix}`,
    periodStart: invoiceDateString,
    periodEnd: dueDate,
    dueDate,
    status: 'CLOSED',
  }).returning({ id: billingCycles.id });
  receivableCycleIds.push(cycle[0].id);
  const invoice = await database.insert(invoices).values({
    invoiceNumber: `P10-${suffix}`,
    serviceAccountId: masterDataIds.serviceAccountId,
    billingCycleId: cycle[0].id,
    invoiceDate: invoiceDateString,
    dueDate,
    subtotal: '40.00',
    discountAmount: '0.00',
    penaltyAmount: '0.00',
    totalAmount: '40.00',
    status: 'UNPAID',
  }).returning({ id: invoices.id });
  receivableInvoiceIds.push(invoice[0].id);
  const currentCycle = await database.insert(billingCycles).values({
    cycleCode: `P10-CURRENT-${suffix}`,
    periodStart: today,
    periodEnd: today,
    dueDate: today,
    status: 'CLOSED',
  }).returning({ id: billingCycles.id });
  receivableCycleIds.push(currentCycle[0].id);
  const currentInvoice = await database.insert(invoices).values({
    invoiceNumber: `P10-CURRENT-${suffix}`,
    serviceAccountId: masterDataIds.serviceAccountId,
    billingCycleId: currentCycle[0].id,
    invoiceDate: today,
    dueDate: new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000)
      .toISOString().slice(0, 10),
    subtotal: '5.00',
    discountAmount: '0.00',
    penaltyAmount: '0.00',
    totalAmount: '5.00',
    status: 'UNPAID',
  }).returning({ id: invoices.id });
  receivableInvoiceIds.push(currentInvoice[0].id);

  const payment = await app.inject({
    method: 'POST',
    url: '/api/v1/payments',
    headers: authHeaders,
    payload: {
      subscriberId: masterDataIds.subscriberId,
      amount: '10.00',
      paymentMethod: 'CASH',
    },
  });
  assert.equal(payment.statusCode, 201, payment.body);
  const paymentId = payment.json().data.id as number;
  receivablePaymentIds.push(paymentId);
  const allocation = await app.inject({
    method: 'POST',
    url: `/api/v1/payments/${paymentId}/allocations`,
    headers: authHeaders,
    payload: { invoiceId: invoice[0].id, amount: '10.00' },
  });
  assert.equal(allocation.statusCode, 201, allocation.body);

  const receivables = await app.inject({
    method: 'GET',
    url: `/api/v1/receivables?serviceAccountId=${masterDataIds.serviceAccountId}`,
    headers: authHeaders,
  });
  assert.equal(receivables.statusCode, 200, receivables.body);
  const accountReceivable = receivables.json().data.find(
    (item: { serviceAccountId: number }) => item.serviceAccountId === masterDataIds.serviceAccountId,
  );
  assert.ok(accountReceivable);
  const invoiceReceivable = accountReceivable.invoices.find(
    (item: { invoiceId: number }) => item.invoiceId === invoice[0].id,
  );
  assert.ok(invoiceReceivable);
  assert.equal(moneyToCents(invoiceReceivable.amountPaid), 1000n);
  assert.equal(moneyToCents(invoiceReceivable.balance), 3000n);
  assert.equal(invoiceReceivable.daysOverdue, 45);
  assert.equal(invoiceReceivable.agingBucket, '31_60_DAYS');
  const currentInvoiceReceivable = accountReceivable.invoices.find(
    (item: { invoiceId: number }) => item.invoiceId === currentInvoice[0].id,
  );
  assert.equal(currentInvoiceReceivable.balance, '5.00');
  assert.equal(currentInvoiceReceivable.agingBucket, 'CURRENT');
  assert.equal(moneyToCents(accountReceivable.aging.current) >= 500n, true);
  assert.equal(moneyToCents(accountReceivable.aging.days31To60) >= 3000n, true);
  assert.equal(moneyToCents(accountReceivable.overdueBalance) >= 3000n, true);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/receivables' })).statusCode, 401);

  const viewerToken = `phase10-viewer-${suffix}`;
  issuedTokens.push(viewerToken);
  authSessions.set(viewerToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Viewer',
    role: 'VIEWER',
    expiresAt: Date.now() + 60_000,
  });
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/v1/suspensions',
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: {
      serviceAccountId: masterDataIds.serviceAccountId,
      suspensionDate: today,
      reason: 'Synthetic overdue suspension',
    },
  });
  assert.equal(forbidden.statusCode, 403);

  const invalidReconnection = await app.inject({
    method: 'POST',
    url: '/api/v1/reconnections',
    headers: authHeaders,
    payload: {
      serviceAccountId: masterDataIds.serviceAccountId,
      status: 'COMPLETED',
      completionDate: today,
      notes: 'Cannot reconnect an active account',
    },
  });
  assert.equal(invalidReconnection.statusCode, 409);

  const suspension = await app.inject({
    method: 'POST',
    url: '/api/v1/suspensions',
    headers: authHeaders,
    payload: {
      serviceAccountId: masterDataIds.serviceAccountId,
      suspensionDate: today,
      reason: 'Synthetic overdue suspension',
      notes: 'Outstanding receivable exceeds zero.',
    },
  });
  assert.equal(suspension.statusCode, 201, suspension.body);
  const suspensionId = suspension.json().data.id as number;
  suspensionRecordIds.push(suspensionId);
  const [suspendedAccount] = await database.select({
    status: serviceAccounts.status,
  }).from(serviceAccounts).where(eq(serviceAccounts.id, masterDataIds.serviceAccountId)).limit(1);
  assert.equal(suspendedAccount.status, 'SUSPENDED');

  const duplicateSuspension = await app.inject({
    method: 'POST',
    url: '/api/v1/suspensions',
    headers: authHeaders,
    payload: {
      serviceAccountId: masterDataIds.serviceAccountId,
      suspensionDate: today,
      reason: 'Duplicate suspension attempt',
    },
  });
  assert.equal(duplicateSuspension.statusCode, 409);

  const reconnection = await app.inject({
    method: 'POST',
    url: '/api/v1/reconnections',
    headers: authHeaders,
    payload: {
      serviceAccountId: masterDataIds.serviceAccountId,
      suspensionId,
      requestDate: today,
      completionDate: today,
      status: 'COMPLETED',
      reconnectionFee: '0.00',
      notes: 'Synthetic successful reconnection',
    },
  });
  assert.equal(reconnection.statusCode, 201, reconnection.body);
  reconnectionRecordIds.push(reconnection.json().data.id);
  const [reconnectedAccount] = await database.select({
    status: serviceAccounts.status,
  }).from(serviceAccounts).where(eq(serviceAccounts.id, masterDataIds.serviceAccountId)).limit(1);
  assert.equal(reconnectedAccount.status, 'ACTIVE');

  const rollbackSuspensionCountBefore = await database.select({
    id: suspensionRecords.id,
  }).from(suspensionRecords).where(eq(
    suspensionRecords.serviceAccountId,
    masterDataIds.serviceAccountId,
  ));
  await database.$client.query('DROP TRIGGER IF EXISTS phase10_fail_suspension_account_update ON service_accounts');
  await database.$client.query('DROP FUNCTION IF EXISTS phase10_fail_suspension_account_update()');
  await database.$client.query(`
    CREATE FUNCTION phase10_fail_suspension_account_update() RETURNS trigger AS $phase10$
    BEGIN
      IF NEW.status = 'SUSPENDED' THEN
        RAISE EXCEPTION 'forced Phase 10 suspension rollback test';
      END IF;
      RETURN NEW;
    END;
    $phase10$ LANGUAGE plpgsql
  `);
  await database.$client.query('CREATE TRIGGER phase10_fail_suspension_account_update BEFORE UPDATE ON service_accounts FOR EACH ROW EXECUTE FUNCTION phase10_fail_suspension_account_update()');
  try {
    const rolledBackSuspension = await app.inject({
      method: 'POST',
      url: '/api/v1/suspensions',
      headers: authHeaders,
      payload: {
        serviceAccountId: masterDataIds.serviceAccountId,
        suspensionDate: today,
        reason: 'Synthetic rollback suspension',
      },
    });
    assert.equal(rolledBackSuspension.statusCode, 500);
    const rollbackSuspensionCountAfter = await database.select({
      id: suspensionRecords.id,
    }).from(suspensionRecords).where(eq(
      suspensionRecords.serviceAccountId,
      masterDataIds.serviceAccountId,
    ));
    assert.equal(rollbackSuspensionCountAfter.length, rollbackSuspensionCountBefore.length);
    const [stillActive] = await database.select({
      status: serviceAccounts.status,
    }).from(serviceAccounts).where(eq(serviceAccounts.id, masterDataIds.serviceAccountId)).limit(1);
    assert.equal(stillActive.status, 'ACTIVE');
  } finally {
    await database.$client.query('DROP TRIGGER IF EXISTS phase10_fail_suspension_account_update ON service_accounts');
    await database.$client.query('DROP FUNCTION IF EXISTS phase10_fail_suspension_account_update()');
  }

  const suspensionAudit = await database.select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.entityType, 'suspension_records'),
      eq(auditLogs.entityId, suspensionId),
    ));
  const reconnectionAudit = await database.select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.entityType, 'reconnection_records'),
      eq(auditLogs.entityId, reconnection.json().data.id),
    ));
  assert.ok(suspensionAudit.some((entry) => entry.action === 'SUSPEND'));
  assert.ok(reconnectionAudit.some((entry) => entry.action === 'RECONNECT'));
});

test('audit report enforces RBAC, filters logs, and redacts sensitive values', async (context) => {
  if (!databaseAvailable || !app || !db) {
    context.skip('PostgreSQL is unavailable for audit integration tests.');
    return;
  }

  const token = `phase12-auditor-${randomUUID()}`;
  const cashierToken = `phase12-cashier-${randomUUID()}`;
  issuedTokens.push(token, cashierToken);
  authSessions.set(token, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Test Auditor',
    role: 'ACCOUNTING_AUDITOR',
    expiresAt: Date.now() + 60_000,
  });
  authSessions.set(cashierToken, {
    userId: testUserIds[0],
    username: usernames[0],
    fullName: 'Synthetic Test Cashier',
    role: 'CASHIER',
    expiresAt: Date.now() + 60_000,
  });

  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/audit-logs',
  })).statusCode, 401);
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/audit-logs',
    headers: { authorization: `Bearer ${cashierToken}` },
  })).statusCode, 403);

  const suffix = randomUUID().slice(0, 8);
  const action = `PHASE12_REPORT_${suffix}`;
  const entityType = `phase12_report_${suffix}`;
  const [created] = await db.insert(auditLogs).values({
    userId: testUserIds[0],
    action,
    entityType,
    entityId: 900001,
    reason: 'Synthetic report filter fixture.',
    oldValues: JSON.stringify({ status: 'OLD', password: 'not-for-display' }),
    newValues: JSON.stringify({ status: 'NEW', accessToken: 'not-for-display' }),
    ipAddress: '127.0.0.1',
    createdAt: new Date(),
  }).returning({ id: auditLogs.id, createdAt: auditLogs.createdAt });
  phase12AuditIds.push(created.id);

  const params = new URLSearchParams({
    userId: String(testUserIds[0]),
    action: suffix,
    entityType,
    entityId: '900001',
    startDate: new Date(Date.now() - 60_000).toISOString(),
    endDate: new Date(Date.now() + 60_000).toISOString(),
  });
  const filtered = await app.inject({
    method: 'GET',
    url: `/api/v1/audit-logs?${params.toString()}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.equal(filtered.json().data.length, 1);
  assert.equal(filtered.json().data[0].id, created.id);
  assert.equal(filtered.json().data[0].oldValues.password, '[REDACTED]');
  assert.equal(filtered.json().data[0].newValues.accessToken, '[REDACTED]');
  assert.equal(filtered.json().data[0].newValues.status, 'NEW');

  const detail = await app.inject({
    method: 'GET',
    url: `/api/v1/audit-logs/${created.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.oldValues.password, '[REDACTED]');

  const invalidRange = await app.inject({
    method: 'GET',
    url: '/api/v1/audit-logs?startDate=2026-10-06T23%3A00%3A00.000Z&endDate=2026-10-06T22%3A00%3A00.000Z',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(invalidRange.statusCode, 400);

  const [postedPayment] = await db.select({ id: payments.id })
    .from(payments)
    .where(and(
      inArray(payments.id, paymentIds),
      eq(payments.status, 'POSTED'),
    ))
    .limit(1);
  assert.ok(postedPayment, 'A posted payment is required for receipt report coverage.');
  const [receipt] = await db.insert(receipts).values({
    receiptNumber: `RCT-PHASE12-${suffix}`,
    paymentId: postedPayment.id,
    status: 'ACTIVE',
    issuedAt: new Date(),
  }).returning({ id: receipts.id });
  phase12ReceiptIds.push(receipt.id);

  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/receipts',
  })).statusCode, 401);
  const receiptReport = await app.inject({
    method: 'GET',
    url: `/api/v1/receipts?status=ACTIVE&startDate=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&endDate=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(receiptReport.statusCode, 200, receiptReport.body);
  assert.ok(receiptReport.json().data.some((item: Record<string, unknown>) => item.id === receipt.id));
});

test('demo seed is repeatable and seeded records are available through authenticated APIs', async (context) => {
  if (!databaseAvailable || !app || !db) {
    context.skip('PostgreSQL is unavailable for demo seed integration tests.');
    return;
  }

  const initialCounts = await seedDemoData();
  const repeatedCounts = await seedDemoData();
  assert.deepEqual(repeatedCounts, initialCounts);
  assert.equal(initialCounts.users, 5);
  assert.equal(initialCounts.servicePlans, 7);
  assert.equal(initialCounts.subscribers, 50);
  assert.equal(initialCounts.serviceAccounts, 60);
  assert.equal(initialCounts.collectionAreas, 3);
  assert.equal(initialCounts.billingCycles, 3);
  assert.ok(initialCounts.invoices >= 180);
  assert.ok(initialCounts.payments >= 19);
  assert.ok(initialCounts.collectionBatches >= 2);
  assert.ok(initialCounts.remittances >= 2);
  assert.ok(initialCounts.suspensions >= 3);
  assert.ok(initialCounts.reconnections >= 2);

  const [demoOwner] = await db.select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, 'demo13_owner'))
    .limit(1);
  assert.ok(demoOwner);
  assert.notEqual(demoOwner.passwordHash, process.env.BCIS_DEMO_PASSWORD ?? 'Demo13!Only');

  const token = `phase13-demo-${randomUUID()}`;
  issuedTokens.push(token);
  authSessions.set(token, {
    userId: demoOwner.id,
    username: 'demo13_owner',
    fullName: 'Demo Owner',
    role: 'OWNER',
    expiresAt: Date.now() + 60_000,
  });
  const headers = { authorization: `Bearer ${token}` };

  const subscriberResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/subscribers?search=DEMO13-SUB-0001',
    headers,
  });
  assert.equal(subscriberResponse.statusCode, 200, subscriberResponse.body);
  assert.ok(subscriberResponse.json().data.some(
    (subscriber: Record<string, unknown>) => subscriber.accountNumber === 'DEMO13-SUB-0001',
  ));

  const invoiceResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/invoices',
    headers,
  });
  assert.equal(invoiceResponse.statusCode, 200, invoiceResponse.body);
  assert.ok(invoiceResponse.json().data.some(
    (invoice: Record<string, unknown>) => String(invoice.invoiceNumber).startsWith('DEMO13-INV-'),
  ));

  const receivablesResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/receivables',
    headers,
  });
  assert.equal(receivablesResponse.statusCode, 200, receivablesResponse.body);
  const demoReceivables = receivablesResponse.json().data.filter(
    (account: Record<string, unknown>) => String(account.serviceAccountNumber).startsWith('DEMO13-SVC-'),
  );
  assert.ok(demoReceivables.length >= 10);
  assert.ok(demoReceivables.filter(
    (account: Record<string, unknown>) => account.overdueBalance !== '0.00',
  ).length >= 10);

  const paymentResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/payments',
    headers,
  });
  assert.equal(paymentResponse.statusCode, 200, paymentResponse.body);
  assert.ok(paymentResponse.json().data.some(
    (payment: Record<string, unknown>) => payment.paymentNumber === 'DEMO13-PAY-REVERSED'
      && payment.status === 'REVERSED',
  ));

  const receiptResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/receipts',
    headers,
  });
  assert.equal(receiptResponse.statusCode, 200, receiptResponse.body);
  assert.ok(receiptResponse.json().data.some(
    (receipt: Record<string, unknown>) => String(receipt.receiptNumber).startsWith('DEMO13-RCT-')
      && receipt.status === 'VOID',
  ));

  const collectionResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/collection-batches',
    headers,
  });
  assert.equal(collectionResponse.statusCode, 200, collectionResponse.body);
  const demoCollectors = new Set(
    collectionResponse.json().data
      .filter((batch: Record<string, unknown>) => String(batch.batchNumber).startsWith('DEMO13-BATCH-'))
      .map((batch: Record<string, unknown>) => batch.collectorName),
  );
  assert.equal(demoCollectors.size, 2);

  const suspensionResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/suspensions',
    headers,
  });
  assert.equal(suspensionResponse.statusCode, 200, suspensionResponse.body);
  assert.ok(suspensionResponse.json().data.filter(
    (record: Record<string, unknown>) => String(record.serviceAccountNumber).startsWith('DEMO13-SVC-'),
  ).length >= 3);

  const reconnectionResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/reconnections',
    headers,
  });
  assert.equal(reconnectionResponse.statusCode, 200, reconnectionResponse.body);
  assert.ok(reconnectionResponse.json().data.filter(
    (record: Record<string, unknown>) => String(record.serviceAccountNumber).startsWith('DEMO13-SVC-'),
  ).length >= 2);
});

test('Electron renderer communicates through the isolated API bridge without database access', () => {
  const frontendRoot = resolve(process.cwd(), '..', 'bcis-system');
  const apiSource = readFileSync(resolve(frontendRoot, 'src', 'api.ts'), 'utf8');
  const preloadSource = readFileSync(resolve(frontendRoot, 'electron', 'preload.ts'), 'utf8');
  const mainSource = readFileSync(resolve(frontendRoot, 'electron', 'main.ts'), 'utf8');
  const rendererSources = [
    readFileSync(resolve(frontendRoot, 'src', 'App.tsx'), 'utf8'),
    readFileSync(resolve(frontendRoot, 'src', 'Workspace.tsx'), 'utf8'),
    apiSource,
  ].join('\n');

  assert.match(apiSource, /window\.bcisApi\.request\(path/);
  assert.match(preloadSource, /exposeInMainWorld\('bcisApi'/);
  assert.match(preloadSource, /fetch\(`http:\/\/localhost:3000\$\{path\}`/);
  assert.match(mainSource, /contextIsolation:\s*true/);
  assert.match(mainSource, /nodeIntegration:\s*false/);
  assert.doesNotMatch(rendererSources, /from\s+['"](?:pg|drizzle-orm)(?:\/[^'"]*)?['"]/);
  assert.doesNotMatch(rendererSources, /require\(['"](?:pg|drizzle-orm)/);
});

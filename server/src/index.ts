import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './lib/config';
import { db, initializeDatabase } from './lib/db';
import { authRoutes } from './routes/auth';
import { auditRoutes } from './routes/audit';
import { backupRoutes } from './routes/backups';
import { billingCycleRoutes } from './routes/billing-cycles';
import { billingGenerationRoutes } from './routes/billing-generation';
import { collectionRoutes } from './routes/collections';
import { invoiceDetailRoutes } from './routes/invoice-details';
import { invoiceRoutes } from './routes/invoices';
import { ledgerRoutes } from './routes/ledger';
import { paymentAllocationRoutes } from './routes/payment-allocations';
import { paymentRoutes } from './routes/payments';
import { receiptRoutes } from './routes/receipts';
import { receivableRoutes } from './routes/receivables';
import { serviceAccountRoutes } from './routes/service-accounts';
import { serviceEventRoutes } from './routes/service-events';
import { suspensionRoutes } from './routes/suspension';
import { subscriberRoutes } from './routes/subscribers';
import { ensureDemoAdmin } from './lib/auth';

const app = Fastify({
  logger: false,
});

async function start(): Promise<void> {
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(authRoutes);
  await app.register(auditRoutes);
  await app.register(backupRoutes);
  await app.register(subscriberRoutes);
  await app.register(serviceAccountRoutes);
  await app.register(serviceEventRoutes);
  await app.register(collectionRoutes);
  await app.register(suspensionRoutes);
  await app.register(billingCycleRoutes);
  await app.register(billingGenerationRoutes);
  await app.register(invoiceRoutes);
  await app.register(invoiceDetailRoutes);
  await app.register(ledgerRoutes);
  await app.register(paymentRoutes);
  await app.register(paymentAllocationRoutes);
  await app.register(receiptRoutes);
  await app.register(receivableRoutes);

  app.get('/api/health', async () => ({
    success: true,
    message: 'BCIS API is running',
    data: null,
  }));

  try {
    const dbReady = await initializeDatabase();

    if (dbReady && db) {
      await ensureDemoAdmin();
      console.log('Database connection established');
    } else {
      console.warn('Database not available; running in limited mode');
    }

    await app.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });

    console.log(
      `BCIS API running on http://localhost:${config.PORT}`,
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();

export default app;
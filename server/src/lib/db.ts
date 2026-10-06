import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../db/schema';
import { config } from './config';

const pool = new Pool({ connectionString: config.DATABASE_URL });

export let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export async function initializeDatabase(): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Database connection timeout')), 2000);
      }),
    ]);
    db = drizzle(pool, { schema });
    return true;
  } catch (error) {
    console.warn('Database connection unavailable. API will run in limited mode.', error);
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  db = null;
}

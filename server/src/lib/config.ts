import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgresql://postgres:123@localhost:5432/bcis_db'),
  JWT_SECRET: z.string().default('bcis-development-secret'),
  PG_DUMP_PATH: z.string().default('pg_dump'),
  PG_RESTORE_PATH: z.string().default('pg_restore'),
  BCIS_BACKUP_DIRECTORY: z.string().default('backups'),
  BCIS_RESTORE_DATABASE_URL: z.string().optional(),
  BCIS_ENABLE_RESTORE: z.enum(['true', 'false']).default('false'),
});

const parsedConfig = envSchema.parse(process.env);

export const config = {
  ...parsedConfig,
  BCIS_BACKUP_DIRECTORY: resolve(parsedConfig.BCIS_BACKUP_DIRECTORY),
};

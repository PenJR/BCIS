import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgresql://postgres:123@localhost:5432/bcis_db'),
  JWT_SECRET: z.string().default('bcis-development-secret'),
});

export const config = envSchema.parse(process.env);

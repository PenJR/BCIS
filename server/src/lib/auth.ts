import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { roles, userRoles, users } from '../../db/schema';

const legacyPasswordSalt = 'bcis-salt-v1';
const passwordHashIterations = 100000;
const passwordHashPrefix = 'pbkdf2-sha512';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const digest = crypto
    .pbkdf2Sync(password, salt, passwordHashIterations, 64, 'sha512')
    .toString('hex');

  return `${passwordHashPrefix}$${passwordHashIterations}$${salt.toString('hex')}$${digest}`;
}

export function verifyPassword(
  password: string,
  passwordHash: string,
): boolean {
  const parts = passwordHash.split('$');
  if (parts.length === 4 && parts[0] === passwordHashPrefix) {
    const iterations = Number(parts[1]);
    const salt = Buffer.from(parts[2], 'hex');
    const expectedDigest = Buffer.from(parts[3], 'hex');

    if (
      iterations !== passwordHashIterations
      || salt.length !== 16
      || expectedDigest.length !== 64
    ) {
      return false;
    }

    const actualDigest = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
  }

  const legacyDigest = crypto
    .pbkdf2Sync(password, legacyPasswordSalt, passwordHashIterations, 64, 'sha512');
  const expectedLegacyDigest = Buffer.from(passwordHash, 'hex');

  if (expectedLegacyDigest.length !== legacyDigest.length) {
    return false;
  }

  return crypto.timingSafeEqual(legacyDigest, expectedLegacyDigest);
}

export function needsPasswordRehash(passwordHash: string): boolean {
  return !passwordHash.startsWith(`${passwordHashPrefix}$`);
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export const sessionLifetimeMs = 8 * 60 * 60 * 1000;

export type AuthSession = {
  userId: number;
  username: string;
  role: string;
  fullName: string;
  expiresAt: number;
};

export const authSessions = new Map<
  string,
  AuthSession
>();

export function revokeUserSessions(userId: number): void {
  for (const [token, session] of authSessions) {
    if (session.userId === userId) {
      authSessions.delete(token);
    }
  }
}

export async function ensureDemoAdmin(): Promise<void> {
  if (!db) {
    return;
  }

  await db
    .insert(roles)
    .values([
      { name: 'OWNER', description: 'System owner and super administrator' },
      { name: 'ADMINISTRATOR', description: 'System administrator' },
      { name: 'CASHIER', description: 'Payment and receipt operations' },
      { name: 'COLLECTION_SUPERVISOR', description: 'Collection operations supervision' },
      { name: 'ACCOUNTING_AUDITOR', description: 'Read-only accounting and audit access' },
      { name: 'TECHNICIAN', description: 'Service work and reconnection tasks' },
      { name: 'VIEWER', description: 'Read-only system access' },
    ])
    .onConflictDoNothing();

  const existingRoleRows = await db
    .select()
    .from(roles)
    .where(eq(roles.name, 'OWNER'))
    .limit(1);

  let ownerRole = existingRoleRows[0];

  if (!ownerRole) {
    const inserted = await db
      .insert(roles)
      .values({
        name: 'OWNER',
        description: 'Super administrator access',
      })
      .onConflictDoNothing()
      .returning();

    ownerRole = inserted[0];
  }

  if (!ownerRole) {
    const fallback = await db
      .select()
      .from(roles)
      .where(eq(roles.name, 'OWNER'))
      .limit(1);

    if (!fallback[0]) {
      return;
    }

    ownerRole = fallback[0];
  }

  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.username, 'admin'))
    .limit(1);

  const adminUser = existingUser[0];

  if (!adminUser) {
    const insertedUser = await db
      .insert(users)
      .values({
        username: 'admin',
        passwordHash: hashPassword('Admin123!'),
        fullName: 'BCIS Administrator',
        email: 'admin@bcis.local',
        status: 'ACTIVE',
      })
      .returning();

    const newUser = insertedUser[0];

    if (newUser && ownerRole) {
      await db
        .insert(userRoles)
        .values({
          userId: newUser.id,
          roleId: ownerRole.id,
        })
        .onConflictDoNothing();
    }

    return;
  }

  const assignedRole = await db
    .select()
    .from(userRoles)
    .where(eq(userRoles.userId, adminUser.id))
    .limit(1);

  if (!assignedRole[0] && ownerRole) {
    await db
      .insert(userRoles)
      .values({
        userId: adminUser.id,
        roleId: ownerRole.id,
      })
      .onConflictDoNothing();
  }
}

export async function getUserWithRole(
  userId: number,
): Promise<{
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  status: string;
  role: string;
} | null> {
  if (!db) {
    return null;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = result[0];

  if (!user) {
    return null;
  }

  const userRoleRow = await db
    .select({ roleName: roles.name })
    .from(userRoles)
    .leftJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId))
    .limit(1);

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    status: user.status,
    role: userRoleRow[0]?.roleName ?? 'VIEWER',
  };
}

/**
 * Gets the current authentication session from the request.
 */
export function getSessionFromRequest(request: {
  headers: {
    authorization?: string;
  };
}) {
  const authHeader = request.headers.authorization ?? '';

  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return null;
  }

  const session = authSessions.get(token);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    authSessions.delete(token);
    return null;
  }

  return session;
}

/**
 * Requires a valid authenticated session.
 * Returns the session when authenticated, otherwise null.
 */
export function requireAuth(request: {
  headers: {
    authorization?: string;
  };
}) {
  return getSessionFromRequest(request);
}

/**
 * Requires authentication and one of the specified roles.
 * Returns the session when authorized, otherwise null.
 */
export function requireRole(
  request: {
    headers: {
      authorization?: string;
    };
  },
  allowedRoles: string[],
) {
  const session = requireAuth(request);

  if (!session) {
    return null;
  }

  if (!allowedRoles.includes(session.role)) {
    return null;
  }

  return session;
}
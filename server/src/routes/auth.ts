import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import {
  authSessions,
  generateToken,
  getUserWithRole,
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
  ensureDemoAdmin,
  requireAuth,
  requireRole,
  revokeUserSessions,
  sessionLifetimeMs,
} from '../lib/auth';
import { writeAuditLog } from '../lib/audit';
import { db } from '../lib/db';

const {
  users,
  userRoles,
  roles,
  permissions,
  servicePlans,
  serviceTypes,
  collectionAreas,
} = schema;

const administratorRoles = ['OWNER', 'ADMINISTRATOR'];

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // ============================================================
  // LOGIN
  // ============================================================
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const loginSchema = z.object({
      username: z.string().min(3),
      password: z.string().min(6),
    });

    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid username and password are required.',
      });
    }

    const { username, password } = parsed.data;

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    await ensureDemoAdmin();

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    const user = userRows[0];

    if (!user || !verifyPassword(password, user.passwordHash)) {
      await writeAuditLog({
        userId: user?.id ?? null,
        action: 'LOGIN_FAILED',
        entityType: 'users',
        entityId: user?.id ?? null,
        reason: 'Invalid credentials.',
        ipAddress: request.ip,
      });
      return reply.code(401).send({
        success: false,
        message: 'Invalid username or password.',
        data: null,
      });
    }

    if (user.status !== 'ACTIVE') {
      await writeAuditLog({
        userId: user.id,
        action: 'LOGIN_REJECTED',
        entityType: 'users',
        entityId: user.id,
        reason: 'Inactive user account.',
        ipAddress: request.ip,
      });
      return reply.code(403).send({
        success: false,
        message: 'User account is not active.',
        data: null,
      });
    }

    if (needsPasswordRehash(user.passwordHash)) {
      await db.update(users)
        .set({
          passwordHash: hashPassword(password),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      await writeAuditLog({
        userId: user.id,
        action: 'PASSWORD_REHASH',
        entityType: 'users',
        entityId: user.id,
        reason: 'Legacy password hash upgraded after successful login.',
        newValues: { passwordHashUpgraded: true },
        ipAddress: request.ip,
      });
    }

    const userRoleRow = await db
      .select({
        roleName: roles.name,
      })
      .from(userRoles)
      .leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, user.id))
      .limit(1);

    const role = userRoleRow[0]?.roleName ?? 'VIEWER';

    const token = generateToken();

    authSessions.set(token, {
      userId: user.id,
      username: user.username,
      role,
      fullName: user.fullName,
      expiresAt: Date.now() + sessionLifetimeMs,
    });

    await writeAuditLog({
      userId: user.id,
      action: 'LOGIN',
      entityType: 'users',
      entityId: user.id,
      ipAddress: request.ip,
    });

    const safeUser = await getUserWithRole(user.id);

    return reply.send({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: safeUser,
      },
    });
  });

  // ============================================================
  // LOGOUT
  // ============================================================
  fastify.post('/api/v1/auth/logout', async (request, reply) => {
    const session = requireAuth(request);
    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
        data: null,
      });
    }

    const authHeader = request.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';

    if (token) {
      authSessions.delete(token);
    }

    await writeAuditLog({
      userId: session.userId,
      action: 'LOGOUT',
      entityType: 'users',
      entityId: session.userId,
      ipAddress: request.ip,
    });

    return reply.send({
      success: true,
      message: 'Logged out successfully',
      data: null,
    });
  });

  // ============================================================
  // CURRENT USER
  // ============================================================
  fastify.get('/api/v1/auth/me', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
      });
    }

    const user = await getUserWithRole(session.userId);

    if (!user) {
      return reply.code(404).send({
        success: false,
        message: 'User not found.',
      });
    }

    if (user.status !== 'ACTIVE') {
      revokeUserSessions(session.userId);
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
        data: null,
      });
    }

    session.role = user.role;
    session.fullName = user.fullName;

    return reply.send({
      success: true,
      message: 'Current user loaded.',
      data: user,
    });
  });

  // ============================================================
  // USERS
  // OWNER / ADMINISTRATOR ONLY
  // ============================================================
  fastify.get('/api/v1/users', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to access users.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const items = await db.query.users.findMany({
      columns: {
        passwordHash: false,
      },
      orderBy: (usersTable, { desc }) => [
        desc(usersTable.createdAt),
      ],
    });

    return reply.send({
      success: true,
      data: items,
      message: 'Users loaded.',
    });
  });

  fastify.get('/api/v1/users/:id', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to access users.'
          : 'Authentication required.',
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

    const parsedParams = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ success: false, message: 'Invalid user ID.', data: null });
    }

    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        email: users.email,
        status: users.status,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        roleId: userRoles.roleId,
        roleName: roles.name,
      })
      .from(users)
      .leftJoin(userRoles, eq(users.id, userRoles.userId))
      .leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(users.id, parsedParams.data.id))
      .limit(1);

    if (!user) {
      return reply.code(404).send({ success: false, message: 'User not found.', data: null });
    }

    return reply.send({ success: true, message: 'User loaded.', data: user });
  });

  fastify.post('/api/v1/users', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create users.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const bodySchema = z.object({
      username: z.string().trim().min(3).max(50),
      password: z.string().min(8).max(128),
      fullName: z.string().trim().min(1).max(150),
      email: z.string().email().max(150).nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
      roleId: z.number().int().positive(),
    });
    const parsed = bodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: 'Valid user data is required.', data: parsed.error.flatten() });
    }

    const [role] = await db.select({ id: roles.id, name: roles.name })
      .from(roles).where(eq(roles.id, parsed.data.roleId)).limit(1);

    if (!role) {
      return reply.code(404).send({ success: false, message: 'Role not found.', data: null });
    }

    try {
      const created = await db.transaction(async (transaction) => {
        const [user] = await transaction.insert(users).values({
          username: parsed.data.username,
          passwordHash: hashPassword(parsed.data.password),
          fullName: parsed.data.fullName,
          email: parsed.data.email ?? null,
          status: parsed.data.status,
        }).returning({
          id: users.id,
          username: users.username,
          fullName: users.fullName,
          email: users.email,
          status: users.status,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        });

        if (!user) {
          throw new Error('User insert returned no row.');
        }

        await transaction.insert(userRoles).values({ userId: user.id, roleId: role.id });
        return { ...user, roleId: role.id, roleName: role.name };
      });

      await writeAuditLog({
        userId: session.userId,
        action: 'CREATE',
        entityType: 'users',
        entityId: created.id,
        newValues: { ...created },
        ipAddress: request.ip,
      });

      return reply.code(201).send({ success: true, message: 'User created successfully.', data: created });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Username already exists.', data: null });
      }
      throw error;
    }
  });

  fastify.put('/api/v1/users/:id', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to update users.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const bodySchema = z.object({
      fullName: z.string().trim().min(1).max(150).optional(),
      email: z.string().email().max(150).nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      password: z.string().min(8).max(128).optional(),
    }).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });
    const parsed = bodySchema.safeParse(request.body);

    if (!params.success || !parsed.success) {
      return reply.code(400).send({ success: false, message: 'Invalid user ID or update data.', data: null });
    }

    const [existing] = await db.select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      email: users.email,
      status: users.status,
    }).from(users).where(eq(users.id, params.data.id)).limit(1);

    if (!existing) {
      return reply.code(404).send({ success: false, message: 'User not found.', data: null });
    }

    const { password, ...safeChanges } = parsed.data;
    const updateValues = {
      ...safeChanges,
      ...(password === undefined ? {} : { passwordHash: hashPassword(password) }),
      updatedAt: new Date(),
    };
    const [updated] = await db.update(users).set(updateValues)
      .where(eq(users.id, params.data.id))
      .returning({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        email: users.email,
        status: users.status,
        updatedAt: users.updatedAt,
      });

    if (!updated) {
      return reply.code(404).send({ success: false, message: 'User not found.', data: null });
    }

    await writeAuditLog({
      userId: session.userId,
      action: 'UPDATE',
      entityType: 'users',
      entityId: updated.id,
      oldValues: existing,
      newValues: { ...updated, passwordChanged: password !== undefined },
      ipAddress: request.ip,
    });

    revokeUserSessions(updated.id);

    return reply.send({ success: true, message: 'User updated successfully.', data: updated });
  });

  fastify.put('/api/v1/users/:id/role', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to assign user roles.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const body = z.object({ roleId: z.number().int().positive() }).safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ success: false, message: 'Invalid user ID or role data.', data: null });
    }

    const [user] = await db.select({ id: users.id, username: users.username })
      .from(users).where(eq(users.id, params.data.id)).limit(1);
    if (!user) {
      return reply.code(404).send({ success: false, message: 'User not found.', data: null });
    }

    const [role] = await db.select({ id: roles.id, name: roles.name })
      .from(roles).where(eq(roles.id, body.data.roleId)).limit(1);
    if (!role) {
      return reply.code(404).send({ success: false, message: 'Role not found.', data: null });
    }

    const previousRoles = await db.select({ roleId: userRoles.roleId, roleName: roles.name })
      .from(userRoles).leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, user.id));

    await db.transaction(async (transaction) => {
      await transaction.delete(userRoles).where(eq(userRoles.userId, user.id));
      await transaction.insert(userRoles).values({ userId: user.id, roleId: role.id });
    });

    revokeUserSessions(user.id);

    await writeAuditLog({
      userId: session.userId,
      action: 'ASSIGN_ROLE',
      entityType: 'users',
      entityId: user.id,
      oldValues: { roles: previousRoles },
      newValues: { roles: [{ roleId: role.id, roleName: role.name }] },
      ipAddress: request.ip,
    });

    return reply.send({
      success: true,
      message: 'User role updated successfully.',
      data: { userId: user.id, username: user.username, roleId: role.id, roleName: role.name },
    });
  });

  fastify.get('/api/v1/roles', async (request, reply) => {
    const session = requireAuth(request);
    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }
    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const items = await db.select().from(roles).orderBy(asc(roles.name));
    return reply.send({ success: true, message: 'Roles loaded.', data: items });
  });

  fastify.get('/api/v1/permissions', async (request, reply) => {
    const session = requireAuth(request);
    if (!session) {
      return reply.code(401).send({ success: false, message: 'Authentication required.', data: null });
    }
    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const items = await db.select().from(permissions).orderBy(asc(permissions.code));
    return reply.send({ success: true, message: 'Permissions loaded.', data: items });
  });

  // ============================================================
  // SERVICE TYPES
  // ============================================================
  fastify.get('/api/v1/service-types', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const items = await db.query.serviceTypes.findMany();

    return reply.send({
      success: true,
      data: items,
      message: 'Service types loaded',
    });
  });

  // ============================================================
  // CREATE SERVICE TYPE
  // OWNER / ADMINISTRATOR ONLY
  // ============================================================
  fastify.post('/api/v1/service-types', async (request, reply) => {
    const session = requireRole(request, [
      'OWNER',
      'ADMINISTRATOR',
    ]);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to create service types.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const serviceTypeSchema = z.object({
      name: z.string().min(2),
      description: z.string().optional(),
    });

    const parsed = serviceTypeSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid service type data is required.',
      });
    }

    try {
      const created = await db
        .insert(serviceTypes)
        .values({
          name: parsed.data.name,
          description: parsed.data.description ?? '',
        })
        .returning();

      if (created[0]) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'service_types',
          entityId: created[0].id,
          newValues: created[0],
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Service type created successfully.',
        data: created[0] ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Service type name already exists.', data: null });
      }
      throw error;
    }
  });

  fastify.put('/api/v1/service-types/:id', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to update service types.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const bodySchema = z.object({
      name: z.string().trim().min(2).max(50).optional(),
      description: z.string().nullable().optional(),
    }).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });
    const parsed = bodySchema.safeParse(request.body);

    if (!params.success || !parsed.success) {
      return reply.code(400).send({ success: false, message: 'Invalid service type ID or update data.', data: null });
    }

    const [existing] = await db.select().from(serviceTypes)
      .where(eq(serviceTypes.id, params.data.id)).limit(1);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'Service type not found.', data: null });
    }

    try {
      const [updated] = await db.update(serviceTypes).set(parsed.data)
        .where(eq(serviceTypes.id, existing.id)).returning();
      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'service_types',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }
      return reply.send({ success: true, message: 'Service type updated successfully.', data: updated ?? null });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Service type name already exists.', data: null });
      }
      throw error;
    }
  });

  // ============================================================
  // SERVICE PLANS
  // ============================================================
  fastify.get('/api/v1/service-plans', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const items = await db.query.servicePlans.findMany();

    return reply.send({
      success: true,
      data: items,
      message: 'Service plans loaded.',
    });
  });

  fastify.post('/api/v1/service-plans', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to create service plans.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
    const bodySchema = z.object({
      serviceTypeId: z.number().int().positive(),
      planCode: z.string().trim().min(1).max(50),
      planName: z.string().trim().min(1).max(100),
      price: moneySchema,
      installationFee: moneySchema.default('0'),
      reconnectionFee: moneySchema.default('0'),
      speedMbps: z.number().int().positive().nullable().optional(),
      channelCount: z.number().int().positive().nullable().optional(),
      description: z.string().nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
    });
    const parsed = bodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: 'Valid service plan data is required.', data: parsed.error.flatten() });
    }

    const [serviceType] = await db.select({ id: serviceTypes.id })
      .from(serviceTypes).where(eq(serviceTypes.id, parsed.data.serviceTypeId)).limit(1);
    if (!serviceType) {
      return reply.code(404).send({ success: false, message: 'Service type not found.', data: null });
    }

    try {
      const [created] = await db.insert(servicePlans).values(parsed.data).returning();
      if (created) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'service_plans',
          entityId: created.id,
          newValues: created,
          ipAddress: request.ip,
        });
      }
      return reply.code(201).send({ success: true, message: 'Service plan created successfully.', data: created ?? null });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Plan code already exists.', data: null });
      }
      throw error;
    }
  });

  fastify.put('/api/v1/service-plans/:id', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to update service plans.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const moneySchema = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);
    const bodySchema = z.object({
      serviceTypeId: z.number().int().positive().optional(),
      planCode: z.string().trim().min(1).max(50).optional(),
      planName: z.string().trim().min(1).max(100).optional(),
      price: moneySchema.optional(),
      installationFee: moneySchema.optional(),
      reconnectionFee: moneySchema.optional(),
      speedMbps: z.number().int().positive().nullable().optional(),
      channelCount: z.number().int().positive().nullable().optional(),
      description: z.string().nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    }).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });
    const parsed = bodySchema.safeParse(request.body);

    if (!params.success || !parsed.success) {
      return reply.code(400).send({ success: false, message: 'Invalid service plan ID or update data.', data: null });
    }

    const [existing] = await db.select().from(servicePlans)
      .where(eq(servicePlans.id, params.data.id)).limit(1);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'Service plan not found.', data: null });
    }

    if (parsed.data.serviceTypeId !== undefined) {
      const [serviceType] = await db.select({ id: serviceTypes.id })
        .from(serviceTypes).where(eq(serviceTypes.id, parsed.data.serviceTypeId)).limit(1);
      if (!serviceType) {
        return reply.code(404).send({ success: false, message: 'Service type not found.', data: null });
      }
    }

    try {
      const [updated] = await db.update(servicePlans).set({
        ...parsed.data,
        updatedAt: new Date(),
      }).where(eq(servicePlans.id, existing.id)).returning();

      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'service_plans',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }
      return reply.send({ success: true, message: 'Service plan updated successfully.', data: updated ?? null });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Plan code already exists.', data: null });
      }
      throw error;
    }
  });

  // ============================================================
  // COLLECTION AREAS
  // ============================================================
  fastify.get('/api/v1/collection-areas', async (request, reply) => {
    const session = requireAuth(request);

    if (!session) {
      return reply.code(401).send({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const items = await db.query.collectionAreas.findMany();

    return reply.send({
      success: true,
      data: items,
      message: 'Collection areas loaded',
    });
  });

  // ============================================================
  // CREATE COLLECTION AREA
  // OWNER / ADMINISTRATOR ONLY
  // ============================================================
  fastify.post('/api/v1/collection-areas', async (request, reply) => {
    const session = requireRole(request, [
      'OWNER',
      'ADMINISTRATOR',
    ]);

    if (!session) {
      const authenticatedSession = requireAuth(request);

      if (!authenticatedSession) {
        return reply.code(401).send({
          success: false,
          message: 'Authentication required.',
        });
      }

      return reply.code(403).send({
        success: false,
        message: 'You do not have permission to create collection areas.',
      });
    }

    if (!db) {
      return reply.code(503).send({
        success: false,
        message: 'Database is not available.',
      });
    }

    const collectionAreaSchema = z.object({
      areaCode: z.string().min(2),
      areaName: z.string().min(2),
      description: z.string().optional(),
    });

    const parsed = collectionAreaSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        message: 'Valid collection area data is required.',
      });
    }

    try {
      const created = await db
        .insert(collectionAreas)
        .values({
          areaCode: parsed.data.areaCode,
          areaName: parsed.data.areaName,
          description: parsed.data.description ?? '',
          status: 'ACTIVE',
        })
        .returning();

      if (created[0]) {
        await writeAuditLog({
          userId: session.userId,
          action: 'CREATE',
          entityType: 'collection_areas',
          entityId: created[0].id,
          newValues: created[0],
          ipAddress: request.ip,
        });
      }

      return reply.code(201).send({
        success: true,
        message: 'Collection area created successfully.',
        data: created[0] ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Collection area code already exists.', data: null });
      }
      throw error;
    }
  });

  fastify.put('/api/v1/collection-areas/:id', async (request, reply) => {
    const session = requireRole(request, administratorRoles);

    if (!session) {
      const authenticatedSession = requireAuth(request);
      return reply.code(authenticatedSession ? 403 : 401).send({
        success: false,
        message: authenticatedSession
          ? 'You do not have permission to update collection areas.'
          : 'Authentication required.',
        data: null,
      });
    }

    if (!db) {
      return reply.code(503).send({ success: false, message: 'Database is not available.', data: null });
    }

    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const bodySchema = z.object({
      areaCode: z.string().trim().min(2).max(30).optional(),
      areaName: z.string().trim().min(2).max(100).optional(),
      description: z.string().nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    }).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });
    const parsed = bodySchema.safeParse(request.body);

    if (!params.success || !parsed.success) {
      return reply.code(400).send({ success: false, message: 'Invalid collection area ID or update data.', data: null });
    }

    const [existing] = await db.select().from(collectionAreas)
      .where(eq(collectionAreas.id, params.data.id)).limit(1);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'Collection area not found.', data: null });
    }

    try {
      const [updated] = await db.update(collectionAreas).set(parsed.data)
        .where(eq(collectionAreas.id, existing.id)).returning();
      if (updated) {
        await writeAuditLog({
          userId: session.userId,
          action: 'UPDATE',
          entityType: 'collection_areas',
          entityId: updated.id,
          oldValues: existing,
          newValues: updated,
          ipAddress: request.ip,
        });
      }
      return reply.send({ success: true, message: 'Collection area updated successfully.', data: updated ?? null });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'Collection area code already exists.', data: null });
      }
      throw error;
    }
  });

  // ============================================================
  // HEALTH
  // ============================================================
  fastify.get('/api/v1/health', async () => ({
    success: true,
    message: 'BCIS API is running',
    data: null,
  }));
};
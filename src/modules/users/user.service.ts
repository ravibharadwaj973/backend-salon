import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, getContext } from '../../core/context';
import { assertBranchAccess } from '../../core/scope';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { hashPassword } from '../auth/auth.service';
import { invalidateIdentity } from '../../middleware/auth';
import { resolvePermissions } from '../../core/permissions';
import { assertStaffAllowed } from '../quotas/limits.service';

const SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  avatarUrl: true,
  lastLoginAt: true,
  mustChangePassword: true,
  createdAt: true,
  branches: { select: { branch: { select: { id: true, name: true, code: true } } } },
  staffProfile: { select: { id: true, displayName: true, branchId: true } },
} satisfies Prisma.UserSelect;

/** Only an owner may create or modify another owner. */
function assertCanManageRole(role: UserRole): void {
  const actor = getContext()?.role;
  if (role === 'OWNER' && actor !== 'OWNER') {
    throw Forbidden('Only an owner can grant owner access');
  }
  if ((role === 'ADMIN' || role === 'REGIONAL_MANAGER') && actor !== 'OWNER' && actor !== 'ADMIN') {
    throw Forbidden('Only owners and admins can grant this role');
  }
}

export async function listUsers(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  role?: UserRole;
  isActive?: string;
  branchId?: string;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.UserWhereInput = {
    tenantId,
    ...(input.role ? { role: input.role } : {}),
    ...(input.isActive ? { isActive: input.isActive === 'true' } : {}),
    ...(input.branchId ? { branches: { some: { branchId: input.branchId } } } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' as const } },
            { email: { contains: input.q, mode: 'insensitive' as const } },
            { phone: { contains: input.q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, select: SELECT }),
    prisma.user.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

export async function getUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { ...SELECT, overrides: { select: { permission: true, allow: true } } },
  });
  if (!user) throw NotFound('User');
  return {
    ...user,
    permissions: [...resolvePermissions(user.role, user.overrides)],
  };
}

export interface CreateUserInput {
  name: string;
  email: string;
  phone?: string;
  password: string;
  role: UserRole;
  branchIds?: string[];
  mustChangePassword?: boolean;
  createStaffProfile?: boolean;
  staffBranchId?: string;
}

export async function createUser(input: CreateUserInput) {
  const tenantId = requireTenantId();
  assertCanManageRole(input.role);
  await assertStaffAllowed(tenantId);

  const existing = await prisma.user.findFirst({ where: { tenantId, email: input.email } });
  if (existing) throw Conflict('A user with this email already exists in this salon');

  for (const branchId of input.branchIds ?? []) assertBranchAccess(branchId);

  const passwordHash = await hashPassword(input.password);
  const staffBranchId = input.staffBranchId ?? input.branchIds?.[0];

  if (input.createStaffProfile && !staffBranchId) {
    throw BadRequest('A branch is required to create a staff profile');
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        passwordHash,
        role: input.role,
        mustChangePassword: input.mustChangePassword ?? true,
      },
    });

    if (input.branchIds?.length) {
      await tx.userBranch.createMany({
        data: input.branchIds.map((branchId) => ({ tenantId, userId: user.id, branchId })),
        skipDuplicates: true,
      });
    }

    if (input.createStaffProfile && staffBranchId) {
      await tx.staff.create({
        data: {
          tenantId,
          branchId: staffBranchId,
          userId: user.id,
          displayName: input.name,
          phone: input.phone ?? null,
          email: input.email,
          isBookable: input.role === 'STYLIST',
        },
      });
    }

    return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: SELECT });
  });
}

export async function updateUser(id: string, input: Partial<CreateUserInput> & { isActive?: boolean; avatarUrl?: string }) {
  const tenantId = requireTenantId();
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw NotFound('User');

  if (input.role) assertCanManageRole(input.role);
  if (user.role === 'OWNER' && getContext()?.role !== 'OWNER') {
    throw Forbidden('Only an owner can modify an owner account');
  }

  // The last active owner cannot be demoted or switched off.
  if (user.role === 'OWNER' && (input.role !== undefined || input.isActive === false)) {
    const owners = await prisma.user.count({ where: { tenantId, role: 'OWNER', isActive: true } });
    if (owners <= 1) throw BadRequest('This salon must keep at least one active owner');
  }

  const { branchIds, ...rest } = input;

  const updated = await prisma.$transaction(async (tx) => {
    if (branchIds) {
      for (const branchId of branchIds) assertBranchAccess(branchId);
      await tx.userBranch.deleteMany({ where: { userId: id } });
      if (branchIds.length) {
        await tx.userBranch.createMany({
          data: branchIds.map((branchId) => ({ tenantId, userId: id, branchId })),
          skipDuplicates: true,
        });
      }
    }

    return tx.user.update({
      where: { id },
      data: {
        ...(rest.name !== undefined ? { name: rest.name } : {}),
        ...(rest.phone !== undefined ? { phone: rest.phone } : {}),
        ...(rest.role !== undefined ? { role: rest.role } : {}),
        ...(rest.isActive !== undefined ? { isActive: rest.isActive } : {}),
        ...(rest.avatarUrl !== undefined ? { avatarUrl: rest.avatarUrl } : {}),
      },
      select: SELECT,
    });
  });

  invalidateIdentity(id);
  return updated;
}

export async function resetUserPassword(id: string, newPassword: string, mustChangePassword = true) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw NotFound('User');
  if (user.role === 'OWNER' && getContext()?.role !== 'OWNER') {
    throw Forbidden('Only an owner can reset an owner password');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { passwordHash, mustChangePassword } }),
    prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  invalidateIdentity(id);
  return { reset: true };
}

export async function deactivateUser(id: string) {
  return updateUser(id, { isActive: false });
}

export async function setPermissionOverride(userId: string, permission: string, allow: boolean) {
  const tenantId = requireTenantId();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw NotFound('User');

  const existing = await prisma.permissionOverride.findFirst({ where: { userId, permission } });
  const result = existing
    ? await prisma.permissionOverride.update({ where: { id: existing.id }, data: { allow } })
    : await prisma.permissionOverride.create({ data: { tenantId, userId, permission, allow } });

  invalidateIdentity(userId);
  return result;
}

export async function removePermissionOverride(userId: string, permission: string) {
  await prisma.permissionOverride.deleteMany({ where: { userId, permission } });
  invalidateIdentity(userId);
  return { removed: true };
}

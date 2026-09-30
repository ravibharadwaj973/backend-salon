import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, getContext } from '../../core/context';
import { assertBranchAccess } from '../../core/scope';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { hashPassword } from '../auth/auth.service';
import { invalidateIdentity } from '../../middleware/auth';
import { resolvePermissions } from '../../core/permissions';
import { canResetPasswordOf, resetIsHandledByPlatform, temporaryPassword } from '../../core/user-authority';
import { closeOpenRequest } from '../auth/password-reset.service';
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

/**
 * RESETTING A COLLEAGUE, AND WHY THE PASSWORD IS NOT A PARAMETER ANY MORE.
 *
 * Two changes, both of which close something real.
 *
 * ── The caller no longer chooses the password ───────────────────────────
 *
 * It used to take `newPassword` from the request body. Left to choose, a busy
 * manager types the same thing every time — the salon name and a year, usually —
 * and within a month every temporary password in the business is the same
 * string, known to everyone who has ever been reset. Generating it server-side
 * costs the manager nothing (they read it off the screen either way) and makes
 * that impossible. `mustChangePassword` is likewise forced on rather than
 * optional: a temporary password that is allowed to become permanent is not
 * temporary.
 *
 * ── The check is what the two people can DO, not what they are called ──
 *
 * The old guard was one line: only an owner may reset an owner. Everything else
 * was open to anybody holding `user.manage`. But resetting somebody hands you
 * their account, so the only safe rule is that you may already do everything
 * they can — which is not the same as outranking them. A manager sits above an
 * accountant by title and cannot see payroll; under the old rule they could
 * reset the accountant and read every salary in the salon by signing in as them.
 *
 * That comparison lives in core/user-authority.ts, along with the reason equal
 * reach is only enough between owners.
 */
export async function resetUserPassword(id: string) {
  const tenantId = requireTenantId();
  const actorContext = getContext();

  const target = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      overrides: { select: { permission: true, allow: true } },
    },
  });
  if (!target) throw NotFound('User');
  if (!target.isActive) throw BadRequest('That login is switched off. Switch it back on first.');

  if (!actorContext?.userId || !actorContext.role) throw Forbidden('Sign in again to do this');

  /**
   * The actor's OWN overrides are read, not just their role.
   *
   * Comparing role defaults would get the answer wrong in both directions: a
   * manager granted payroll by override should be able to reset the accountant,
   * and a manager who has had a permission taken away should not be able to
   * reset somebody who still has it. The stored overrides are the truth.
   */
  const actorRow = await prisma.user.findUnique({
    where: { id: actorContext.userId },
    select: { id: true, role: true, overrides: { select: { permission: true, allow: true } } },
  });
  if (!actorRow) throw Forbidden('Sign in again to do this');

  const verdict = canResetPasswordOf(
    { id: actorRow.id, role: actorRow.role, permissions: resolvePermissions(actorRow.role, actorRow.overrides) },
    { id: target.id, role: target.role, permissions: resolvePermissions(target.role, target.overrides) },
  );

  if (!verdict.ok) {
    /**
     * A sole owner is the one case with no answer inside the salon, and the
     * refusal says where to go instead. "Forbidden" on its own leaves somebody
     * clicking the same button harder.
     */
    if (target.role === 'OWNER') {
      const owners = await prisma.user.count({ where: { tenantId, role: 'OWNER', isActive: true } });
      if (resetIsHandledByPlatform(target.role, Math.max(0, owners - 1))) {
        throw Forbidden(
          'This is the salon’s only owner, so nobody here can reset it. They should use “I cannot sign in” on the login screen — support will verify them and email a reset link to the address on the account.',
        );
      }
    }
    throw Forbidden(verdict.reason);
  }

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true } }),
    /**
     * Every session ends, including one that is open right now.
     *
     * A password is often reset precisely because somebody else has the old one
     * and may be signed in with it. Leaving their session alive would make the
     * reset cosmetic — they keep working until the access token happens to
     * expire, which could be hours.
     */
    prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    // Their open request, if they raised one, is now answered.
    closeOpenRequest(id, { userId: actorRow.id, name: actorContext.actorName ?? 'A colleague' }),
  ]);
  invalidateIdentity(id);

  /**
   * Returned once and never stored in readable form. The caller shows it on
   * screen for as long as the dialog is open; after that the only way to another
   * one is another reset, which is another audit row.
   */
  return { reset: true, password, name: target.name, email: target.email };
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

import { describe, expect, it } from 'vitest';
import type { UserRole } from '@prisma/client';
import {
  canResetPasswordOf,
  resetIsHandledByPlatform,
  temporaryPassword,
  type Principal,
} from '../src/core/user-authority';
import { PERMISSIONS, resolvePermissions } from '../src/core/permissions';
import { isAllowedWhilePasswordPending } from '../src/middleware/must-change-password';

/**
 * RESETTING SOMEBODY'S PASSWORD HANDS YOU THEIR ACCOUNT.
 *
 * Every test here is that one sentence applied to a pair of people. The rule
 * under test is not "does the senior title win" — it is "can the person doing
 * the reset already do everything the person being reset can do", because that
 * is the only formulation under which nobody finishes a reset with more reach
 * than they started with.
 */
const person = (id: string, role: UserRole, extra: string[] = [], removed: string[] = []): Principal => ({
  id,
  role,
  permissions: resolvePermissions(role, [
    ...extra.map((permission) => ({ permission, allow: true })),
    ...removed.map((permission) => ({ permission, allow: false })),
  ]),
});

describe('who may reset whom', () => {
  it('lets a manager reset a receptionist', () => {
    // The everyday case, and the one this whole feature exists for: somebody is
    // locked out of the till at eight in the morning.
    expect(canResetPasswordOf(person('m', 'MANAGER'), person('r', 'RECEPTIONIST')).ok).toBe(true);
  });

  it('lets a manager reset a stylist', () => {
    /**
     * A stylist holds `staff.self` and `appointment.view_own`, which a manager
     * does not — and must not count against them. Those two NARROW what somebody
     * sees rather than widening it: a manager sees every appointment, which
     * includes the stylist's own. Counted as privileges they would make the
     * commonest reset in a salon impossible.
     */
    expect(canResetPasswordOf(person('m', 'MANAGER'), person('s', 'STYLIST')).ok).toBe(true);
  });

  it('stops a manager resetting the accountant', () => {
    /**
     * THE CASE THAT PROVES ROLE RANK IS THE WRONG TEST.
     *
     * By title a manager sits above an accountant. By permission the accountant
     * can read payroll and the manager cannot — so the reset would put every
     * salary in the salon one login away from somebody not entitled to see it.
     */
    const verdict = canResetPasswordOf(person('m', 'MANAGER'), person('a', 'ACCOUNTANT'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain(PERMISSIONS.PAYROLL_VIEW);
  });

  it('stops a manager resetting a regional manager', () => {
    // Same reasoning: a regional manager has financial reporting and payroll
    // sight that a branch manager does not.
    expect(canResetPasswordOf(person('m', 'MANAGER'), person('rm', 'REGIONAL_MANAGER')).ok).toBe(false);
  });

  it('stops an admin resetting an owner', () => {
    // An owner holds tenant.manage and an admin does not. This was the one rule
    // the old code had, and it survives the rewrite for a better reason.
    expect(canResetPasswordOf(person('a', 'ADMIN'), person('o', 'OWNER')).ok).toBe(false);
  });

  it('lets an owner reset anybody, including another owner', () => {
    for (const role of ['ADMIN', 'REGIONAL_MANAGER', 'MANAGER', 'RECEPTIONIST', 'STYLIST', 'ACCOUNTANT', 'OWNER'] as UserRole[]) {
      expect(canResetPasswordOf(person('o1', 'OWNER'), person('t', role)).ok).toBe(true);
    }
  });

  it('stops an admin taking over another admin', () => {
    /**
     * Equal reach is not enough. Two admins can do exactly the same things, so
     * no permission is gained — but the account gained belongs to the colleague
     * most likely to notice what the first one is doing. Peer takeover goes up a
     * level; owners are the exception because nobody is above them.
     */
    const verdict = canResetPasswordOf(person('a1', 'ADMIN'), person('a2', 'ADMIN'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/same access/i);
  });

  it('stops a manager taking over another manager', () => {
    expect(canResetPasswordOf(person('m1', 'MANAGER'), person('m2', 'MANAGER')).ok).toBe(false);
  });

  it('never lets anyone reset themselves', () => {
    // Self-service is Change password, which asks for the current one first.
    // Allowing it here would turn "already signed in" into "may set a new
    // password without knowing the old" — the check protecting a terminal
    // somebody walked away from.
    const owner = person('same', 'OWNER');
    const verdict = canResetPasswordOf(owner, owner);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/Change password/i);
  });

  it('follows the permissions, not the role, when they have been overridden', () => {
    // Grant a manager payroll sight and they can now reset the accountant. The
    // rule needs no editing for this: whoever granted the permission granted the
    // reach that comes with it.
    const empowered = person('m', 'MANAGER', [
      PERMISSIONS.PAYROLL_VIEW,
      PERMISSIONS.PAYROLL_MANAGE,
      PERMISSIONS.REPORT_FINANCIAL,
    ]);
    expect(canResetPasswordOf(empowered, person('a', 'ACCOUNTANT')).ok).toBe(true);
  });

  it('turns against an actor who has had a permission taken away', () => {
    // And the same in reverse. A manager with invoice.void removed can no longer
    // reset a receptionist who... does not have it either — so use a permission
    // the receptionist does hold.
    const diminished = person('m', 'MANAGER', [], [PERMISSIONS.PAYMENT_MANAGE]);
    expect(canResetPasswordOf(diminished, person('r', 'RECEPTIONIST')).ok).toBe(false);
  });

  it('lifts a receptionist out of reach by giving them one extra permission', () => {
    const special = person('r', 'RECEPTIONIST', [PERMISSIONS.PAYROLL_VIEW]);
    expect(canResetPasswordOf(person('m', 'MANAGER'), special).ok).toBe(false);
  });
});

describe('which lockouts a salon cannot solve for itself', () => {
  it('is only an owner, and only when they are the last one', () => {
    expect(resetIsHandledByPlatform('OWNER', 0)).toBe(true);
    expect(resetIsHandledByPlatform('OWNER', 1)).toBe(false);
  });

  it('is never anybody else, however senior', () => {
    for (const role of ['ADMIN', 'REGIONAL_MANAGER', 'MANAGER', 'RECEPTIONIST', 'STYLIST', 'ACCOUNTANT'] as UserRole[]) {
      expect(resetIsHandledByPlatform(role, 0)).toBe(false);
    }
  });
});

describe('the temporary password', () => {
  it('satisfies the rule the app enforces on every other password', () => {
    // Generated and rejected by the same app would be a comic failure, and one
    // that only shows up in front of a customer at the counter.
    for (let i = 0; i < 200; i += 1) {
      const password = temporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password).toMatch(/[a-zA-Z]/);
      expect(password).toMatch(/\d/);
    }
  });

  it('leaves out every character that gets misheard across a counter', () => {
    // O/0, I/l/1, S/5, B/8, Z/2. This is read aloud or copied off a screen, and
    // a password nobody can dictate is a phone call to the manager.
    for (let i = 0; i < 200; i += 1) {
      expect(temporaryPassword()).not.toMatch(/[O0Il1S5B8Z2]/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 300 }, () => temporaryPassword()));
    expect(seen.size).toBe(300);
  });

  it('is grouped so a person can say it out loud', () => {
    expect(temporaryPassword()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });
});

describe('what a temporary password may reach before it is changed', () => {
  it('opens only the way out of the state', () => {
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/auth/change-password',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      '/api/v1/auth/logout-all',
    ]) {
      expect(isAllowedWhilePasswordPending(path)).toBe(true);
    }
  });

  it('opens nothing else', () => {
    // A password read out in a busy salon may well have been overheard, and the
    // window before it is changed is exactly when it is worth the least.
    for (const path of [
      '/api/v1/customers',
      '/api/v1/appointments',
      '/api/v1/invoices',
      '/api/v1/users',
      '/api/v1/reports/revenue',
      '/api/v1/auth/login',
    ]) {
      expect(isAllowedWhilePasswordPending(path)).toBe(false);
    }
  });
});

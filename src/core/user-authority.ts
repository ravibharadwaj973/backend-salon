import { randomInt } from 'node:crypto';
import type { UserRole } from '@prisma/client';
import { PERMISSIONS } from './permissions';

/**
 * WHO MAY RESET WHOSE PASSWORD.
 *
 * Resetting somebody's password is not an administrative chore. It hands you
 * their account: you choose the credential, so for the next few minutes you can
 * sign in as them and do anything they can do. Every rule in this file follows
 * from that one sentence.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * You may reset somebody only when everything they can do, you can already do.
 * Not "when your role outranks theirs" — role is a label and labels drift. The
 * thing that must not happen is a person ending a reset with more reach than
 * they started with, and the only honest test of that is comparing the two
 * permission sets.
 *
 * A worked example of why the label is not enough. A manager may not view
 * payroll; an accountant may. Ranked by seniority a manager sits above an
 * accountant and could reset them — and would then be one login away from every
 * salary in the salon. Compared by permission, the accountant holds
 * `payroll.view` and the manager does not, so the reset is refused. Nobody had
 * to remember to write that rule down; it falls out.
 *
 * It also self-maintains. Grant a receptionist one extra permission by override
 * and managers stop being able to reset them, automatically, on the next
 * request. Add a new permission to the app and nothing here needs editing.
 *
 * ── The one exception, and why it is only for owners ─────────────────────
 *
 * Equal reach is not enough — you need MORE than the person you are resetting.
 * Two admins have identical permissions, so without this an admin could take
 * over the account of the colleague most likely to notice what they were doing.
 * Peer-to-peer takeover goes up a level.
 *
 * Owners are the exception, because they have to be. An owner's reach is the
 * whole salon, so no one inside it has more; if owners could not reset each
 * other, two partners would have no way to help one another back in, and the
 * only route left would be a support ticket for something they are perfectly
 * entitled to do themselves.
 */

/**
 * Permissions that NARROW what somebody may see rather than widen it.
 *
 * "Own appointments only" is not a power a manager lacks — a manager sees every
 * appointment, which includes those. Counted as a privilege, these two would
 * make a stylist un-resettable by their own manager, which is the single
 * commonest reset in a salon and exactly the thing this feature is for.
 */
const SELF_SCOPED: readonly string[] = [PERMISSIONS.STAFF_SELF, PERMISSIONS.APPOINTMENT_VIEW_OWN];

export interface Principal {
  id: string;
  role: UserRole;
  /** Their resolved permissions — role plus per-user overrides, as the app uses. */
  permissions: Set<string>;
}

export type ResetVerdict = { ok: true } | { ok: false; reason: string };

/** What the target can do that the actor cannot. Empty means "no more reach". */
function reachBeyond(actor: Principal, target: Principal): string[] {
  const extra: string[] = [];
  for (const permission of target.permissions) {
    if (SELF_SCOPED.includes(permission)) continue;
    if (!actor.permissions.has(permission)) extra.push(permission);
  }
  return extra;
}

export function canResetPasswordOf(actor: Principal, target: Principal): ResetVerdict {
  /**
   * Your own password is changed, not reset — and changing it means proving you
   * know the current one. Allowing yourself through here would turn "I am
   * already signed in" into "I may set a new password without knowing the old",
   * which quietly undoes the only check protecting an unattended terminal.
   */
  if (actor.id === target.id) {
    return {
      ok: false,
      reason: 'Use Change password to set your own — it asks for your current one first.',
    };
  }

  const extra = reachBeyond(actor, target);
  if (extra.length > 0) {
    return {
      ok: false,
      // Named rather than counted. "You cannot reset this user" leaves somebody
      // guessing; naming the permission tells them who CAN, which is the next
      // thing they need to know.
      reason: `They can do things you cannot (${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', …' : ''}), so resetting them would hand you access you do not have. Ask an owner.`,
    };
  }

  /**
   * Same reach, both owners: allowed, for the reason above. Same reach and not
   * owners: refused, because that is taking a peer's account.
   */
  if (actor.role !== 'OWNER' && reachBeyond(target, actor).length === 0) {
    return {
      ok: false,
      reason: 'They have the same access as you. Resetting a colleague at your own level is an owner’s decision.',
    };
  }

  return { ok: true };
}

/**
 * Whether this person's own way back in runs through the salon or through us.
 *
 * An owner locked out cannot be helped from inside: nobody in the salon outranks
 * them, and if they are the only owner there is nobody with equal reach either.
 * That is the case support exists for — and the only case, because for everybody
 * else the answer is standing in the same building.
 */
export function resetIsHandledByPlatform(role: UserRole, otherActiveOwners: number): boolean {
  return role === 'OWNER' && otherActiveOwners === 0;
}

/**
 * A TEMPORARY PASSWORD THAT SURVIVES BEING READ ALOUD.
 *
 * This is handed over across a counter or down a phone line, so the alphabet
 * leaves out every pair that gets misheard or miscopied: no O or 0, no I, l or
 * 1, no S against 5, no B against 8. What is left is 28 symbols, and three
 * groups of four of them is a little over 57 bits — far beyond anything that
 * matters for a credential which is single-use and expires the moment it is
 * typed in.
 *
 * Grouped with dashes because "K7NP dash 3RQX dash 9WTM" is a thing a person can
 * say, and an ungrouped run of twelve is a thing they get wrong halfway through
 * and have to start again.
 *
 * `randomInt` from node:crypto, not Math.random. A password generated from a
 * predictable stream is not a password, and the mistake is invisible in every
 * test that only checks the format.
 */
const SAFE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

export function temporaryPassword(): string {
  const groups = [0, 1, 2].map(() =>
    Array.from({ length: 4 }, () => SAFE_ALPHABET[randomInt(SAFE_ALPHABET.length)]).join(''),
  );
  const password = groups.join('-');

  /**
   * The app's own password rule asks for a letter and a digit, and a run of
   * twelve from this alphabet can legitimately come out all letters. Rather than
   * patching a character in — which biases a known position — draw again. It
   * happens about one time in fifty and costs nothing.
   */
  return /\d/.test(password) && /[A-Z]/.test(password) ? password : temporaryPassword();
}

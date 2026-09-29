import { sendabilityProblem } from './whatsapp-templates';

/**
 * WHICH TEMPLATE, WHEN A SALON HAS SEVERAL BY THE SAME NAME.
 *
 * ── The bug this exists for ───────────────────────────────────────────────
 *
 * One salon had three WhatsApp templates called `review_request`: one approved
 * by Meta, named, with its placeholders mapped — and two drafts that had never
 * been submitted to anybody. The lookup was `findFirst` with no ordering, so
 * Postgres returned whichever row it felt like, and it kept returning a draft.
 *
 * The rest of the machinery then did its job perfectly: a draft cannot send on
 * WhatsApp, so the send fell back to the email twin. From the salon's side they
 * picked WhatsApp, got an email, and their genuinely approved template appeared
 * to be ignored. Every part was behaving correctly except the one line that
 * decided WHICH row we were talking about.
 *
 * ── Why choosing beats forbidding ────────────────────────────────────────
 *
 * The right long answer is a unique index on (tenant, name, channel). That
 * cannot be added while duplicates exist, and adding it later still leaves
 * this code choosing between rows at the moment the index is created. So the
 * choice is made explicit and deterministic here, and stays correct whether or
 * not the duplicates are ever cleaned up.
 *
 * `findFirst` with no `orderBy` is not a small sin. It reads as "any of them
 * will do", and the day that stops being true the failure is invisible,
 * intermittent, and lands somewhere else entirely.
 */

export interface PickableTemplate {
  id: string;
  name: string;
  channel: string;
  approvalStatus: string;
  providerTemplateName: string | null;
  rejectedReason?: string | null;
  variables?: string[];
  metaVariableOrder?: string[];
  updatedAt?: Date | null;
}

/**
 * Higher is better. Deliberately coarse: the only question is "would this one
 * actually reach the customer", and everything else is a tiebreak.
 */
function score(template: PickableTemplate): number {
  let value = 0;
  // The whole point: a template that can send beats one that cannot, whatever
  // else is true of it.
  if (!sendabilityProblem(template as never)) value += 100;
  if (template.approvalStatus === 'APPROVED') value += 10;
  if (template.providerTemplateName) value += 5;
  // A rejected or disabled row should lose even to a draft: a draft can be
  // submitted, those two can never be used again.
  if (template.approvalStatus === 'REJECTED' || template.approvalStatus === 'DISABLED') value -= 50;
  return value;
}

/**
 * The best of the rows with this name, or null when there are none.
 *
 * Ties break on the most recently updated, then on id — so the same set of
 * rows always yields the same answer. An intermittently-correct send is worse
 * than a consistently wrong one: it cannot be reproduced, and it teaches the
 * salon that the app is unreliable rather than that something needs fixing.
 */
export function pickTemplate<T extends PickableTemplate>(templates: T[]): T | null {
  if (templates.length === 0) return null;

  return [...templates].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const byDate = (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
    if (byDate !== 0) return byDate;
    return a.id.localeCompare(b.id);
  })[0]!;
}

/** True when a salon has more than one row for this name and channel. */
export function hasDuplicates(templates: PickableTemplate[]): boolean {
  return templates.length > 1;
}

import { describe, expect, it } from 'vitest';
import { hasDuplicates, pickTemplate, type PickableTemplate } from '../src/messaging/pick-template';

/**
 * THE SHAPE OF THE REAL BUG.
 *
 * A salon had three WhatsApp templates called `review_request`: one approved
 * by Meta, named, placeholders mapped — and two drafts submitted to nobody.
 * `findFirst` with no ordering kept returning a draft, a draft cannot send, so
 * the message fell back to email and the approved template appeared to be
 * ignored. Everything was working except the line that chose the row.
 */
const base: PickableTemplate = {
  id: 'a',
  name: 'review_request',
  channel: 'WHATSAPP',
  approvalStatus: 'DRAFT',
  providerTemplateName: null,
  variables: ['customer_name', 'salon_name', 'feedback_link'],
  metaVariableOrder: [],
};

const approved: PickableTemplate = {
  ...base,
  id: 'b',
  approvalStatus: 'APPROVED',
  providerTemplateName: 'review_request',
  metaVariableOrder: ['customer_name', 'salon_name', 'feedback_link'],
};

describe('choosing between templates of the same name', () => {
  it('picks the one that can actually send', () => {
    expect(pickTemplate([base, approved, { ...base, id: 'c' }])?.id).toBe('b');
  });

  it('picks it whatever order the database returns them in', () => {
    // The original fault was order-dependence, so this is the assertion that
    // matters: no arrangement of the same rows may change the answer.
    const rows = [base, approved, { ...base, id: 'c' }];
    for (const order of [rows, [...rows].reverse(), [rows[2]!, rows[0]!, rows[1]!]]) {
      expect(pickTemplate(order)?.id).toBe('b');
    }
  });

  it('prefers a draft to a rejected or disabled one', () => {
    // A draft can be submitted. Those two can never be used again, so they
    // must lose even to something unfinished.
    expect(pickTemplate([{ ...base, id: 'r', approvalStatus: 'REJECTED' }, base])?.id).toBe('a');
    expect(pickTemplate([{ ...base, id: 'd', approvalStatus: 'DISABLED' }, base])?.id).toBe('a');
  });

  it('refuses an approved template with no Meta name, in favour of one with', () => {
    // Approved but unnamed cannot be addressed, so the send would fall back to
    // free-form text and Meta would refuse it outside the 24-hour window.
    const unnamed = { ...approved, id: 'u', providerTemplateName: null };
    expect(pickTemplate([unnamed, approved])?.id).toBe('b');
  });

  it('is deterministic when nothing separates them', () => {
    const one = { ...base, id: 'x' };
    const two = { ...base, id: 'y' };
    expect(pickTemplate([one, two])?.id).toBe(pickTemplate([two, one])?.id);
  });

  it('prefers the most recently updated of two equals', () => {
    const older = { ...approved, id: 'old', updatedAt: new Date('2026-01-01') };
    const newer = { ...approved, id: 'new', updatedAt: new Date('2026-06-01') };
    expect(pickTemplate([older, newer])?.id).toBe('new');
  });

  it('returns null rather than throwing when there are none', () => {
    expect(pickTemplate([])).toBeNull();
  });

  it('notices duplicates, so they can be logged', () => {
    expect(hasDuplicates([base])).toBe(false);
    expect(hasDuplicates([base, approved])).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { timesToOffer } from '../src/modules/messaging/assistant-tools';
import type { SlotOffer } from '../src/modules/messaging/assistant-tools';

/**
 * ONE TIME, SAID ONCE.
 *
 * `checkAvailability` returns an offer per staff member, so two technicians free
 * at ten produce two slots labelled "10:00". Read straight into a sentence that
 * became, verbatim, in a real customer's thread:
 *
 *     "we have 10:00, 10:00, 10:15, 10:15. Shall I book 10:00?"
 */
const slot = (label: string, staffName: string): SlotOffer => ({
  serviceId: 's1',
  serviceName: 'Gel Nail Extensions',
  startAt: new Date(`2026-09-30T${label}:00Z`),
  staffId: staffName,
  staffName,
  label,
});

describe('the times named in an offer', () => {
  it('says each time once however many people are free for it', () => {
    const slots = [
      slot('10:00', 'Pooja'),
      slot('10:00', 'Anita'),
      slot('10:15', 'Pooja'),
      slot('10:15', 'Anita'),
    ];

    expect(timesToOffer(slots)).toBe('10:00, 10:15');
  });

  it('keeps them soonest first, as they arrive', () => {
    expect(timesToOffer([slot('11:30', 'A'), slot('10:00', 'B'), slot('10:45', 'C')])).toBe(
      '11:30, 10:00, 10:45',
    );
  });

  it('names at most four, because a longer list is a menu not an offer', () => {
    const slots = ['10:00', '10:15', '10:30', '10:45', '11:00', '11:15'].map((l) => slot(l, 'A'));
    expect(timesToOffer(slots)).toBe('10:00, 10:15, 10:30, 10:45');
  });

  it('counts distinct times towards that limit, not rows', () => {
    // Four rows that are two times must not use up the whole allowance.
    const slots = [
      slot('10:00', 'A'),
      slot('10:00', 'B'),
      slot('10:15', 'A'),
      slot('10:15', 'B'),
      slot('10:30', 'A'),
      slot('10:45', 'A'),
    ];
    expect(timesToOffer(slots)).toBe('10:00, 10:15, 10:30, 10:45');
  });

  it('gives back nothing for nothing', () => {
    expect(timesToOffer([])).toBe('');
  });
});

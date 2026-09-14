import { describe, expect, it } from 'vitest';
import { FIELD_BY_KEY, SEGMENT_FIELDS, SEGMENT_PRESETS } from '../src/modules/marketing/segment-fields';
import { daysUntilAnniversaryOf } from '../src/modules/marketing/segment.service';

/**
 * The catalogue is read by the builder to decide which control to draw, and by
 * the rule compiler to decide what a condition means. These tests keep the two
 * honest about each other: a field offered in the UI that the compiler cannot
 * translate is a segment that silently matches everybody.
 */
describe('the segment field catalogue', () => {
  it('has no duplicate keys', () => {
    const keys = SEGMENT_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every field a group, a control and at least one operator', () => {
    for (const field of SEGMENT_FIELDS) {
      expect(field.group, field.key).toBeTruthy();
      expect(field.input, field.key).toBeTruthy();
      expect(field.ops.length, field.key).toBeGreaterThan(0);
    }
  });

  it('covers what a salon actually asks about', () => {
    // Each of these answers a question an owner has out loud. Losing one is a
    // regression even though nothing would fail to compile.
    for (const key of [
      'onlyOneVisit', // did they try us and never come back?
      'notBilledInLastDays', // who has gone quiet?
      'notUsedCategory', // who has never tried colour?
      'ratedAtLeast', // who is happy enough to ask for a review?
      'membershipExpiringInDays', // whose renewal is coming?
      'reachableOn', // who can we actually message?
    ]) {
      expect(FIELD_BY_KEY.has(key), key).toBe(true);
    }
  });

  it('marks the occasion fields as needing a pass in memory', () => {
    // These ignore the year, which no SQL filter here can express — so the
    // preview has to know it cannot trust a plain count.
    for (const key of ['birthdayMonth', 'birthdayInNextDays', 'anniversaryInNextDays']) {
      expect(FIELD_BY_KEY.get(key)?.postFilter, key).toBe(true);
    }
  });
});

describe('the ready-made segments', () => {
  it('only uses fields the compiler knows', () => {
    for (const preset of SEGMENT_PRESETS) {
      for (const condition of preset.rules.conditions) {
        expect(FIELD_BY_KEY.has(condition.field), `${preset.key} → ${condition.field}`).toBe(true);
      }
    }
  });

  it('only uses operators that field allows', () => {
    for (const preset of SEGMENT_PRESETS) {
      for (const condition of preset.rules.conditions) {
        const field = FIELD_BY_KEY.get(condition.field)!;
        expect(field.ops, `${preset.key} → ${condition.field} ${condition.op}`).toContain(condition.op);
      }
    }
  });

  it('explains why each one is worth sending to', () => {
    for (const preset of SEGMENT_PRESETS) {
      expect(preset.name, preset.key).toBeTruthy();
      expect(preset.why.length, preset.key).toBeGreaterThan(20);
    }
  });

  it('has no duplicate keys or names', () => {
    expect(new Set(SEGMENT_PRESETS.map((p) => p.key)).size).toBe(SEGMENT_PRESETS.length);
    expect(new Set(SEGMENT_PRESETS.map((p) => p.name)).size).toBe(SEGMENT_PRESETS.length);
  });
});

describe('how many days until the next birthday', () => {
  const on = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it('counts forward within the same year', () => {
    expect(daysUntilAnniversaryOf(on('1990-09-20'), on('2026-09-14'))).toBe(6);
  });

  it('is zero on the day itself', () => {
    expect(daysUntilAnniversaryOf(on('1990-09-14'), on('2026-09-14'))).toBe(0);
  });

  it('wraps into next year once the date has passed', () => {
    // The case that makes a naive implementation return a negative number and
    // quietly match nobody in late December.
    expect(daysUntilAnniversaryOf(on('1990-01-02'), on('2026-12-28'))).toBe(5);
  });

  it('ignores the year the customer was born', () => {
    const young = daysUntilAnniversaryOf(on('2005-03-01'), on('2026-02-25'));
    const old = daysUntilAnniversaryOf(on('1955-03-01'), on('2026-02-25'));
    expect(young).toBe(old);
    expect(young).toBe(4);
  });
});

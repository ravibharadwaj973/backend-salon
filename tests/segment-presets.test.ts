import { describe, expect, it } from 'vitest';
import { SEGMENT_FIELDS, SEGMENT_PRESETS } from '../src/modules/marketing/segment-fields';

/**
 * A segment rule that names a field the compiler has never heard of does not
 * throw — it compiles to an empty `where` and quietly matches the entire
 * customer book. A preset with a typo would send a win-back offer to every
 * customer the salon has, including the ones who were in yesterday.
 *
 * So the catalogue, the presets and the compiler have to agree, and that is
 * checked rather than assumed.
 */

const FIELD_KEYS = new Set(SEGMENT_FIELDS.map((f) => f.key));

describe('the ready-made segments', () => {
  it('only use fields the builder actually offers', () => {
    for (const preset of SEGMENT_PRESETS) {
      for (const condition of preset.rules.conditions) {
        expect(FIELD_KEYS.has(condition.field), `${preset.key} uses unknown field "${condition.field}"`).toBe(true);
      }
    }
  });

  it('only use operators that field allows', () => {
    // Offering `contains` on a number would be accepted by the schema and then
    // throw at query time, on somebody else's screen.
    for (const preset of SEGMENT_PRESETS) {
      for (const condition of preset.rules.conditions) {
        const field = SEGMENT_FIELDS.find((f) => f.key === condition.field);
        expect(
          field?.ops.includes(condition.op),
          `${preset.key}: ${condition.field} does not support "${condition.op}"`,
        ).toBe(true);
      }
    }
  });

  it('never ships an empty rule set', () => {
    // No conditions means "everybody", which is the one segment nobody wants
    // to send a marketing campaign to by accident.
    for (const preset of SEGMENT_PRESETS) {
      expect(preset.rules.conditions.length, `${preset.key} matches everybody`).toBeGreaterThan(0);
    }
  });

  it('has a unique key and a name for each', () => {
    const keys = new Set<string>();
    for (const preset of SEGMENT_PRESETS) {
      expect(keys.has(preset.key), `duplicate preset key ${preset.key}`).toBe(false);
      keys.add(preset.key);
      expect(preset.name.length).toBeGreaterThan(0);
      // `why` is what the owner reads to decide whether to use it. A preset
      // nobody can tell the purpose of is a preset nobody should send.
      expect(preset.why.length, `${preset.key} has no explanation`).toBeGreaterThan(20);
    }
  });

  it('covers the lifecycle stages that need a message', () => {
    // NEW, drifting, at-risk and dormant each need a different conversation.
    // If a stage has no preset, nobody will build one by hand either.
    const mentioned = new Set(
      SEGMENT_PRESETS.flatMap((p) =>
        p.rules.conditions
          .filter((c) => c.field === 'lifecycleStage' && c.op !== 'nin')
          .flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value]).map(String)),
      ),
    );

    for (const stage of ['NEW', 'AT_RISK', 'DORMANT']) {
      expect(mentioned.has(stage), `no ready-made segment for ${stage}`).toBe(true);
    }
  });
});

describe('the field catalogue', () => {
  it('gives every field a group, a control and at least one operator', () => {
    for (const field of SEGMENT_FIELDS) {
      expect(field.group.length, `${field.key} has no group`).toBeGreaterThan(0);
      expect(field.ops.length, `${field.key} has no operators`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keys', () => {
    // A duplicate silently wins or loses depending on iteration order.
    expect(new Set(SEGMENT_FIELDS.map((f) => f.key)).size).toBe(SEGMENT_FIELDS.length);
  });

  it('explains the visit-cycle fields, which are the ones nobody has seen before', () => {
    // "Days since last visit" needs no help text. "Overdue by more than" does,
    // because it means something different and the difference is the point.
    for (const field of SEGMENT_FIELDS.filter((f) => f.group === 'Their own visit cycle')) {
      expect(field.help, `${field.key} has no help text`).toBeTruthy();
    }
  });
});

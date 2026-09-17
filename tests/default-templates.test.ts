import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';

/**
 * The starter templates every new salon is seeded with.
 *
 * A salon that has email switched on and no email templates sees an empty
 * picker on the Email tab, which reads as a broken screen rather than as an
 * empty cupboard — and the only way out is to write every message by hand.
 * Every channel a salon can send on ships with something to send.
 */

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;

describe('the starter templates', () => {
  it('gives every sendable channel something to start from', () => {
    for (const channel of CHANNELS) {
      expect(DEFAULT_TEMPLATES.filter((t) => t.channel === channel).length).toBeGreaterThan(0);
    }
  });

  it('has no two templates with the same name on the same channel', () => {
    // The unique key is (tenant, name, channel) and seeding uses
    // skipDuplicates, so a clash here would silently seed one and drop the
    // other — with no error anywhere to say which.
    const seen = new Set<string>();
    for (const t of DEFAULT_TEMPLATES) {
      const key = `${t.name}::${t.channel}`;
      expect(seen.has(key), `duplicate starter template: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('gives every email a subject line', () => {
    // An email with no subject lands as "(no subject)" and reads as spam.
    for (const t of DEFAULT_TEMPLATES.filter((t) => t.channel === 'EMAIL')) {
      expect(t.headerText, `${t.name} has no subject`).toBeTruthy();
    }
  });

  it('declares every placeholder it uses, and uses every one it declares', () => {
    // A placeholder missing from `variables` is not offered in the editor and
    // renders as literal {{braces}} in a customer's message.
    for (const t of DEFAULT_TEMPLATES) {
      const used = new Set(
        [...`${t.bodyText} ${t.headerText ?? ''}`.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!),
      );
      expect([...used].sort(), `${t.name} (${t.channel}) declares the wrong variables`).toEqual(
        [...new Set(t.variables)].sort(),
      );
    }
  });

  it('marks email approved and the other two as needing approval', () => {
    // There is nobody to approve an email. WhatsApp waits for Meta and SMS
    // waits for DLT registration, so those start as drafts — claiming they are
    // approved would send a salon straight into a provider rejection.
    for (const t of DEFAULT_TEMPLATES) {
      if (t.channel === 'EMAIL') expect(t.approvalStatus, t.name).toBe('APPROVED');
      else expect(t.approvalStatus, `${t.name} (${t.channel})`).toBe('DRAFT');
    }
  });

  it('keeps every SMS inside one segment', () => {
    // Two segments is two messages and twice the bill. Placeholders are
    // measured at a realistic filled length rather than as {{braces}}.
    for (const t of DEFAULT_TEMPLATES.filter((t) => t.channel === 'SMS')) {
      const filled = t.bodyText.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, 'x'.repeat(14));
      expect(filled.length, `${t.name} is ${filled.length} characters`).toBeLessThanOrEqual(160);
    }
  });

  it('never labels an offer as a utility message', () => {
    // WhatsApp utility is ~7.5x cheaper than marketing, and mislabelling a
    // promotional message is how a salon gets its number blocked.
    const promotional = DEFAULT_TEMPLATES.filter((t) => /offer|winback|birthday|rebooking/.test(t.name));
    for (const t of promotional) {
      expect(t.category, `${t.name} (${t.channel})`).toBe('MARKETING');
    }
  });
});

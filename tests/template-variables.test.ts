import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_IN_CAMPAIGN,
  PER_RECORD,
  campaignReadiness,
  classifyForCampaign,
  readinessProblem,
  variablesIn,
} from '../src/messaging/template-variables';

/**
 * These tests exist because of a real send. A campaign called "test-utilty",
 * using the `appointment_cancelled` template, reported success, charged nothing
 * and delivered nothing. Every message was skipped with the same line:
 *
 *   appointment_date had no value, so the customer would have read a blank
 *
 * The template needs an appointment. A campaign has a segment, and a segment
 * contains people. The send was impossible before it began, and nothing said so
 * until it was over — the failure was discovered once per recipient.
 */

const AUTO_ONLY = 'Hi {{customer_name}}, {{salon_name}} misses you. Book at {{booking_link}}';
const NEEDS_FILLING = 'Hi {{customer_name}}, {{discount}} off until {{valid_till}}!';
const THE_BROKEN_ONE = 'Your appointment on {{appointment_date}} at {{appointment_time}} was cancelled.';
const LEAKY = 'Hi {{customer_name}}, your bill is ready: {{invoice_link}}';

describe('finding a template’s blanks', () => {
  it('reads them out of the body', () => {
    expect(variablesIn(NEEDS_FILLING)).toEqual(['customer_name', 'discount', 'valid_till']);
  });

  it('looks in the heading and buttons too, not only the body', () => {
    // A variable hiding in a button URL fails the send exactly as loudly as one
    // in the body, and is far easier to miss.
    expect(variablesIn('Hi {{customer_name}}', '{{offer}} inside', '[{"url":"x/{{code}}"}]')).toEqual([
      'customer_name',
      'offer',
      'code',
    ]);
  });

  it('counts a repeated variable once', () => {
    expect(variablesIn('{{customer_name}} — hello {{customer_name}}')).toEqual(['customer_name']);
  });

  it('tolerates spaces inside the braces', () => {
    expect(variablesIn('Hi {{ customer_name }}')).toEqual(['customer_name']);
  });

  it('finds nothing in a template with no blanks', () => {
    expect(variablesIn('Happy Diwali from all of us!')).toEqual([]);
  });
});

describe('sorting the blanks into who fills them', () => {
  it('leaves what a campaign already knows alone', () => {
    const kinds = classifyForCampaign(AUTO_ONLY).map((v) => v.kind);
    expect(new Set(kinds)).toEqual(new Set(['AUTOMATIC']));
  });

  it('asks the sender for what the app cannot know', () => {
    const info = classifyForCampaign(NEEDS_FILLING);
    expect(info.find((v) => v.name === 'discount')?.kind).toBe('FILL_IN');
    expect(info.find((v) => v.name === 'valid_till')?.kind).toBe('FILL_IN');
    expect(info.find((v) => v.name === 'customer_name')?.kind).toBe('AUTOMATIC');
  });

  it('asks for an appointment date rather than silently failing on it', () => {
    // The exact template that produced the dead campaign. It is answerable —
    // the sender can type a date — and the whole point is that it is now asked.
    const info = classifyForCampaign(THE_BROKEN_ONE);
    expect(info.map((v) => v.kind)).toEqual(['FILL_IN', 'FILL_IN']);
  });

  it('gives each blank a label somebody would recognise', () => {
    const info = classifyForCampaign(THE_BROKEN_ONE);
    expect(info[0]!.label).toBe('Appointment date');
    // A blank box tells the sender nothing about the format expected.
    expect(info[0]!.example).toBeTruthy();
  });

  it('humanises a variable it has never seen', () => {
    // Salons write their own templates; an unknown name must still read as
    // words rather than as a database column.
    expect(classifyForCampaign('{{festival_name}}')[0]!.label).toBe('Festival name');
  });
});

/**
 * The part that is a privacy rule rather than a usability one.
 */
describe('refusing to share one customer’s record with a whole list', () => {
  it('blocks an invoice link outright', () => {
    const info = classifyForCampaign(LEAKY);
    expect(info.find((v) => v.name === 'invoice_link')?.kind).toBe('BLOCKED');
  });

  it('blocks every per-record link and number', () => {
    for (const name of PER_RECORD) {
      expect(classifyForCampaign(`x {{${name}}}`)[0]!.kind, name).toBe('BLOCKED');
    }
  });

  it('never treats a per-record variable as something to type in', () => {
    // This is the line that matters. If one of these were FILL_IN, the sender
    // would be handed a box, and one value typed there goes to everybody: four
    // hundred strangers receive the same customer's bill.
    for (const name of PER_RECORD) {
      const info = classifyForCampaign(`x {{${name}}}`)[0]!;
      expect(info.kind, name).not.toBe('FILL_IN');
    }
  });

  it('says why, in terms of what would happen', () => {
    const blocked = classifyForCampaign(LEAKY).find((v) => v.kind === 'BLOCKED');
    expect(blocked?.reason).toMatch(/everybody on the list/);
    // And where it CAN be used, so the answer is not just "no".
    expect(blocked?.reason).toMatch(/automation/);
  });

  it('keeps the two sets from overlapping', () => {
    // A variable in both would be classified by whichever check ran first,
    // which is not a decision anybody made.
    for (const name of PER_RECORD) {
      expect(AUTOMATIC_IN_CAMPAIGN.has(name), name).toBe(false);
    }
  });
});

describe('deciding whether a campaign may go out', () => {
  it('lets a template through when nothing needs filling', () => {
    expect(campaignReadiness([AUTO_ONLY]).ok).toBe(true);
    expect(readinessProblem(campaignReadiness([AUTO_ONLY]))).toBeNull();
  });

  it('holds it back until the blanks are filled', () => {
    const before = campaignReadiness([NEEDS_FILLING]);
    expect(before.ok).toBe(false);
    expect(before.missing.map((v) => v.name)).toEqual(['discount', 'valid_till']);
  });

  it('lets it through once the sender supplies the values', () => {
    const after = campaignReadiness([NEEDS_FILLING], { discount: '20%', valid_till: '31 Oct' });
    expect(after.ok).toBe(true);
    expect(after.missing).toEqual([]);
  });

  it('does not accept a space as a value', () => {
    // A space passes a truthiness check and prints as a hole in the message,
    // which is the failure this whole module is about.
    expect(campaignReadiness([NEEDS_FILLING], { discount: '   ', valid_till: '31 Oct' }).ok).toBe(false);
  });

  it('refuses a blocked template however much is filled in', () => {
    // No amount of typing makes it safe to send one person's bill to the list.
    const readiness = campaignReadiness([LEAKY], { invoice_link: 'https://example.com/anything' });
    expect(readiness.ok).toBe(false);
    expect(readiness.blocked).toHaveLength(1);
  });

  it('leads with the blocked problem, because filling boxes will not fix it', () => {
    const readiness = campaignReadiness([`${LEAKY} {{discount}}`]);
    expect(readinessProblem(readiness)).toMatch(/everybody on the list/);
  });

  it('names the fields, so the sender knows what to type', () => {
    const problem = readinessProblem(campaignReadiness([NEEDS_FILLING]));
    expect(problem).toMatch(/Discount/);
    expect(problem).toMatch(/Valid until/);
  });

  it('reads as a sentence with one field and with two', () => {
    // "needs Discount and Valid until" rather than "needs Discount, Valid until".
    expect(readinessProblem(campaignReadiness([NEEDS_FILLING]))).toMatch(/Discount and Valid until/);
    expect(readinessProblem(campaignReadiness(['{{discount}}']))).toMatch(/needs Discount filled in/);
  });

  it('would have stopped the campaign that started all this', () => {
    // The regression test for the actual incident: this template, sent to a
    // segment with no values supplied, is refused with the field named instead
    // of skipping every message.
    const readiness = campaignReadiness([THE_BROKEN_ONE], {});
    expect(readiness.ok).toBe(false);
    expect(readinessProblem(readiness)).toMatch(/Appointment date/);
  });
});

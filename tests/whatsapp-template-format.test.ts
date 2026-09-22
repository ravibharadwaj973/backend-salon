import { describe, expect, it } from 'vitest';
import { templateProblems, toMetaTemplate } from '../src/messaging/whatsapp-template-format';

/**
 * THE TRANSLATION BETWEEN OUR TEMPLATES AND META'S.
 *
 * Worth testing harder than most things here, because the failure mode is
 * silent. A wrong variable ORDER does not error, does not fail delivery and
 * does not appear in any log — it sends Priya's appointment time to Anjali,
 * and the first sign of it is a customer arriving on the wrong day.
 */

const base = {
  name: 'appointment_confirmation',
  language: 'en',
  category: 'UTILITY' as const,
  headerText: null,
  footerText: null,
  providerTemplateName: null,
};

describe('named variables become positional ones', () => {
  it('numbers them in order of first appearance', () => {
    const { payload, variableOrder } = toMetaTemplate({
      ...base,
      bodyText: 'Hi {{customer_name}}, your appointment at {{salon_name}} is at {{appointment_time}}. See you.',
    });

    const body = payload.components.find((c) => c.type === 'BODY');
    expect(body?.text).toBe('Hi {{1}}, your appointment at {{2}} is at {{3}}. See you.');
    expect(variableOrder).toEqual(['customer_name', 'salon_name', 'appointment_time']);
  });

  it('reuses the same number for a variable that appears twice', () => {
    // Meta counts distinct placeholders, not occurrences. Numbering the second
    // mention {{2}} would make Meta expect a parameter that is never sent, and
    // the send fails with a parameter-count mismatch.
    const { payload, variableOrder } = toMetaTemplate({
      ...base,
      bodyText: 'Hi {{customer_name}}, see you at {{salon_name}}. Thanks, {{customer_name}}!',
    });

    expect(payload.components.find((c) => c.type === 'BODY')?.text).toBe('Hi {{1}}, see you at {{2}}. Thanks, {{1}}!');
    expect(variableOrder).toEqual(['customer_name', 'salon_name']);
  });

  it('records the order that a reordered sentence would change', () => {
    // This is the whole reason variableOrder is stored rather than derived at
    // send time. The same two variables, swapped, produce a DIFFERENT mapping.
    const first = toMetaTemplate({ ...base, bodyText: 'Hi {{customer_name}}, welcome to {{salon_name}} today.' });
    const swapped = toMetaTemplate({ ...base, bodyText: 'Welcome to {{salon_name}}, {{customer_name}} — see you today.' });

    expect(first.variableOrder).toEqual(['customer_name', 'salon_name']);
    expect(swapped.variableOrder).toEqual(['salon_name', 'customer_name']);
    expect(first.variableOrder).not.toEqual(swapped.variableOrder);
  });

  it('sends a sample for every placeholder', () => {
    // Meta rejects a submission with no examples. It is the commonest reason a
    // salon's first template bounces, and it is entirely our fault when it does.
    const { payload } = toMetaTemplate({
      ...base,
      bodyText: 'Hi {{customer_name}}, your bill at {{salon_name}} is {{amount}}. Thank you.',
    });

    const body = payload.components.find((c) => c.type === 'BODY');
    expect(body?.example?.body_text?.[0]).toHaveLength(3);
    expect(body?.example?.body_text?.[0]?.[0]).toBe('Priya');
  });

  it('invents a readable sample for a variable we have no sample for', () => {
    const { payload } = toMetaTemplate({ ...base, bodyText: 'Your {{loyalty_tier}} benefits are active. Enjoy.' });
    expect(payload.components.find((c) => c.type === 'BODY')?.example?.body_text?.[0]).toEqual(['loyalty tier']);
  });
});

describe('what Meta would refuse, refused here first', () => {
  it('rejects a body that ends on a variable', () => {
    // Two of our own starter templates do exactly this, ending on
    // {{booking_link}} and {{branch_address}}.
    const problems = templateProblems({
      name: 'appointment_cancelled',
      bodyText: 'Hi {{customer_name}}, your appointment was cancelled. Book again: {{booking_link}}',
    });
    expect(problems.some((p) => p.includes('ends with a variable'))).toBe(true);
  });

  it('rejects a body that opens on a variable', () => {
    const problems = templateProblems({ name: 'hi', bodyText: '{{customer_name}}, your appointment is confirmed.' });
    expect(problems.some((p) => p.includes('starts with a variable'))).toBe(true);
  });

  it('rejects two variables with nothing between them', () => {
    const problems = templateProblems({ name: 'hi', bodyText: 'Hello {{first_name}}{{last_name}}, welcome along.' });
    expect(problems.some((p) => p.includes('next to each other'))).toBe(true);
  });

  it('rejects a name Meta will not accept', () => {
    const problems = templateProblems({ name: 'Appointment Confirmation', bodyText: 'Hi {{customer_name}}, hello.' });
    expect(problems.some((p) => p.includes('lowercase'))).toBe(true);
  });

  it('passes a well-formed template', () => {
    expect(
      templateProblems({
        name: 'appointment_confirmation',
        bodyText: 'Hi {{customer_name}}, your appointment at {{salon_name}} is confirmed. See you then.',
      }),
    ).toEqual([]);
  });

  it('does not leak regex state between calls', () => {
    // A module-level regex with /g keeps lastIndex between uses. Called twice
    // on the same input it would answer differently the second time, which is
    // the kind of bug that only shows up once two salons use the screen.
    const input = { name: 'ok_name', bodyText: 'Hi {{customer_name}}, welcome to {{salon_name}} today.' };
    expect(templateProblems(input)).toEqual(templateProblems(input));
  });
});

describe('the pieces Meta requires', () => {
  it('maps our SERVICE category onto Meta’s UTILITY', () => {
    // Meta has no SERVICE category. Sending one is an immediate rejection.
    const { payload } = toMetaTemplate({ ...base, category: 'SERVICE', bodyText: 'Your table is ready now.' });
    expect(payload.category).toBe('UTILITY');
  });

  it('numbers header variables separately from the body', () => {
    // Meta treats each component's placeholders as its own sequence. Folding
    // them into one list would send the body's first value into the header.
    const { payload, variableOrder } = toMetaTemplate({
      ...base,
      headerText: 'Booking at {{salon_name}}',
      bodyText: 'Hi {{customer_name}}, you are booked for {{appointment_time}}. See you.',
    });

    expect(payload.components.find((c) => c.type === 'HEADER')?.text).toBe('Booking at {{1}}');
    expect(payload.components.find((c) => c.type === 'BODY')?.text).toBe('Hi {{1}}, you are booked for {{2}}. See you.');
    expect(variableOrder).toEqual(['customer_name', 'appointment_time']);
  });

  it('prefers the Meta name when one is already set', () => {
    const { payload } = toMetaTemplate({
      ...base,
      name: 'Our Friendly Name',
      providerTemplateName: 'appointment_confirmation_v2',
      bodyText: 'Hi {{customer_name}}, confirmed. See you.',
    });
    expect(payload.name).toBe('appointment_confirmation_v2');
  });

  it('omits the example block when there are no variables', () => {
    // An empty example array is not the same as no example, and Meta refuses it.
    const { payload } = toMetaTemplate({ ...base, bodyText: 'Your appointment is confirmed. See you soon.' });
    expect(payload.components.find((c) => c.type === 'BODY')?.example).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { fromMetaComponents, guessVariable, isFillable, isUnmapped } from '../src/messaging/whatsapp-template-format';

/**
 * IMPORTING A TEMPLATE META ALREADY HOLDS.
 *
 * The lossy direction. Meta stores `Hi {{1}}, your appointment on {{2}}` and
 * records nothing about what those positions meant; the example values are the
 * only evidence.
 *
 * So the thing under test is not really "does it guess well" — it is "does it
 * refuse to guess when it is unsure". A confident wrong guess does not look
 * wrong on any screen: it sends one customer another customer's appointment
 * date, and the first sign of trouble is somebody arriving on the wrong day.
 */

describe('guessing a position from its example', () => {
  it('recognises shapes that cannot be mistaken', () => {
    expect(guessVariable('https://parlon.jharavi.in/book/aster', 0)).toBe('booking_link');
    expect(guessVariable('4:30 PM', 0)).toBe('appointment_time');
    expect(guessVariable('January 25, 2026', 0)).toBe('appointment_date');
    expect(guessVariable('12 Sep 2026', 0)).toBe('appointment_date');
    expect(guessVariable('1,650', 0)).toBe('amount');
  });

  it('recognises a sample this app itself supplied', () => {
    // A template submitted from Parlon carries our own sample values, which is
    // the strongest evidence available — better than any shape heuristic.
    expect(guessVariable('Priya', 0)).toBe('customer_name');
    expect(guessVariable('Aster Hair & Skin', 0)).toBe('salon_name');
  });

  it('refuses to guess a bare name', () => {
    // "John" is probably a customer name. Probably is not good enough when
    // being wrong means a customer reads somebody else's details.
    expect(isUnmapped(guessVariable('John', 0))).toBe(true);
    expect(isUnmapped(guessVariable('Gold', 1))).toBe(true);
    expect(isUnmapped(guessVariable('', 2))).toBe(true);
    expect(isUnmapped(guessVariable(undefined, 3))).toBe(true);
  });

  it('never invents a name the app cannot fill', () => {
    for (const example of ['John', 'https://x.in/y', '4:30 PM', '', 'anything at all']) {
      const guess = guessVariable(example, 0);
      expect(isFillable(guess) || isUnmapped(guess)).toBe(true);
    }
  });
});

describe('turning Meta components back into a template', () => {
  const appointmentTempo = [
    {
      type: 'BODY' as const,
      text: 'Hi {{1}}, your appointment on {{2}} has been cancelled. We hope to see you another time.',
      example: { body_text: [['John', 'January 25, 2026']] },
    },
  ];

  it('restores the wording with named placeholders', () => {
    const imported = fromMetaComponents(appointmentTempo);
    expect(imported.bodyText).toBe(
      'Hi {{unmapped_1}}, your appointment on {{appointment_date}} has been cancelled. We hope to see you another time.',
    );
  });

  it('keeps the count and the order Meta numbered them in', () => {
    // This is the part that must be exact. Meta expects values positionally;
    // one extra, one missing, or two swapped and the send is either rejected
    // or delivered with the values in the wrong places.
    const imported = fromMetaComponents(appointmentTempo);
    expect(imported.variables).toHaveLength(2);
    expect(imported.variables[1]).toBe('appointment_date');
  });

  it('reports the positions it could not name', () => {
    const imported = fromMetaComponents(appointmentTempo);
    expect(imported.unmapped).toEqual([1]);
  });

  it('reuses one name for a position repeated in the text', () => {
    const imported = fromMetaComponents([
      {
        type: 'BODY' as const,
        text: 'Hi {{1}}, see you at {{2}}. Thanks, {{1}}!',
        example: { body_text: [['Priya', 'Aster Hair & Skin']] },
      },
    ]);
    expect(imported.bodyText).toBe('Hi {{customer_name}}, see you at {{salon_name}}. Thanks, {{customer_name}}!');
    expect(imported.variables).toEqual(['customer_name', 'salon_name']);
  });

  it('imports a template with no variables cleanly', () => {
    const imported = fromMetaComponents([{ type: 'BODY' as const, text: 'Your appointment is confirmed.' }]);
    expect(imported.variables).toEqual([]);
    expect(imported.unmapped).toEqual([]);
    expect(imported.bodyText).toBe('Your appointment is confirmed.');
  });

  it('numbers a header separately from the body', () => {
    const imported = fromMetaComponents([
      { type: 'HEADER' as const, text: 'Booking at {{1}}', example: { header_text: ['Aster Hair & Skin'] } },
      { type: 'BODY' as const, text: 'Hi {{1}}, confirmed for {{2}}. See you.', example: { body_text: [['Priya', '4:30 PM']] } },
      { type: 'FOOTER' as const, text: 'Reply STOP to opt out' },
    ]);
    expect(imported.headerText).toBe('Booking at {{salon_name}}');
    expect(imported.variables).toEqual(['customer_name', 'appointment_time']);
    expect(imported.footerText).toBe('Reply STOP to opt out');
  });
});

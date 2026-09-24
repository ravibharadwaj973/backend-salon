import { describe, expect, it } from 'vitest';
import { missingVariables, renderTemplate } from '../src/messaging/dispatcher';

/**
 * THE INVOICE EMAIL THAT ARRIVED EMPTY.
 *
 * A real customer received this, over the salon's own name and phone number:
 *
 *     Dear sony,
 *     Thank you for visiting Glow Studio Salon & Spa.
 *     Invoice:
 *     Services:
 *     Total:
 *
 * Colons with nothing after them. Two faults stacked: the invoice id never
 * reached the variable builder, so nothing could resolve, and then nothing
 * checked before sending, because renderTemplate turns an unknown variable
 * into the empty string and an empty string is a perfectly good message.
 */
const INVOICE_EMAIL =
  'Dear {{customer_name}},\n\nThank you for visiting {{salon_name}}.\n\n' +
  'Invoice: {{invoice_number}}\nServices: {{services}}\nTotal: {{amount}}';

describe('a message with a hole in it is caught before it is sent', () => {
  it('names every field that did not resolve', () => {
    const holes = missingVariables(INVOICE_EMAIL, {
      customer_name: 'sony',
      salon_name: 'Glow Studio Salon & Spa',
    });

    expect(holes).toEqual(['invoice_number', 'services', 'amount']);
  });

  it('is silent when everything resolved', () => {
    expect(
      missingVariables(INVOICE_EMAIL, {
        customer_name: 'sony',
        salon_name: 'Glow Studio Salon & Spa',
        invoice_number: 'INV-1042',
        services: 'Hair Spa',
        amount: '2,900',
      }),
    ).toEqual([]);
  });

  it('counts an empty value as missing, which is the case that shipped', () => {
    // The variable was PRESENT and blank — resolved to nothing rather than not
    // resolved at all. To the customer those read identically.
    expect(missingVariables('Total: {{amount}}', { amount: '' })).toEqual(['amount']);
  });

  it('shows what the customer actually read', () => {
    const rendered = renderTemplate(INVOICE_EMAIL, { customer_name: 'sony', salon_name: 'Glow Studio Salon & Spa' });
    expect(rendered).toContain('Invoice: \n');
    expect(rendered).toContain('Total: ');
    // Which is exactly why rendering cannot be the last word on whether to send.
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('does not report a variable twice when a template repeats it', () => {
    expect(missingVariables('{{amount}} of {{amount}}', {})).toEqual(['amount']);
  });
});

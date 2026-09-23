import { describe, expect, it } from 'vitest';
import { buttonProblems, fromMetaComponents, toMetaTemplate, type TemplateButton } from '../src/messaging/whatsapp-template-format';

/**
 * BUTTONS, AND THE INDEX THAT MUST NOT BE COMPACTED.
 *
 * Meta addresses a button's parameter by its position among ALL the buttons.
 * A template whose first button is "Call us" and whose second opens an invoice
 * sends its one parameter at index 1, not index 0. Numbering the dynamic ones
 * instead is the mistake worth guarding: Meta accepts it, the message is
 * delivered, and the customer taps through to the wrong address.
 */

const base = {
  name: 'invoice_sent',
  language: 'en_US',
  category: 'UTILITY' as const,
  headerText: null,
  footerText: null,
  providerTemplateName: null,
  bodyText: 'Hi {{customer_name}}, your bill from {{salon_name}} is ready. Thank you.',
};

describe('sending a template that has buttons', () => {
  it('splits a dynamic link into a fixed base and a variable suffix', () => {
    // Meta stores the base and appends the value. A whole URL in the suffix
    // produces an address with the origin in it twice.
    const { payload } = toMetaTemplate({
      ...base,
      buttons: [{ type: 'URL', text: 'View bill', url: 'https://parlon.jharavi.in/invoice/', variable: 'invoice_token' }],
    });

    const buttons = payload.components.find((c) => c.type === 'BUTTONS')?.buttons;
    expect(buttons?.[0]?.url).toBe('https://parlon.jharavi.in/invoice/{{1}}');
    expect(buttons?.[0]?.example).toEqual(['https://parlon.jharavi.in/invoice/7hK2mQx9pR4tVn6wYb3zAc']);
  });

  it('keeps a hole where a static button sits, so the index stays right', () => {
    const { buttonVariables } = toMetaTemplate({
      ...base,
      buttons: [
        { type: 'PHONE_NUMBER', text: 'Call us', phone: '+919220999209' },
        { type: 'URL', text: 'View bill', url: 'https://parlon.jharavi.in/invoice/', variable: 'invoice_token' },
      ],
    });

    // Index 0 is the call button and takes no parameter; the invoice token
    // belongs at index 1. A compacted [invoice_token] would put it at 0.
    expect(buttonVariables).toEqual([null, 'invoice_token']);
  });

  it('leaves a static link button with no variable at all', () => {
    const { payload, buttonVariables } = toMetaTemplate({
      ...base,
      buttons: [{ type: 'URL', text: 'Our website', url: 'https://aster.example.com', variable: null }],
    });
    const button = payload.components.find((c) => c.type === 'BUTTONS')?.buttons?.[0];
    expect(button?.url).toBe('https://aster.example.com');
    expect(button?.example).toBeUndefined();
    expect(buttonVariables).toEqual([null]);
  });

  it('passes quick replies through, which is how a customer answers', () => {
    const { payload } = toMetaTemplate({
      ...base,
      buttons: [
        { type: 'QUICK_REPLY', text: 'Confirm' },
        { type: 'QUICK_REPLY', text: 'Reschedule' },
      ],
    });
    const buttons = payload.components.find((c) => c.type === 'BUTTONS')?.buttons;
    expect(buttons?.map((b) => b.type)).toEqual(['QUICK_REPLY', 'QUICK_REPLY']);
    expect(buttons?.[1]?.text).toBe('Reschedule');
  });

  it('adds no BUTTONS component when there are none', () => {
    const { payload } = toMetaTemplate({ ...base, buttons: [] });
    expect(payload.components.find((c) => c.type === 'BUTTONS')).toBeUndefined();
  });
});

describe('what Meta would refuse about buttons', () => {
  const url = (over: Partial<Extract<TemplateButton, { type: 'URL' }>> = {}): TemplateButton => ({
    type: 'URL',
    text: 'View bill',
    url: 'https://parlon.jharavi.in/invoice/',
    ...over,
  });

  it('catches a dynamic link whose base does not end where the value begins', () => {
    // Without the trailing slash the address arrives as ".../invoiceabc123".
    const problems = buttonProblems([url({ url: 'https://parlon.jharavi.in/invoice', variable: 'invoice_token' })]);
    expect(problems.some((p) => p.includes('must end with'))).toBe(true);
  });

  it('accepts the same button once its base ends correctly', () => {
    expect(buttonProblems([url({ variable: 'invoice_token' })])).toEqual([]);
  });

  it('enforces Meta’s counts', () => {
    expect(buttonProblems([url({ text: 'A' }), url({ text: 'B' }), url({ text: 'C' })]).some((p) => p.includes('link buttons'))).toBe(true);
    expect(
      buttonProblems([
        { type: 'QUICK_REPLY', text: 'One' },
        { type: 'QUICK_REPLY', text: 'Two' },
        { type: 'QUICK_REPLY', text: 'Three' },
        { type: 'QUICK_REPLY', text: 'Four' },
      ]).some((p) => p.includes('quick-reply')),
    ).toBe(true);
  });

  it('refuses two buttons a customer could not tell apart', () => {
    expect(buttonProblems([url({ text: 'Open' }), url({ text: 'open' })]).some((p) => p.includes('both labelled'))).toBe(true);
  });

  it('refuses http and an unlabelled button', () => {
    expect(buttonProblems([url({ url: 'http://parlon.jharavi.in/invoice/' })]).some((p) => p.includes('https'))).toBe(true);
    expect(buttonProblems([url({ text: '' })].map((b) => b)).some((p) => p.includes('needs a label'))).toBe(true);
  });

  it('checks a call button has a real number', () => {
    expect(
      buttonProblems([{ type: 'PHONE_NUMBER', text: 'Call us', phone: 'call me' }]).some((p) => p.includes('country code')),
    ).toBe(true);
    expect(buttonProblems([{ type: 'PHONE_NUMBER', text: 'Call us', phone: '+91 92209 99209' }])).toEqual([]);
  });
});

describe('importing buttons back from Meta', () => {
  it('separates the base from the suffix again and marks the value unmapped', () => {
    // The variable's NAME is not stored by Meta, so an imported dynamic button
    // arrives unnamed and cannot send until somebody names it.
    const imported = fromMetaComponents([
      { type: 'BODY', text: 'Your bill is ready.' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+919220999209' },
          { type: 'URL', text: 'View bill', url: 'https://parlon.jharavi.in/invoice/{{1}}' },
        ],
      },
    ]);

    expect(imported.buttons).toEqual([
      { type: 'PHONE_NUMBER', text: 'Call us', phone: '+919220999209' },
      { type: 'URL', text: 'View bill', url: 'https://parlon.jharavi.in/invoice/', variable: 'unmapped_2' },
    ]);
  });

  it('imports a static link button unchanged', () => {
    const imported = fromMetaComponents([
      { type: 'BODY', text: 'Have a look.' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Website', url: 'https://aster.example.com' }] },
    ]);
    expect(imported.buttons[0]).toEqual({ type: 'URL', text: 'Website', url: 'https://aster.example.com', variable: null });
  });
});

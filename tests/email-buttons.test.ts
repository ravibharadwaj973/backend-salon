import { describe, expect, it } from 'vitest';

/**
 * THE INVOICE LINK THAT WAS NOT A LINK.
 *
 * The email provider escaped the whole body and wrapped it in a div, so an
 * invoice address in the wording arrived as a run of characters. Gmail guesses
 * at those; plenty of clients do not, and none of them draw a button. A salon
 * emailing an invoice was asking the customer to select a URL and paste it.
 *
 * The rendering is reached through a private method, so it is reproduced here
 * exactly. If the provider's version changes, this one has to change with it --
 * which is the point: the escaping rules below are the ones that keep a
 * customer's name from becoming markup.
 */
function html(body: string, links: { text: string; url: string }[] = []): string {
  const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = escaped
    .replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color:#0f766e">$1</a>')
    .replace(/\n/g, '<br>');
  const attr = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const buttons = links
    .filter((l) => /^https?:\/\//i.test(l.url))
    .map((l) => `<a href="${attr(l.url)}">${l.text}</a>`)
    .join('');
  return `<div>${linked}${buttons}</div>`;
}

const INVOICE = 'https://parlon.jharavi.in/invoice/7hK2mQx9pR4tVn6wYb3zAc';

describe('an invoice email can actually be opened', () => {
  it('makes a bare address in the wording clickable', () => {
    const out = html(`Your invoice is ready: ${INVOICE}`);
    expect(out).toContain(`href="${INVOICE}"`);
  });

  it('draws a button when one is given', () => {
    const out = html('Your invoice is ready.', [{ text: 'View invoice', url: INVOICE }]);
    expect(out).toContain(`href="${INVOICE}"`);
    expect(out).toContain('View invoice');
  });

  it('drops a button whose address never resolved, rather than linking to nothing', () => {
    const out = html('Your invoice is ready.', [{ text: 'View invoice', url: '' }]);
    expect(out).not.toContain('View invoice');
  });

  it('still escapes the body, so a name cannot become markup', () => {
    const out = html('Dear <script>alert(1)</script>,');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('escapes the quote that would otherwise end the href early', () => {
    const out = html('Invoice ready.', [{ text: 'View', url: 'https://x.test/a"onmouseover="evil()' }]);
    expect(out).not.toContain('onmouseover="evil()"');
    expect(out).toContain('&quot;');
  });
});

/**
 * And the link builder, which is the half that decides whether there is a
 * button at all. Reproduced from dispatcher.ts for the same reason.
 */
function buildLinks(
  buttons: { type: string; text: string; url: string; variable?: string | null }[],
  variables: Record<string, string>,
) {
  return buttons.flatMap((button) => {
    if (button?.type !== 'URL') return [];
    const suffix = button.variable ? variables[button.variable] : '';
    if (button.variable && !suffix) return [];
    return [{ text: button.text, url: `${button.url}${suffix ?? ''}` }];
  });
}

describe('building the email button from the template', () => {
  it('treats a blank base with a link variable as the whole address', () => {
    const links = buildLinks(
      [{ type: 'URL', text: 'View invoice', url: '', variable: 'invoice_link' }],
      { invoice_link: INVOICE },
    );
    expect(links).toEqual([{ text: 'View invoice', url: INVOICE }]);
  });

  it('drops the button when the variable did not resolve', () => {
    // A "View invoice" button that opens the invoice index is worse than no
    // button: the customer clicks it, sees somebody else's page or a 404, and
    // rings the salon.
    expect(buildLinks([{ type: 'URL', text: 'View invoice', url: '', variable: 'invoice_link' }], {})).toEqual([]);
  });

  it('keeps a fixed link that needs no variable', () => {
    const links = buildLinks([{ type: 'URL', text: 'Book again', url: 'https://x.test/book' }], {});
    expect(links).toEqual([{ text: 'Book again', url: 'https://x.test/book' }]);
  });

  it('ignores quick replies, which mean nothing in an inbox', () => {
    expect(buildLinks([{ type: 'QUICK_REPLY', text: 'Yes', url: '' }], {})).toEqual([]);
  });
});

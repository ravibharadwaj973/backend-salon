import type { TemplateCategory } from '@prisma/client';

/**
 * TRANSLATING OUR TEMPLATES INTO META'S.
 *
 * Kept apart from the HTTP calls on purpose: this half is pure, so it can be
 * tested without a database, an access token or a network. It is also the half
 * where a silent mistake is worst — get the variable ORDER wrong and every
 * customer receives another customer's appointment time, with nothing anywhere
 * reporting an error.
 *
 * Our templates use named placeholders, {{customer_name}}, because those
 * survive a salon reordering a sentence. Meta accepts only positional ones,
 * {{1}}, numbered from 1 in order of first appearance. So we keep names, and
 * translate here, at the boundary.
 */

// --------------------------------------------------------------- limits ----
// Meta's, not ours. Checked here so a salon is told in their own form rather
// than by a rejection that arrives an hour later against a template they can
// no longer rename.
const MAX_BODY = 1024;
const MAX_HEADER = 60;
const MAX_FOOTER = 60;
const NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const MAX_BUTTON_TEXT = 25;
/**
 * Meta's button limits. Checked here rather than discovered by rejection,
 * because a rejection consumes the template's name and a template cannot be
 * renamed.
 */
const MAX_URL_BUTTONS = 2;
const MAX_PHONE_BUTTONS = 1;
const MAX_QUICK_REPLIES = 3;
const MAX_BUTTONS = 10;
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Sample values shown to Meta's reviewer.
 *
 * Deliberately the same ones the in-app preview uses. A reviewer judging
 * "Hi Priya, your appointment at Glow Studio is confirmed" and a salon owner
 * the preview should be looking at the same sentence — otherwise the thing that
 * was approved is not the thing anybody checked.
 */
export const SAMPLE_VALUES: Record<string, string> = {
  customer_name: 'Priya',
  salon_name: 'Glow Studio',
  appointment_date: '12 Sep 2026',
  appointment_time: '4:30 PM',
  staff_name: 'Riya',
  services: 'Hair Spa, Haircut',
  amount: '1,650',
  branch_address: '12 MG Road, Bengaluru',
  booking_link: 'https://parlon.jharavi.in/book/glow-studio',
  invoice_number: 'INV-1042',
  invoice_link: 'https://parlon.jharavi.in/invoice/7hK2mQx9pR4tVn6wYb3zAc',
  invoice_token: '7hK2mQx9pR4tVn6wYb3zAc',
  offer: '20% off colour',
  points: '120',
};

function sampleFor(name: string): string {
  return SAMPLE_VALUES[name] ?? name.replace(/_/g, ' ');
}

// ------------------------------------------------------------ conversion ---

/**
 * A button as a salon writes it.
 *
 * The URL case carries the awkwardness of Meta's design. A dynamic URL button
 * is NOT a whole address in a variable — Meta stores a fixed base and appends
 * one variable at the very end:
 *
 *     https://parlon.jharavi.in/invoice/{{1}}
 *
 * and at send time you supply only the tail. So `variable` names the field that
 * fills that tail (invoice_token), never the field that holds a whole link
 * (invoice_link). Putting a full URL in the suffix produces an address with the
 * origin in it twice, which Meta accepts and which opens nothing.
 */
export type TemplateButton =
  | { type: 'URL'; text: string; url: string; variable?: string | null }
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'PHONE_NUMBER'; text: string; phone: string };

export interface MetaButton {
  type: 'URL' | 'QUICK_REPLY' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[];
}

export interface MetaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT';
  text?: string;
  example?: { body_text?: string[][]; header_text?: string[] };
  buttons?: MetaButton[];
}

export interface MetaTemplatePayload {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  components: MetaComponent[];
}

export interface Converted {
  payload: MetaTemplatePayload;
  /**
   * Our variable names, in the order Meta will expect their values. {{1}} is
   * variableOrder[0]. Stored on the template; without it a send fills the
   * placeholders in whatever order the object happened to iterate.
   */
  variableOrder: string[];
  /**
   * The variable filling each dynamic URL button's suffix, by button index.
   * Sparse: a static button leaves a hole, and the index must survive that,
   * because Meta addresses a button's parameter by its position.
   */
  buttonVariables: (string | null)[];
  /** Reasons Meta would refuse this. Non-empty means do not call the API. */
  problems: string[];
}

/** Meta has no SERVICE category; it is a UTILITY message by their taxonomy. */
function metaCategory(category: TemplateCategory): MetaTemplatePayload['category'] {
  if (category === 'MARKETING') return 'MARKETING';
  if (category === 'AUTHENTICATION') return 'AUTHENTICATION';
  return 'UTILITY';
}

/** Replace each named placeholder with its position, recording the order. */
function toPositional(text: string): { text: string; order: string[] } {
  const order: string[] = [];
  const converted = text.replace(VARIABLE, (_match, name: string) => {
    let index = order.indexOf(name);
    if (index === -1) {
      order.push(name);
      index = order.length - 1;
    }
    return `{{${index + 1}}}`;
  });
  return { text: converted, order };
}

/**
 * What Meta will refuse, checked before spending a round trip and a name.
 *
 * The first two are not style advice: a body that opens or closes on a
 * placeholder is rejected outright, and so are two placeholders with nothing
 * between them. Several of our own starter templates end on {{booking_link}}
 * or {{branch_address}}, so this catches real ones.
 */
export function buttonProblems(buttons: TemplateButton[]): string[] {
  const problems: string[] = [];
  if (buttons.length === 0) return problems;

  const count = (type: TemplateButton['type']) => buttons.filter((b) => b.type === type).length;

  if (buttons.length > MAX_BUTTONS) problems.push(`A template can have at most ${MAX_BUTTONS} buttons.`);
  if (count('URL') > MAX_URL_BUTTONS) problems.push(`A template can have at most ${MAX_URL_BUTTONS} link buttons.`);
  if (count('PHONE_NUMBER') > MAX_PHONE_BUTTONS) problems.push('A template can have only one call button.');
  if (count('QUICK_REPLY') > MAX_QUICK_REPLIES) {
    problems.push(`A template can have at most ${MAX_QUICK_REPLIES} quick-reply buttons.`);
  }

  const seen = new Set<string>();
  for (const button of buttons) {
    const label = button.text?.trim() ?? '';
    if (!label) problems.push('Every button needs a label.');
    if (label.length > MAX_BUTTON_TEXT) {
      problems.push(`The button "${label.slice(0, 20)}…" is longer than ${MAX_BUTTON_TEXT} characters.`);
    }
    // Meta refuses two buttons with the same label, and a customer could not
    // tell them apart anyway.
    if (label && seen.has(label.toLowerCase())) problems.push(`Two buttons are both labelled "${label}".`);
    seen.add(label.toLowerCase());

    if (button.type === 'URL') {
      if (!/^https:\/\//i.test(button.url ?? '')) problems.push(`The link button "${label}" needs an https:// address.`);
      if (button.variable && !button.url.endsWith('/')) {
        // Meta appends the value to the end of the stored URL, so the base must
        // stop where the variable begins. Without this the address arrives as
        // ".../invoiceabc123".
        problems.push(
          `The link button "${label}" fills in ${button.variable} at the end, so its address must end with "/" — for example https://parlon.jharavi.in/invoice/`,
        );
      }
    }

    if (button.type === 'PHONE_NUMBER' && !/^\+?[0-9]{8,15}$/.test((button.phone ?? '').replace(/[\s-]/g, ''))) {
      problems.push(`The call button "${label}" needs a phone number with a country code.`);
    }
  }

  return problems;
}

export function templateProblems(input: {
  name: string;
  bodyText: string;
  headerText?: string | null;
  footerText?: string | null;
  // Nullable because that is what a Prisma Json column hands over. Accepting
  // only undefined made every caller launder the value first, and toMetaTemplate
  // -- which passes its own input straight through -- could not.
  buttons?: TemplateButton[] | null;
}): string[] {
  const problems: string[] = [];
  const body = input.bodyText.trim();

  if (!NAME_PATTERN.test(input.name)) {
    problems.push(
      `The name "${input.name}" is not one Meta accepts — lowercase letters, numbers and underscores only, no spaces or capitals.`,
    );
  }

  if (body.length > MAX_BODY) problems.push(`The message is ${body.length} characters; Meta's limit is ${MAX_BODY}.`);
  if ((input.headerText ?? '').length > MAX_HEADER) problems.push(`The header is longer than ${MAX_HEADER} characters.`);
  if ((input.footerText ?? '').length > MAX_FOOTER) problems.push(`The footer is longer than ${MAX_FOOTER} characters.`);

  if (/^\s*\{\{/.test(body)) {
    problems.push('The message starts with a variable. Meta rejects that — put a word before it, such as "Hi {{customer_name}}".');
  }
  if (/\}\}\s*$/.test(body)) {
    problems.push('The message ends with a variable. Meta rejects that — add a closing line after it.');
  }
  if (/\}\}\s*\{\{/.test(body)) {
    problems.push('Two variables sit next to each other with nothing between them, which Meta rejects. Put a word or punctuation between them.');
  }

  // A header may hold at most one variable, and buttons none of ours.
  problems.push(...buttonProblems(input.buttons ?? []));

  const headerVars = [...(input.headerText ?? '').matchAll(VARIABLE)];
  if (headerVars.length > 1) problems.push('A header can contain at most one variable.');
  if (VARIABLE.test(input.footerText ?? '')) problems.push('A footer cannot contain variables.');
  VARIABLE.lastIndex = 0;

  return problems;
}

export function toMetaTemplate(template: {
  name: string;
  language: string;
  category: TemplateCategory;
  bodyText: string;
  headerText?: string | null;
  footerText?: string | null;
  providerTemplateName?: string | null;
  buttons?: TemplateButton[] | null;
}): Converted {
  // The name Meta knows it by. Falls back to our own name, which is why our
  // names are validated against Meta's pattern rather than ours.
  const name = (template.providerTemplateName || template.name).toLowerCase();
  const problems = templateProblems({ ...template, name });

  const body = toPositional(template.bodyText.trim());
  const header = template.headerText?.trim() ? toPositional(template.headerText.trim()) : null;

  const components: MetaComponent[] = [];

  if (header) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: header.text,
      ...(header.order.length ? { example: { header_text: header.order.map(sampleFor) } } : {}),
    });
  }

  components.push({
    type: 'BODY',
    text: body.text,
    // Meta REQUIRES an example for every placeholder. A submission without one
    // is rejected immediately, and it is the commonest reason a first template
    // bounces.
    ...(body.order.length ? { example: { body_text: [body.order.map(sampleFor)] } } : {}),
  });

  if (template.footerText?.trim()) {
    components.push({ type: 'FOOTER', text: template.footerText.trim() });
  }

  const buttons = template.buttons ?? [];
  if (buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((button) => {
        if (button.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY' as const, text: button.text.trim() };
        if (button.type === 'PHONE_NUMBER') {
          return { type: 'PHONE_NUMBER' as const, text: button.text.trim(), phone_number: button.phone.trim() };
        }
        const url = button.variable ? `${button.url}{{1}}` : button.url;
        return {
          type: 'URL' as const,
          text: button.text.trim(),
          url,
          // Every variable needs an example, buttons included — and this one is
          // a sample of the SUFFIX, not of the whole address.
          ...(button.variable ? { example: [`${button.url}${sampleFor(button.variable)}`] } : {}),
        };
      }),
    });
  }

  return {
    payload: {
      name,
      language: template.language || 'en',
      category: metaCategory(template.category),
      components,
    },
    // The header's variables are numbered separately by Meta, so only the
    // body's order describes the send-time parameters we build.
    variableOrder: body.order,
    buttonVariables: buttons.map((b) => (b.type === 'URL' && b.variable ? b.variable : null)),
    problems,
  };
}

// ------------------------------------------------------- importing back ----

/**
 * The variable names buildVariables can actually produce.
 *
 * Kept here as data so two things can check against it: the importer, which
 * has to turn Meta's {{1}} into a name we can fill, and the send guard, which
 * must refuse a template referring to a name nothing fills. A placeholder
 * nothing fills is not cosmetic on WhatsApp — Meta counts parameters, so one
 * unfillable name fails every send of that template.
 */
export const KNOWN_VARIABLES = [
  'customer_name',
  'customer_full_name',
  'lead_name',
  'salon_name',
  'salon_phone',
  'branch_name',
  'branch_address',
  'appointment_date',
  'appointment_day',
  'appointment_time',
  'staff_name',
  'services',
  'last_service',
  'last_visit_date',
  'days_since_visit',
  'total_visits',
  'amount',
  'due_amount',
  'invoice_number',
  'invoice_link',
  'invoice_token',
  'points_balance',
  'package_name',
  'sessions_left',
  'plan_name',
  'expiry_date',
  'days_left',
  'booking_link',
  'feedback_link',
  'google_review_link',
] as const;

const KNOWN = new Set<string>(KNOWN_VARIABLES);

export function isFillable(name: string): boolean {
  return KNOWN.has(name);
}

/** A position we could not name. Deliberately not fillable, so it cannot send. */
export const unmappedName = (index: number) => `unmapped_${index + 1}`;
export const isUnmapped = (name: string) => /^unmapped_\d+$/.test(name);

/**
 * GUESS WHAT META'S {{1}} MEANT, FROM THE EXAMPLE BESIDE IT.
 *
 * Meta stores positions, not names — `Hi {{1}}, your appointment on {{2}}` —
 * and nothing in the API says what those positions are for. The only clue is
 * the example value the template was submitted with: "John", "January 25,
 * 2026".
 *
 * So this matches on the SHAPE of that example, and only where the shape is
 * unambiguous. Everything else becomes an unmapped_N placeholder, which is not
 * in KNOWN_VARIABLES and therefore cannot pass the send guard. That is the
 * point: a wrong guess here does not look wrong, it sends one customer another
 * customer's date, so a guess we are unsure of must block rather than proceed.
 */
export function guessVariable(example: string | undefined, index: number): string {
  const value = (example ?? '').trim();
  if (!value) return unmappedName(index);

  // An exact match against a sample we ourselves supply is the strongest clue:
  // the template was very likely submitted from this app.
  for (const [name, sample] of Object.entries(SAMPLE_VALUES)) {
    if (sample.toLowerCase() === value.toLowerCase() && isFillable(name)) return name;
  }

  if (/^https?:\/\//i.test(value)) return 'booking_link';
  // 4:30 PM, 16:30
  if (/^\d{1,2}[:.]\d{2}\s*(am|pm)?$/i.test(value)) return 'appointment_time';
  // 12 Sep 2026, January 25, 2026, 25/01/2026, 2026-01-25
  if (
    /\d{1,2}\s+[a-z]{3,}\s+\d{4}/i.test(value) ||
    /[a-z]{3,}\s+\d{1,2},?\s+\d{4}/i.test(value) ||
    /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(value)
  ) {
    return 'appointment_date';
  }
  // ₹1,650 / Rs 1650 / 1,650.00
  if (/^(₹|rs\.?\s*)?[\d,]+(\.\d{2})?$/i.test(value) && /\d/.test(value)) return 'amount';

  // A bare capitalised word is probably a person, but "probably" is not good
  // enough when being wrong means a customer reads somebody else's name.
  return unmappedName(index);
}

export interface ImportedTemplate {
  bodyText: string;
  headerText: string | null;
  footerText: string | null;
  buttons: TemplateButton[];
  variables: string[];
  /** Positions we could not name. Non-empty means it cannot send yet. */
  unmapped: number[];
}

/**
 * Turn Meta's components back into a template this app can render.
 *
 * The reverse of toMetaTemplate, and lossier: names have to be inferred where
 * the forward direction simply discarded them.
 */
export function fromMetaComponents(components: MetaComponent[]): ImportedTemplate {
  const body = components.find((c) => c.type === 'BODY');
  const header = components.find((c) => c.type === 'HEADER');
  const footer = components.find((c) => c.type === 'FOOTER');

  const examples = body?.example?.body_text?.[0] ?? [];
  const names: string[] = [];
  const unmapped: number[] = [];

  /**
   * A NAME MAY BE USED ONCE.
   *
   * guessVariable reads one example at a time and has no idea what the other
   * positions got, so a template whose samples are all numbers had every
   * position guessed as `amount` — and a body reading
   *
   *   Hi {{amount}}, thank you for visiting {{amount}}! You earned {{amount}}...
   *
   * renders as "Hi 640, thank you for visiting 640". Five positions, one value,
   * no error anywhere: the template is valid, it sends, and the customer reads
   * nonsense with their own money in it.
   *
   * So the second claim on a name loses. The position becomes unmapped, which
   * is the honest answer — we do not know what it is — and unmapped positions
   * already block the template from sending until somebody says.
   */
  const taken = new Set<string>();

  const text = (body?.text ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, digits: string) => {
    const position = Number(digits) - 1;
    if (!names[position]) {
      const guess = guessVariable(examples[position], position);
      const name = isUnmapped(guess) || !taken.has(guess) ? guess : unmappedName(position);
      taken.add(name);
      names[position] = name;
      if (isUnmapped(name)) unmapped.push(position + 1);
    }
    return `{{${names[position]}}}`;
  });

  // A header numbers its own placeholders, so it gets its own guesses.
  const headerExamples = header?.example?.header_text ?? [];
  const headerText = (header?.text ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, digits: string) => {
    const position = Number(digits) - 1;
    const guess = guessVariable(headerExamples[position], position);
    return `{{${guess}}}`;
  });

  /**
   * Buttons come back with the variable already inside the URL, so the base and
   * the suffix have to be separated again — the reverse of building it. The
   * variable's NAME is gone, as ever, so an imported dynamic button arrives
   * unmapped and cannot send until somebody names it.
   */
  const buttonComponent = components.find((c) => c.type === 'BUTTONS');
  const buttons: TemplateButton[] = (buttonComponent?.buttons ?? []).map((b, index) => {
    if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text };
    if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone: b.phone_number ?? '' };

    const url = b.url ?? '';
    const dynamic = /\{\{\s*\d+\s*\}\}\s*$/.test(url);
    return {
      type: 'URL',
      text: b.text,
      url: dynamic ? url.replace(/\{\{\s*\d+\s*\}\}\s*$/, '') : url,
      variable: dynamic ? unmappedName(index) : null,
    };
  });

  return {
    bodyText: text,
    headerText: headerText || null,
    footerText: footer?.text ?? null,
    buttons,
    // Positions Meta never used leave holes; fill them so the order is exact.
    variables: Array.from(names, (n, i) => n ?? unmappedName(i)),
    unmapped,
  };
}

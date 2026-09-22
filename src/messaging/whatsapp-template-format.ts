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
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Sample values shown to Meta's reviewer.
 *
 * Deliberately the same ones the in-app preview uses. A reviewer judging
 * "Hi Priya, your appointment at Aster is confirmed" and a salon owner reading
 * the preview should be looking at the same sentence — otherwise the thing that
 * was approved is not the thing anybody checked.
 */
export const SAMPLE_VALUES: Record<string, string> = {
  customer_name: 'Priya',
  salon_name: 'Aster Hair & Skin',
  appointment_date: '12 Sep 2026',
  appointment_time: '4:30 PM',
  staff_name: 'Riya',
  services: 'Hair Spa, Haircut',
  amount: '1,650',
  branch_address: '12 MG Road, Bengaluru',
  booking_link: 'https://parlon.jharavi.in/book/aster',
  invoice_number: 'INV-1042',
  offer: '20% off colour',
  points: '120',
};

function sampleFor(name: string): string {
  return SAMPLE_VALUES[name] ?? name.replace(/_/g, ' ');
}

// ------------------------------------------------------------ conversion ---

export interface MetaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT';
  text?: string;
  example?: { body_text?: string[][]; header_text?: string[] };
  buttons?: unknown[];
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
export function templateProblems(input: {
  name: string;
  bodyText: string;
  headerText?: string | null;
  footerText?: string | null;
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
    problems,
  };
}

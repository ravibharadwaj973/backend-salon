import type { Prisma } from '@prisma/client';
import { financialYear } from './gst';

/**
 * WHAT A BILL NUMBER IS ALLOWED TO LOOK LIKE.
 *
 * Every business already has a bill number format, and it is never the one a
 * developer picked. A salon moving off another system is at bill 1,247 and has
 * to carry on from there; one that has always written "GC-01" by hand wants
 * that; a chain wants the branch in it. So the shape is theirs to set.
 *
 * But it is not a free-text field, because Rule 46(b) of the CGST Rules is
 * specific and unforgiving:
 *
 *   · a consecutive serial number
 *   · not more than SIXTEEN characters
 *   · containing only letters, digits, "-" and "/"
 *   · unique for a financial year
 *
 * Seventeen characters is not a cosmetic problem: it is a defective tax
 * invoice, on every bill issued until somebody notices, and the customer's
 * input-credit claim is what breaks. Nothing in this app checked it before, and
 * the default `INV/25-26/00001` sits at fifteen — one character of headroom,
 * reached by adding a single letter to the prefix.
 *
 * So the rule is enforced here, on the format rather than on each number, and
 * the owner is shown the finished article before they save it.
 */

export const MAX_LENGTH = 16;

/** Legal characters in a GST invoice number, per Rule 46(b). */
const LEGAL = /^[A-Za-z0-9/-]*$/;

export type ResetMode = 'FINANCIAL_YEAR' | 'NEVER';

export interface SeriesFormat {
  /** "INV", "GC", "BILL/A" — whatever they already use. */
  prefix: string;
  /** Between the parts. Only "/" , "-" or nothing are legal. */
  separator: '/' | '-' | '';
  /** Whether "25-26" appears in the number. */
  includeFinancialYear: boolean;
  /** Zero-padding for the counter: 4 gives 0001. */
  padding: number;
  /**
   * The number the NEXT bill takes. A business carrying on from another system
   * sets this to where they left off; everyone else leaves it at 1.
   */
  startFrom: number;
  /**
   * Whether the count restarts on 1 April.
   *
   * Both are legal — uniqueness is per financial year, and a number that never
   * repeats satisfies that trivially. But an accountant opening the books
   * expects April to begin at 1, and a running count with the year in it
   * ("INV/26-27/04312") reads like a mistake. Theirs to choose; neither is a
   * default we can pick for them silently.
   */
  reset: ResetMode;
  /**
   * The prefix for bills with no GST on them, which count in a series of their
   * own.
   *
   * A tax invoice series that has non-GST bills mixed into it reads, at filing
   * time, as a series with holes: number 43 is in the books, is not in GSTR-1,
   * and the salon has to explain why. Two counters means the GST series is
   * continuous and contains only tax invoices, and the cash bills are a
   * complete run of their own.
   */
  nonGstPrefix: string;
  /** Where the non-GST series starts, for a business carrying one over. */
  nonGstStartFrom: number;
}

export const DEFAULT_FORMAT: SeriesFormat = {
  prefix: 'INV',
  separator: '/',
  includeFinancialYear: true,
  padding: 5,
  startFrom: 1,
  reset: 'FINANCIAL_YEAR',
  nonGstPrefix: 'BILL',
  nonGstStartFrom: 1,
};

/** Build one number. Pure, so the preview and the real thing cannot disagree. */
export function formatNumber(
  format: SeriesFormat,
  sequence: number,
  date: Date,
): string {
  const parts = [format.prefix];
  if (format.includeFinancialYear) parts.push(financialYear(date));
  parts.push(String(sequence).padStart(format.padding, '0'));
  return parts.filter((p) => p !== '').join(format.separator);
}

export interface FormatProblem {
  field: 'prefix' | 'nonGstPrefix' | 'separator' | 'padding' | 'startFrom' | 'nonGstStartFrom' | 'length';
  message: string;
}

/**
 * Everything wrong with a format, at once.
 *
 * All of them rather than the first: an owner fixing a prefix only to be told
 * about the padding is an owner who saves four times and trusts the screen
 * less each time.
 *
 * The length is checked against the WIDEST number the format can produce
 * inside its financial year, not the next one. A series that is legal at 0001
 * and illegal at 10000 is a series that breaks in October, and the whole point
 * of checking is to not find out then.
 */
export function validateFormat(format: SeriesFormat, at: Date = new Date()): FormatProblem[] {
  const problems: FormatProblem[] = [];

  if (!format.prefix.trim()) {
    problems.push({ field: 'prefix', message: 'A bill number needs a prefix — most salons use INV or their initials.' });
  }
  if (!LEGAL.test(format.prefix)) {
    problems.push({
      field: 'prefix',
      message: 'A bill number may only contain letters, numbers, "-" and "/". Spaces, "#" and "&" are not allowed on a GST invoice.',
    });
  }
  // Checked with the same force as the tax-invoice prefix. Only checking one
  // of two series is how the other one quietly goes over the limit.
  if (!format.nonGstPrefix.trim()) {
    problems.push({ field: 'nonGstPrefix', message: 'Bills without GST need a prefix of their own — BILL and CASH are the usual choices.' });
  }
  if (!LEGAL.test(format.nonGstPrefix)) {
    problems.push({
      field: 'nonGstPrefix',
      message: 'A bill number may only contain letters, numbers, "-" and "/".',
    });
  }
  if (!Number.isInteger(format.nonGstStartFrom) || format.nonGstStartFrom < 1) {
    problems.push({ field: 'nonGstStartFrom', message: 'The starting number for bills without GST must be 1 or more.' });
  }
  if (!['/', '-', ''].includes(format.separator)) {
    problems.push({ field: 'separator', message: 'Only "/" and "-" may separate the parts of a bill number.' });
  }
  if (!Number.isInteger(format.padding) || format.padding < 1 || format.padding > 10) {
    problems.push({ field: 'padding', message: 'Padding must be between 1 and 10 digits.' });
  }
  if (!Number.isInteger(format.startFrom) || format.startFrom < 1) {
    problems.push({ field: 'startFrom', message: 'The starting number must be 1 or more.' });
  }

  // Bail before measuring: a format with a broken padding produces nonsense
  // lengths, and a second error about length would only confuse.
  if (problems.length) return problems;

  // Both series measured. The longer of the two prefixes is the one that
  // decides whether this format is legal.
  for (const [field, prefix] of [['prefix', format.prefix], ['nonGstPrefix', format.nonGstPrefix]] as const) {
    const widest = formatNumber({ ...format, prefix }, widestSequence(format), at);
    if (widest.length > MAX_LENGTH) {
      problems.push({
        field: 'length',
        message:
          `${field === 'prefix' ? 'Tax invoice numbers' : 'Bill numbers without GST'} can reach ${widest.length} characters ` +
          `("${widest}"), and a bill number may not exceed ${MAX_LENGTH}. ` +
          'Shorten the prefix, drop the financial year, or use fewer padding digits.',
      });
    }
  }

  return problems;
}

/**
 * The longest sequence number this format can reach before it must reset.
 *
 * With yearly resets that is the padding filled with nines — a salon billing
 * 300 a day does not reach 99,999 in a year, and the padding is the owner's
 * own statement of how far they expect to go. With no reset the series runs
 * indefinitely, so one more digit than the padding is allowed for, which is
 * what makes a nine-year-old series' length predictable today.
 */
function widestSequence(format: SeriesFormat): number {
  const digits = format.reset === 'FINANCIAL_YEAR' ? format.padding : format.padding + 1;
  return Number('9'.repeat(Math.min(digits, 10)));
}

/** Valid, or the reasons it is not. */
export function isValidFormat(format: SeriesFormat, at?: Date): boolean {
  return validateFormat(format, at).length === 0;
}

/**
 * The key a counter lives under.
 *
 * Empty string when numbering never resets, so a single row carries the whole
 * series; the financial year otherwise. Putting it in the key rather than in a
 * flag means the database's own unique constraint is what stops two bills
 * taking the same number under concurrency, rather than application code
 * remembering to.
 */
export function counterKey(format: SeriesFormat, date: Date, kind: SeriesKind = 'GST'): string {
  const year = format.reset === 'FINANCIAL_YEAR' ? financialYear(date) : '';
  // The suffix is what keeps the two series apart in the database. Without it
  // both would increment one row and the numbers would interleave — which is
  // the very thing the second series exists to prevent.
  return kind === 'GST' ? year : `${year}:nogst`;
}

/** Which of the two series a bill belongs to. */
export type SeriesKind = 'GST' | 'NON_GST';

/** The prefix and starting number for one of the two series. */
export function seriesOf(format: SeriesFormat, kind: SeriesKind): { prefix: string; startFrom: number } {
  return kind === 'GST'
    ? { prefix: format.prefix, startFrom: format.startFrom }
    : { prefix: format.nonGstPrefix, startFrom: format.nonGstStartFrom };
}

/** What the owner sees while they are still deciding. */
export function previewNumbers(format: SeriesFormat, at: Date = new Date()): string[] {
  const start = Math.max(1, format.startFrom);
  return [start, start + 1, start + 2].map((n) => formatNumber(format, n, at));
}

/** Read a stored format back, filling anything missing with the default. */
export function parseFormat(raw: unknown): SeriesFormat {
  const v = (raw ?? {}) as Record<string, unknown>;
  const separator = v.separator === '-' || v.separator === '' ? v.separator : DEFAULT_FORMAT.separator;
  return {
    prefix: typeof v.prefix === 'string' && v.prefix ? v.prefix : DEFAULT_FORMAT.prefix,
    separator,
    includeFinancialYear: v.includeFinancialYear !== false,
    padding: Number.isInteger(v.padding) ? (v.padding as number) : DEFAULT_FORMAT.padding,
    startFrom: Number.isInteger(v.startFrom) && (v.startFrom as number) > 0 ? (v.startFrom as number) : 1,
    reset: v.reset === 'NEVER' ? 'NEVER' : 'FINANCIAL_YEAR',
    nonGstPrefix:
      typeof v.nonGstPrefix === 'string' && v.nonGstPrefix ? v.nonGstPrefix : DEFAULT_FORMAT.nonGstPrefix,
    nonGstStartFrom:
      Number.isInteger(v.nonGstStartFrom) && (v.nonGstStartFrom as number) > 0 ? (v.nonGstStartFrom as number) : 1,
  };
}

export type SeriesFormatJson = Prisma.InputJsonValue;

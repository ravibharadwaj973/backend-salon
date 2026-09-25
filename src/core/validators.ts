import { parseLocalDateTime } from './dates';
import { z } from 'zod';

export const idSchema = z.string().min(1).max(64);

export const idParam = z.object({ id: idSchema });

export const phoneSchema = z
  .string()
  .trim()
  .min(6, 'Phone number looks too short')
  .max(20)
  .regex(/^[+0-9\s-]+$/, 'Phone number may only contain digits, spaces, + and -');

export const emailSchema = z.string().trim().toLowerCase().email();

export const moneySchema = z.coerce.number().min(0).max(99_999_999);

export const percentSchema = z.coerce.number().min(0).max(100);

export const dateSchema = z.coerce.date();

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const searchQuery = paginationQuery.extend({
  q: z.string().trim().max(120).optional(),
  sortBy: z.string().max(40).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const dateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branchId: idSchema.optional(),
});

export const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Comma-separated query param -> string[] */
export const csvList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));

export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:mm (24 hour) format');

export const dayOfWeekSchema = z.coerce.number().int().min(0).max(6);

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/, 'Invalid GSTIN')
  .optional()
  .or(z.literal(''));

export const pincodeSchema = z.string().trim().regex(/^\d{6}$/, 'Invalid PIN code').optional().or(z.literal(''));

/**
 * A link a salon owner pastes in. They will paste it out of a browser bar or a
 * Google share sheet, so accept a bare "g.page/..." and put the scheme on
 * ourselves rather than making them work out why "that's not a valid URL".
 * An empty string clears the field.
 */
export const linkSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value) => (value === '' || /^https?:\/\//i.test(value) ? value : `https://${value}`))
  .refine(
    (value) => {
      if (value === '') return true;
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
      } catch {
        return false;
      }
    },
    { message: 'Enter a web address, for example https://g.page/r/CxxxxxxxxxxxxEBM/review' },
  );

/**
 * A datetime from a form field, read in the salon's timezone rather than the
 * server's.
 *
 * `z.coerce.date()` hands the string to `new Date()`, which reads a value with
 * no timezone on it — exactly what `<input type="datetime-local">` sends — in
 * the SERVER's timezone. On a UTC container that put every scheduled campaign
 * five and a half hours late, silently, because the resulting instant is
 * perfectly valid and nothing can tell it was not the one intended.
 *
 * Use this anywhere a human picks a time. Keep `z.coerce.date()` for ranges
 * built from date-only values and for timestamps the app generated itself.
 */
export const localDateTime = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value : parseLocalDateTime(value)))
  .refine((date) => !Number.isNaN(date.getTime()), 'Not a valid date and time');

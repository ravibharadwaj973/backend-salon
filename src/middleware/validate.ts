import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError } from '../core/errors';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * The sentence a person reads when a form is refused.
 *
 * The details array carried everything needed to fix the form and the message
 * said "Validation failed", and the client shows the message. So every
 * rejected form in the app -- one blank field, one stray character -- told the
 * salon owner nothing at all, and they filled it in again exactly the same way.
 *
 * Field names are said the way the form says them: `email.replyTo` is
 * "reply to", not a path. Three at most, because a wall of them is no better
 * than none.
 */
export function readableZodError(error: ZodError): string {
  const said = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path[issue.path.length - 1];
    const label =
      typeof field === 'string'
        ? field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').toLowerCase()
        : null;
    return label ? `${label}: ${issue.message}` : issue.message;
  });

  const rest = error.issues.length - said.length;
  return `${said.join('; ')}${rest > 0 ? ` (and ${rest} more)` : ''}`;
}

/**
 * AN EMPTY QUERY PARAMETER MEANS "NOT SET".
 *
 * An HTML GET form submits every control it contains, so a filter bar with a
 * status dropdown on "All statuses" and two blank date boxes navigates to
 * `?q=&status=&from=&to=`. To zod those are three present values: `status: ''`
 * fails an enum, `from: ''` coerces to an Invalid Date and fails too. The whole
 * request is refused with 422 and the screen shows an empty list -- which is
 * how the invoices page came to say "No invoices here. Bills you create will
 * appear here" to a salon with hundreds of bills, whenever anybody pressed
 * Apply without setting a filter.
 *
 * Dropped here rather than in each schema because every list screen in the app
 * has the same filter bar and would otherwise need the same guard, one schema
 * at a time, discovered one bug report at a time. No API here wants `?q=` to
 * mean something different from an absent `q`.
 */
function stripBlanks(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query;

  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === '') continue;
    // `?status=&status=PAID` arrives as an array; drop the blanks inside it and
    // then the key itself if that emptied it.
    if (Array.isArray(value)) {
      const values = value.filter((entry) => entry !== '');
      if (values.length === 0) continue;
      kept[key] = values;
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

/**
 * Validates and REPLACES req.body / req.query / req.params with the parsed
 * values, so handlers work with coerced, typed data.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        const parsed = schemas.query.parse(stripBlanks(req.query)) as Record<string, unknown>;
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new AppError(readableZodError(err), 422, 'VALIDATION_ERROR', formatZodError(err)));
        return;
      }
      next(err);
    }
  };
}

export type Body<T extends ZodTypeAny> = z.infer<T>;
export type Query<T extends ZodTypeAny> = z.infer<T>;

import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env';

const skip = () => isTest;

/** Generic API ceiling, keyed per authenticated user (falls back to IP). */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? 'anonymous',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Slow down a little and try again.' } },
});

/** Credential endpoints get a much tighter budget. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  keyGenerator: (req) => `${req.ip}:${String((req.body as { email?: string } | undefined)?.email ?? '')}`,
  message: {
    success: false,
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a few minutes.' },
  },
});

/** Public booking pages are unauthenticated, so they are limited by IP. */
export const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests.' } },
});

/**
 * An enquiry is cheap to store and expensive to read — every junk one is a
 * real person's minute spent deciding it is junk. Tighter than the rest of the
 * public surface for that reason, not for load.
 */
export const enquiryLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many enquiries from this address. Please give us a call instead — we would rather talk anyway.',
    },
  },
});

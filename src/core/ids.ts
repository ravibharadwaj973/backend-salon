import { customAlphabet } from 'nanoid';
import { randomBytes, createHash } from 'node:crypto';

const CODE_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid misreads
export const shortCode = customAlphabet(CODE_ALPHABET, 8);
export const publicToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

export function requestId(): string {
  return randomBytes(8).toString('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/** Zero-padded running numbers: CUST-000123, PO-000045 */
export function sequenceNumber(prefix: string, counter: number, width = 6): string {
  return `${prefix}-${String(counter).padStart(width, '0')}`;
}

/** Slugify a salon name into a tenant slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Normalise an Indian mobile number to bare 10 digits where possible; otherwise
 * strip everything but digits and a leading +.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[^\d+]/g, '');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  return digits || trimmed;
}

/** E.164 for messaging providers. */
export function toE164(raw: string, countryCode = '91'): string {
  const local = normalizePhone(raw);
  if (local.startsWith('+')) return local;
  if (local.length === 10) return `+${countryCode}${local}`;
  return `+${local}`;
}

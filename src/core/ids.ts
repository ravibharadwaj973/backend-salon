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

/**
 * A person's name, capitalised the way a salon would write it on a bill.
 *
 * "arihant rana" → "Arihant Rana". Applied on the way in rather than on the way
 * out, because the name is not only read on screen: it goes into WhatsApp
 * messages, invoices and review requests, and a customer greeted as "Hi
 * arihant" reads as a mail merge that went wrong.
 *
 * The decision is made about the WHOLE name, not each word, and that is the
 * part worth getting right. Capitalising word by word turns "van der Berg"
 * into "Van Der Berg" — a test caught exactly that — because no per-word rule
 * can know that "der" is a particle and "Der" is not a surname.
 *
 * So: a name that already mixes cases has been spelled deliberately by
 * somebody, and is left exactly alone. Only a name typed entirely in one case
 * is touched.
 *
 *   arihant rana   → Arihant Rana     (nothing was decided; decide)
 *   RAVI BHARADWAJ → Ravi Bharadwaj   (shouting; quieten)
 *   van der Berg   → van der Berg     (spelled on purpose)
 *   McDonald       → McDonald
 *   d'Souza        → d'Souza
 *
 * Which also makes it safe to run over a whole table: a name a salon has
 * corrected by hand is never un-corrected on the next save.
 */
export function toDisplayName(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;

  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return name;

  const hasLower = /[a-z]/.test(name);
  const hasUpper = /[A-Z]/.test(name);

  // Mixed case is somebody's deliberate spelling. Leave it.
  if (hasLower && hasUpper) return name;

  const lowered = hasUpper ? name.toLowerCase() : name;
  return lowered.replace(/(^|[\s-])([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase());
}

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readableZodError } from '../src/middleware/validate';

/**
 * THE BLANK OPTIONAL FIELD THAT THREW THE WHOLE FORM AWAY.
 *
 * The messaging settings form sends every field on every save, so a box the
 * salon never touched arrives as "". z.string().email() refuses "", so filling
 * in the API key and the from address and leaving Reply-to alone -- which the
 * form itself labels Optional -- failed validation and saved nothing at all.
 *
 * The screen then said the SERVER was missing RESEND_API_KEY, because from the
 * database's point of view the salon had configured nothing. Two people can
 * lose a day to that.
 *
 * This is the schema from messaging.routes.ts. Kept here rather than imported
 * because importing the routes drags in the database, the env and the whole
 * app; the rule is small enough to state twice and this test exists to stop it
 * being quietly relaxed.
 */
const optionalEmail = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .trim()
    .email('that does not look like an email address — it should read like name@yourdomain.com')
    .max(160)
    .optional(),
);

const emailSetup = z.object({
  fromName: z.string().trim().max(80).optional(),
  fromAddress: optionalEmail,
  apiKey: z.string().trim().max(200).optional(),
  replyTo: optionalEmail,
});

describe('email settings accept what the form actually sends', () => {
  it('takes a blank optional field, because the form always sends one', () => {
    const result = emailSetup.safeParse({
      fromName: 'Glow Studio',
      fromAddress: 'billing@glowstudio.in',
      apiKey: 're_xxxxxxxxxxxxxxxxxxxxx',
      replyTo: '',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.replyTo).toBeUndefined();
      expect(result.data.fromAddress).toBe('billing@glowstudio.in');
    }
  });

  it('takes whitespace the same way, because a cleared box can leave a space', () => {
    const result = emailSetup.safeParse({ fromAddress: '   ', replyTo: '  ' });
    expect(result.success).toBe(true);
  });

  it('still refuses an address that is filled in and wrong', () => {
    const result = emailSetup.safeParse({ fromAddress: 'billing@', replyTo: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['fromAddress']);
      expect(result.error.issues[0]?.message).toContain('name@yourdomain.com');
    }
  });

  it('saves nothing being sent at all, which is how one channel is edited alone', () => {
    expect(emailSetup.safeParse({}).success).toBe(true);
  });
});

/**
 * And the sentence the salon owner actually reads.
 *
 * formatZodError built a details array naming every field and its reason, the
 * AppError message said "Validation failed", and the client shows the message.
 * So every refused form in the app said the same four syllables and the salon
 * filled it in again exactly as before.
 */
describe('a refused form says which field and why', () => {
  it('names the field in the words the form uses', () => {
    const result = emailSetup.safeParse({ replyTo: 'not-an-address' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = readableZodError(result.error);
    expect(message).toContain('reply to');
    expect(message).toContain('name@yourdomain.com');
    expect(message).not.toBe('Validation failed');
  });

  it('splits a camelCase field into words rather than printing the path', () => {
    const result = emailSetup.safeParse({ fromAddress: 'nope' });
    if (result.success) throw new Error('expected a failure');
    expect(readableZodError(result.error)).toContain('from address');
  });

  it('stops at three and counts the rest, so it stays a sentence', () => {
    const many = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string() });
    const result = many.safeParse({});
    if (result.success) throw new Error('expected a failure');

    const message = readableZodError(result.error);
    expect(message).toContain('(and 2 more)');
    expect(message.split(';')).toHaveLength(3);
  });
});

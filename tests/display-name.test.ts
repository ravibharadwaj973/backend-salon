import { describe, expect, it } from 'vitest';
import { toDisplayName } from '../src/core/ids';

/**
 * Names, tidied — but only where tidying is safe.
 *
 * The temptation is `name.toLowerCase()` then capitalise, which is one line and
 * turns McDonald into Mcdonald and D'Souza into D'souza. People are attached to
 * the spelling of their own name, and a salon that corrects one by hand should
 * not find it un-corrected the next time the record is saved.
 */
describe('capitalising a name', () => {
  it('capitalises a name typed in lower case', () => {
    expect(toDisplayName('arihant')).toBe('Arihant');
    expect(toDisplayName('kshitiz roy')).toBe('Kshitiz Roy');
    expect(toDisplayName('sony khandelwal')).toBe('Sony Khandelwal');
  });

  it('tidies a name typed in capitals', () => {
    expect(toDisplayName('RAVI')).toBe('Ravi');
    expect(toDisplayName('RAVI BHARADWAJ')).toBe('Ravi Bharadwaj');
  });

  it('leaves a name that already mixes cases exactly alone', () => {
    // The rule that makes this safe to run over a whole table: anything
    // somebody has already spelled deliberately is never touched again.
    expect(toDisplayName('McDonald')).toBe('McDonald');
    expect(toDisplayName("d'Souza")).toBe("d'Souza");
    expect(toDisplayName('van der Berg')).toBe('van der Berg');
    expect(toDisplayName('Ravi Bharadwaj')).toBe('Ravi Bharadwaj');
  });

  it('keeps hyphens and does not swallow the second half', () => {
    expect(toDisplayName('mary-jane')).toBe('Mary-Jane');
  });

  it('is idempotent', () => {
    // Runs on every save, so applying it twice must not drift.
    const once = toDisplayName('arihant rana') as string;
    expect(toDisplayName(once)).toBe(once);
  });

  it('tidies stray whitespace without inventing a name', () => {
    expect(toDisplayName('  ravi   bharadwaj ')).toBe('Ravi Bharadwaj');
    expect(toDisplayName('')).toBe('');
  });

  it('passes null and undefined through, so an absent last name stays absent', () => {
    // A blank surname must not become an empty string: the difference decides
    // whether a message says "Hi Ravi" or "Hi Ravi ".
    expect(toDisplayName(null)).toBeNull();
    expect(toDisplayName(undefined)).toBeUndefined();
  });
});

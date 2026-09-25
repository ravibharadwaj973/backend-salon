import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_DECLARATION,
  documentTitle,
  gstinChecksumValid,
  mayChargeTax,
  needsGstin,
  panFromGstin,
  parseStatus,
  validateGstin,
} from '../src/modules/billing/tax-identity';

/**
 * Three registrations, three different documents, and getting it wrong is not
 * cosmetic in either direction:
 *
 *   a composition dealer whose bills say "Tax Invoice" and show CGST is
 *   collecting tax it is not permitted to collect;
 *
 *   a registered salon issuing plain invoices cannot let its customers claim
 *   credit, which is how it loses corporate clients.
 */
describe('what the bill is called', () => {
  it('names each document what the law names it', () => {
    expect(documentTitle('REGULAR')).toBe('Tax Invoice');
    expect(documentTitle('COMPOSITION')).toBe('Bill of Supply');
    expect(documentTitle('UNREGISTERED')).toBe('Invoice');
  });

  it('lets only a regular registration charge GST', () => {
    // The single most important line in the module. A composition dealer pays
    // tax out of turnover and may not pass it to the customer.
    expect(mayChargeTax('REGULAR')).toBe(true);
    expect(mayChargeTax('COMPOSITION')).toBe(false);
    expect(mayChargeTax('UNREGISTERED')).toBe(false);
  });

  it('keeps the composition declaration in the prescribed words', () => {
    // Rule 5(b) prescribes this wording. Paraphrasing it is a defective
    // document, so it is a constant rather than a sentence somebody rewrites.
    expect(COMPOSITION_DECLARATION).toBe('Composition taxable person, not eligible to collect tax on supplies');
  });

  it('needs a GSTIN for both registered kinds and neither for none', () => {
    expect(needsGstin('REGULAR')).toBe(true);
    expect(needsGstin('COMPOSITION')).toBe(true);
    expect(needsGstin('UNREGISTERED')).toBe(false);
  });
});

/**
 * A GSTIN is not entered once and checked once: it is printed on every bill the
 * salon ever issues, and it is the number their customers' accountants
 * reconcile against. One wrong character is found months later by somebody else.
 *
 * The shape check that existed before catches a wrong length and nothing more —
 * 27AAPFU0939F1ZV and 27AAPFU0939F1ZW are both well-shaped and only one exists.
 */
describe('checking a GSTIN is real and not a typo', () => {
  // Verified against the published algorithm rather than invented: base-36,
  // alternate positions doubled, digits folded, 15th character = (36 - sum%36)%36.
  const REAL = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '24AAACC1206D1ZM'];

  it('accepts GSTINs whose check character is correct', () => {
    for (const gstin of REAL) {
      expect(gstinChecksumValid(gstin), gstin).toBe(true);
      expect(validateGstin(gstin), gstin).toBeNull();
    }
  });

  it('rejects a single wrong character in the check position', () => {
    // The exact mistake a shape-only check waves through.
    expect(gstinChecksumValid('27AAPFU0939F1ZW')).toBe(false);
    expect(validateGstin('27AAPFU0939F1ZW')?.message).toMatch(/does not check out/);
  });

  it('rejects two transposed characters', () => {
    // The commonest typing error there is, and invisible to a shape check.
    expect(gstinChecksumValid('27AAPFU0939F1ZV')).toBe(true);
    expect(gstinChecksumValid('27AAPFU9039F1ZV')).toBe(false);
  });

  it('tells the two kinds of wrong apart', () => {
    // "Invalid GSTIN" on a number copied straight off a certificate gets the
    // same number retyped five times. The message has to say which check failed.
    expect(validateGstin('27AAPFU0939F1Z')?.message).toMatch(/15 characters/);
    expect(validateGstin('27AAPFU0939F1ZW')?.message).toMatch(/certificate/);
  });

  it('is case- and whitespace-forgiving, because people paste', () => {
    expect(validateGstin('  27aapfu0939f1zv  ')).toBeNull();
  });

  it('rejects a well-shaped string that is not a GSTIN at all', () => {
    expect(validateGstin('00AAAAA0000A0Z0')).not.toBeNull();
  });

  it('reads the PAN out of a GSTIN', () => {
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
    expect(panFromGstin('nonsense')).toBeNull();
  });
});

describe('a business that has never set this', () => {
  it('infers from whether a GSTIN was ever entered', () => {
    // Existing salons must not have their bills silently change the day this
    // ships: one with a GSTIN was issuing tax invoices and still is.
    expect(parseStatus(undefined, true)).toBe('REGULAR');
    expect(parseStatus(undefined, false)).toBe('UNREGISTERED');
  });

  it('honours a stored answer over the inference', () => {
    expect(parseStatus('COMPOSITION', true)).toBe('COMPOSITION');
    expect(parseStatus('UNREGISTERED', true)).toBe('UNREGISTERED');
  });

  it('does not read a junk value as a registration', () => {
    expect(parseStatus('BANANA', false)).toBe('UNREGISTERED');
  });
});

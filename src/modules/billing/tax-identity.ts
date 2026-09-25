/**
 * WHO THE BUSINESS IS, FOR TAX PURPOSES, AND WHAT THAT PUTS ON THE BILL.
 *
 * Not every salon is GST-registered, and the ones that are are not all
 * registered the same way. Three situations, three different documents, and the
 * app was only ever able to produce the first:
 *
 *   REGULAR      registered normally. Issues a TAX INVOICE showing CGST/SGST
 *                (or IGST), and the customer can claim input credit from it.
 *
 *   COMPOSITION  registered under the composition scheme. Pays tax out of
 *                turnover and may NOT collect it from the customer, so the
 *                document is a BILL OF SUPPLY with no tax on it, and it must
 *                carry a declaration saying so — Rule 5(b) of the Composition
 *                Rules makes that wording mandatory, not decorative.
 *
 *   UNREGISTERED below the threshold, or simply not registered. No GSTIN, no
 *                tax, no "Tax Invoice" heading. A plain invoice.
 *
 * Getting this wrong is not cosmetic in either direction. A composition dealer
 * whose bills say "Tax Invoice" and show CGST is collecting tax they are not
 * allowed to collect. An unregistered salon whose bills show a tax component
 * is doing the same. And a registered salon issuing plain invoices cannot have
 * its customers claim credit, which loses it corporate clients.
 */

export type RegistrationStatus = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';

export interface TaxIdentity {
  status: RegistrationStatus;
  gstin: string | null;
  legalName: string | null;
  tradeName: string | null;
  pan: string | null;
  stateCode: string | null;
}

/** What the bill is called, which follows from the registration and nothing else. */
export function documentTitle(status: RegistrationStatus): string {
  switch (status) {
    case 'REGULAR':
      return 'Tax Invoice';
    case 'COMPOSITION':
      return 'Bill of Supply';
    case 'UNREGISTERED':
      return 'Invoice';
  }
}

/**
 * Whether tax may appear on the bill at all.
 *
 * The single most important line in this file. Only a regular registration may
 * charge GST to a customer; the other two may not, and this is what the invoice
 * builder asks rather than each screen deciding for itself.
 */
export function mayChargeTax(status: RegistrationStatus): boolean {
  return status === 'REGULAR';
}

/**
 * The declaration a composition dealer's bill must carry, in the words the
 * rule uses. Not paraphrased: the wording is what is prescribed.
 */
export const COMPOSITION_DECLARATION =
  'Composition taxable person, not eligible to collect tax on supplies';

/** Whether a GSTIN is required before this business can issue bills. */
export function needsGstin(status: RegistrationStatus): boolean {
  return status !== 'UNREGISTERED';
}

// ------------------------------------------------------------- the checksum ---

const CHECK_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Is this GSTIN real, or a typo?
 *
 * The shape check that already existed — 2 digits, 5 letters, 4 digits, a
 * letter, an alphanumeric, "Z", an alphanumeric — catches a mistyped length and
 * nothing else. `27AAPFU0939F1ZW` and `27AAPFU0939F1ZV` are both well-shaped
 * and only one of them exists.
 *
 * That matters more here than in most fields, because a GSTIN is not entered
 * and checked once: it is printed on every bill the salon ever issues, and it
 * is the number their customers' accountants reconcile against. A single wrong
 * character is discovered months later by somebody else.
 *
 * The fifteenth character is a checksum over the first fourteen, base-36, with
 * alternate positions doubled and folded — so a transposition or a single wrong
 * character is caught here rather than by a stranger.
 */
export function gstinChecksumValid(gstin: string): boolean {
  const value = gstin.trim().toUpperCase();
  if (value.length !== 15) return false;

  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const digit = CHECK_ALPHABET.indexOf(value[i]!);
    if (digit < 0) return false;
    // Positions alternate weight 1 and 2, counting from the left.
    const weighted = digit * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }

  const expected = (36 - (sum % 36)) % 36;
  return value[14] === CHECK_ALPHABET[expected];
}

const SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

export interface GstinProblem {
  message: string;
}

/**
 * Both checks, with a message that says which one failed — "invalid GSTIN" on a
 * fifteen-character string the owner copied off their certificate is the sort
 * of error that gets a real number retyped five times.
 */
export function validateGstin(gstin: string): GstinProblem | null {
  const value = gstin.trim().toUpperCase();

  if (!SHAPE.test(value)) {
    return {
      message:
        'A GSTIN is 15 characters: two digits for the state, then a 10-character PAN, then a digit, then Z, then one check character. ' +
        'Copy it exactly as it appears on your registration certificate.',
    };
  }
  if (!gstinChecksumValid(value)) {
    return {
      message:
        'That GSTIN is the right shape but its last character does not check out, which almost always means one character is wrong or two have been swapped. ' +
        'Compare it against your registration certificate — this number goes on every bill you issue.',
    };
  }
  return null;
}

/** The PAN sitting inside a GSTIN, positions 3–12. */
export function panFromGstin(gstin: string): string | null {
  const value = gstin.trim().toUpperCase();
  return SHAPE.test(value) ? value.slice(2, 12) : null;
}

export function parseStatus(raw: unknown, hasGstin: boolean): RegistrationStatus {
  if (raw === 'COMPOSITION') return 'COMPOSITION';
  if (raw === 'UNREGISTERED') return 'UNREGISTERED';
  if (raw === 'REGULAR') return 'REGULAR';
  // Nothing stored: infer from whether a GSTIN was ever entered, so an existing
  // salon's bills do not silently change the day this ships.
  return hasGstin ? 'REGULAR' : 'UNREGISTERED';
}

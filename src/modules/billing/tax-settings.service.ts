import type { Prisma } from '@prisma/client';
import { prisma, type TxClient } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { financialYear } from './gst';
import {
  DEFAULT_FORMAT,
  counterKey,
  formatNumber,
  parseFormat,
  previewNumbers,
  seriesOf,
  validateFormat,
  type SeriesFormat,
  type SeriesKind,
} from './invoice-series';
import {
  COMPOSITION_DECLARATION,
  documentTitle,
  mayChargeTax,
  needsGstin,
  panFromGstin,
  parseStatus,
  validateGstin,
  type RegistrationStatus,
  type TaxIdentity,
} from './tax-identity';

/**
 * THE BUSINESS'S OWN BILLING RULES.
 *
 * Two things every business already has its own answer to, and which the app
 * previously decided for them: who they are for tax purposes, and what a bill
 * number looks like. Both live here, both are the owner's to set, and both are
 * validated before they can reach a bill — because a bad answer to either is
 * not discovered by the salon. It is discovered by their customer's accountant,
 * or at audit, months later, on every bill in between.
 */

const STATUS_KEY = 'gstRegistrationStatus';
const SERIES_KEY = 'invoiceSeriesFormat';

export interface TaxSettings {
  identity: TaxIdentity & { tradeName: string | null };
  /** What bills are headed, which follows from the registration. */
  documentTitle: string;
  /** Whether GST may appear on a bill at all. */
  mayChargeTax: boolean;
  /** The wording a composition dealer's bill must carry, when it must. */
  declaration: string | null;
  series: SeriesFormat;
  /** What the next three bills would be numbered, per branch, for both series. */
  preview: {
    branchId: string;
    branchName: string;
    prefix: string;
    numbers: string[];
    issued: number;
    nonGstPrefix: string;
    nonGstNumbers: string[];
    nonGstIssued: number;
  }[];
}

export async function getTaxSettings(): Promise<TaxSettings> {
  const tenantId = requireTenantId();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw NotFound('Business');

  const settings = (tenant.settings as Record<string, unknown>) ?? {};
  const status = parseStatus(settings[STATUS_KEY], Boolean(tenant.gstin));
  const series = parseFormat(settings[SERIES_KEY]);

  const branches = await prisma.branch.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, invoicePrefix: true },
    orderBy: { name: 'asc' },
  });

  const counters = await prisma.invoiceSeries.findMany({ where: { tenantId } });
  const key = counterKey(series, new Date(), 'GST');
  const nonGstKey = counterKey(series, new Date(), 'NON_GST');

  return {
    identity: {
      status,
      gstin: tenant.gstin,
      legalName: tenant.legalName,
      tradeName: tenant.name,
      pan: (settings.pan as string) ?? panFromGstin(tenant.gstin ?? ''),
      stateCode: tenant.stateCode,
    },
    documentTitle: documentTitle(status),
    mayChargeTax: mayChargeTax(status),
    declaration: status === 'COMPOSITION' ? COMPOSITION_DECLARATION : null,
    series,
    preview: branches.map((branch) => {
      const issued = counters.find((c) => c.branchId === branch.id && c.key === key)?.lastNumber ?? 0;
      const nonGstIssued = counters.find((c) => c.branchId === branch.id && c.key === nonGstKey)?.lastNumber ?? 0;
      // The preview shows where this branch actually IS, not where a fresh
      // series would start — an owner with 400 bills behind them who sees
      // "INV/25-26/00001" reasonably concludes the app is about to renumber
      // everything they have issued.
      const next = Math.max(issued + 1, series.startFrom);
      const nonGstNext = Math.max(nonGstIssued + 1, series.nonGstStartFrom);
      const three = (start: number, prefix: string) =>
        [start, start + 1, start + 2].map((n) => formatNumber({ ...series, prefix }, n, new Date()));
      return {
        branchId: branch.id,
        branchName: branch.name,
        prefix: branch.invoicePrefix,
        issued,
        numbers: three(next, branch.invoicePrefix),
        nonGstPrefix: series.nonGstPrefix,
        nonGstIssued,
        nonGstNumbers: three(nonGstNext, series.nonGstPrefix),
      };
    }),
  };
}

export interface UpdateTaxIdentityInput {
  status: RegistrationStatus;
  gstin?: string | null;
  legalName?: string | null;
  pan?: string | null;
  stateCode?: string | null;
}

export async function updateTaxIdentity(input: UpdateTaxIdentityInput) {
  const tenantId = requireTenantId();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw NotFound('Business');

  const gstin = (input.gstin ?? '').trim().toUpperCase();

  if (needsGstin(input.status)) {
    if (!gstin) {
      throw BadRequest(
        input.status === 'COMPOSITION'
          ? 'A composition-scheme business still has a GSTIN. Enter it, or choose "Not registered" if you have no GST registration.'
          : 'A GST-registered business needs its GSTIN before it can issue tax invoices. Enter it, or choose "Not registered".',
      );
    }
    const problem = validateGstin(gstin);
    if (problem) throw BadRequest(problem.message);
  }

  /**
   * Going from registered to unregistered is allowed — a salon can surrender a
   * registration — but the bills already issued keep their own heading, because
   * `documentTitle` was snapshotted onto each one. Nothing here rewrites them.
   */
  const settings = { ...((tenant.settings as Record<string, unknown>) ?? {}) };
  settings[STATUS_KEY] = input.status;
  if (input.pan) settings.pan = input.pan.trim().toUpperCase();
  // The old derived flag has to follow, or the invoice builder and this screen
  // disagree about whether tax is charged.
  settings.gstEnabled = mayChargeTax(input.status);

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      gstin: needsGstin(input.status) ? gstin : null,
      legalName: input.legalName?.trim() || tenant.legalName,
      // The state code decides CGST/SGST against IGST, so it follows the GSTIN
      // when one is present rather than being kept separately and drifting.
      stateCode: gstin ? gstin.slice(0, 2) : (input.stateCode?.trim() || tenant.stateCode),
      settings: settings as Prisma.InputJsonValue,
    },
  });

  return getTaxSettings();
}

export async function updateSeriesFormat(input: SeriesFormat) {
  const tenantId = requireTenantId();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw NotFound('Business');

  const problems = validateFormat(input);
  if (problems.length) {
    throw BadRequest(problems.map((p) => p.message).join(' '), { problems });
  }

  /**
   * THE CHECK THAT MATTERS.
   *
   * A start number below one already issued produces a duplicate bill number,
   * and a duplicate bill number cannot be explained away: two different sales
   * on one serial, in a series the law requires to be consecutive and unique.
   *
   * The unique constraint on (tenantId, invoiceNumber) would eventually catch
   * it — as a failed sale at the till, with a customer standing there. Caught
   * here instead, months earlier, by the person who typed it.
   */
  for (const kind of ['GST', 'NON_GST'] as const) {
    const key = counterKey(input, new Date(), kind);
    const startFrom = seriesOf(input, kind).startFrom;

    const issued = await prisma.invoiceSeries.findMany({
      where: { tenantId, key },
      select: { lastNumber: true, branch: { select: { name: true } } },
    });

    const furthest = issued.reduce<{ n: number; branch: string } | null>(
      (worst, row) => (row.lastNumber >= (worst?.n ?? 0) ? { n: row.lastNumber, branch: row.branch.name } : worst),
      null,
    );

    if (furthest && startFrom <= furthest.n) {
      const what = kind === 'GST' ? 'tax invoice' : 'bill without GST';
      throw BadRequest(
        `${furthest.branch} has already issued ${what} number ${furthest.n}, so starting again at ${startFrom} ` +
          `would give two different sales the same bill number. Start from ${furthest.n + 1} or higher.`,
      );
    }
  }

  const settings = { ...((tenant.settings as Record<string, unknown>) ?? {}) };
  settings[SERIES_KEY] = input as unknown as Prisma.InputJsonValue;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settings: settings as Prisma.InputJsonValue },
  });

  return getTaxSettings();
}

/** Try a format without saving it — what the owner sees as they type. */
export function previewFormat(format: SeriesFormat) {
  const problems = validateFormat(format);
  return {
    problems,
    numbers: problems.length ? [] : previewNumbers(format),
  };
}

// ------------------------------------------------------- issuing a number ---

export interface IssuedNumber {
  invoiceNumber: string;
  documentTitle: string;
}

/**
 * Make sure this branch's counter row exists, BEFORE the sale's transaction
 * opens.
 *
 * This split looks fussy and is not. The obvious shape — read the counter,
 * add one, write it back — has two tills at 5 both computing 6, and the
 * duplicate is then caught by the unique index on the invoice number, which is
 * to say: as a failed sale with a customer standing at the counter. The old
 * code avoided that with an atomic `increment`, and that property has to
 * survive.
 *
 * An atomic increment needs a row to increment, though, and creating one lazily
 * inside the transaction means a try/catch inside the transaction — which in
 * Postgres poisons it, because a failed statement aborts the whole transaction
 * unless savepoints are in play and Prisma does not add them. Every later query
 * in the sale would fail with "current transaction is aborted".
 *
 * So the row is created out here, where a retry costs nothing, seeded one below
 * the start number so the first increment lands exactly on it. Inside the
 * transaction there is then only the atomic increment, which cannot race.
 */
export async function ensureSeries(input: {
  tenantId: string;
  branchId: string;
  invoiceDate: Date;
  format: SeriesFormat;
  kind: SeriesKind;
}): Promise<void> {
  const key = counterKey(input.format, input.invoiceDate, input.kind);
  const seed = Math.max(1, seriesOf(input.format, input.kind).startFrom) - 1;

  await prisma.invoiceSeries.upsert({
    where: { branchId_key: { branchId: input.branchId, key } },
    create: { tenantId: input.tenantId, branchId: input.branchId, key, lastNumber: seed },
    // Deliberately empty: an existing counter is authoritative and a changed
    // start number must never reach backwards into bills already issued.
    update: {},
  });
}

/**
 * Take the next bill number, inside the caller's transaction.
 *
 * One atomic increment, on a row `ensureSeries` has already created. Two tills
 * billing in the same millisecond serialise on that row and get 6 and 7.
 */
export async function issueInvoiceNumber(
  tx: TxClient,
  input: {
    branchId: string;
    invoiceDate: Date;
    /** The branch's own prefix, which overrides the format's for tax invoices. */
    branchPrefix: string;
    format: SeriesFormat;
    status: RegistrationStatus;
    kind: SeriesKind;
  },
): Promise<IssuedNumber> {
  const key = counterKey(input.format, input.invoiceDate, input.kind);

  const row = await tx.invoiceSeries.update({
    where: { branchId_key: { branchId: input.branchId, key } },
    data: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  // A tax invoice carries the branch's prefix, because each shop's series is
  // its own. A non-GST bill carries the business-wide non-GST prefix, so those
  // are recognisable at a glance as what they are.
  const prefix = input.kind === 'GST' ? input.branchPrefix : seriesOf(input.format, 'NON_GST').prefix;

  return {
    invoiceNumber: formatNumber({ ...input.format, prefix }, row.lastNumber, input.invoiceDate),
    // A bill with no GST on it is never a tax invoice, whatever the business's
    // own registration is: the document has to match what is on it.
    documentTitle: input.kind === 'GST' ? documentTitle(input.status) : documentTitle('UNREGISTERED'),
  };
}

/** Everything the invoice builder needs, read once per sale. */
export async function billingIdentity(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  const status = parseStatus(settings[STATUS_KEY], Boolean(tenant?.gstin));
  return {
    status,
    format: parseFormat(settings[SERIES_KEY]),
    mayChargeTax: mayChargeTax(status),
    documentTitle: documentTitle(status),
    financialYear: financialYear(new Date()),
    defaultFormat: DEFAULT_FORMAT,
  };
}

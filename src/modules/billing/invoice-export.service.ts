import Papa from 'papaparse';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId } from '../../core/context';
import { branchFilter } from '../../core/scope';
import { dateKey } from '../../core/dates';
import { financialYear } from './gst';

/**
 * EVERY BILL, IN THE ORDER IT WAS ISSUED, FOR SOMEBODY ELSE TO READ.
 *
 * This file leaves the building. It goes to an accountant, into a GSTR-1
 * working paper, or in front of an officer — so two things matter more here
 * than they would for an on-screen list:
 *
 *   ORDER. Sorted by the bill number's own SEQUENCE, not by date and not
 *   alphabetically. Alphabetical puts INV/25-26/00010 before INV/25-26/0009,
 *   and a return that appears to skip a number invites exactly the question
 *   nobody wants to answer. Date order is nearly right and quietly wrong: two
 *   bills on the same day come back in whatever order the database felt like.
 *
 *   COMPLETENESS. Voided bills are INCLUDED, marked as such. A cancelled bill
 *   number is not a number that may go missing: the series has to be
 *   continuous, and a gap is a question. Filtering them out produces a tidier
 *   file that is harder to defend.
 */

export interface InvoiceExportFilter {
  from?: Date;
  to?: Date;
  branchId?: string;
  /** "25-26" — the way an accountant actually asks for this. */
  financialYear?: string;
}

/**
 * The trailing digits of a bill number, as a number.
 *
 * The sequence cannot be read off a column, because the format is the salon's
 * own: "INV/25-26/00042", "GC-42" and "42" are all legal and all mean
 * forty-two. So it is parsed from the end of the string, which is where every
 * format this app can produce puts it.
 */
export function sequenceOf(invoiceNumber: string): number {
  const match = invoiceNumber.match(/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
}

/**
 * Sort key: the series, then the position within it.
 *
 * Everything before the trailing digits identifies the series — branch prefix
 * and financial year — so two branches' bills group rather than interleaving,
 * and each group counts up from its own first bill.
 */
export function sortKey(invoiceNumber: string): [string, number] {
  return [invoiceNumber.replace(/(\d+)\s*$/, ''), sequenceOf(invoiceNumber)];
}

export function compareInvoiceNumbers(a: string, b: string): number {
  const [seriesA, seqA] = sortKey(a);
  const [seriesB, seqB] = sortKey(b);
  return seriesA === seriesB ? seqA - seqB : seriesA.localeCompare(seriesB);
}

const COLUMNS = [
  'Bill number',
  'Document',
  'Date',
  'Financial year',
  'Branch',
  'Customer',
  'Customer phone',
  'Place of supply',
  'Supply type',
  'Taxable value',
  'CGST',
  'SGST',
  'IGST',
  'Total tax',
  'Round off',
  'Invoice total',
  'Paid',
  'Balance due',
  'Status',
  'Billed by',
] as const;

export async function exportInvoices(filter: InvoiceExportFilter) {
  const tenantId = requireTenantId();

  const where: Prisma.InvoiceWhereInput = {
    tenantId,
    ...branchFilter(filter.branchId),
    ...(filter.from || filter.to
      ? { invoiceDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };

  const invoices = await prisma.invoice.findMany({
    where,
    take: 100_000,
    select: {
      invoiceNumber: true,
      documentTitle: true,
      invoiceDate: true,
      isGst: true,
      isInterState: true,
      placeOfSupply: true,
      taxableAmount: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      totalTax: true,
      roundOff: true,
      grandTotal: true,
      paidAmount: true,
      dueAmount: true,
      status: true,
      voidedAt: true,
      branch: { select: { name: true } },
      customer: { select: { firstName: true, lastName: true, phone: true } },
      createdBy: { select: { name: true } },
    },
  });

  const rows = invoices
    .filter((i) => (filter.financialYear ? financialYear(i.invoiceDate) === filter.financialYear : true))
    .sort((a, b) => compareInvoiceNumbers(a.invoiceNumber, b.invoiceNumber));

  const csv = Papa.unparse({
    fields: [...COLUMNS],
    data: rows.map((i) => [
      i.invoiceNumber,
      // Falls back for bills issued before the heading was recorded, using the
      // one fact those rows do carry.
      i.documentTitle ?? (i.isGst ? 'Tax Invoice' : 'Invoice'),
      dateKey(i.invoiceDate),
      financialYear(i.invoiceDate),
      i.branch?.name ?? '',
      i.customer ? `${i.customer.firstName} ${i.customer.lastName ?? ''}`.trim() : 'Walk-in',
      i.customer?.phone ?? '',
      i.placeOfSupply ?? '',
      i.isGst ? (i.isInterState ? 'Inter-state (IGST)' : 'Intra-state (CGST/SGST)') : 'No GST',
      i.taxableAmount.toString(),
      i.cgstAmount.toString(),
      i.sgstAmount.toString(),
      i.igstAmount.toString(),
      i.totalTax.toString(),
      i.roundOff.toString(),
      i.grandTotal.toString(),
      i.paidAmount.toString(),
      i.dueAmount.toString(),
      // "VOID" rather than the raw status, because that is the word the reader
      // is looking for when a number turns up with no money against it.
      i.voidedAt ? 'VOID' : i.status,
      i.createdBy?.name ?? '',
    ]),
  });

  return { csv, count: rows.length };
}

export interface SeriesAuditRow {
  series: string;
  branch: string;
  count: number;
  first: number | null;
  last: number | null;
  missing: number[];
  truncated: boolean;
}

/**
 * Gaps in the series — the first thing anybody checking the books looks for.
 *
 * A missing number is not necessarily wrong: a draft can be deleted before it
 * is settled. But it is always a question, and the salon should be the one who
 * finds it rather than an officer. Reported per series, because two branches
 * counting independently are not gaps in each other.
 */
export async function seriesAudit(filter: InvoiceExportFilter): Promise<SeriesAuditRow[]> {
  const tenantId = requireTenantId();

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      ...branchFilter(filter.branchId),
      ...(filter.from || filter.to
        ? { invoiceDate: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
    },
    select: { invoiceNumber: true, invoiceDate: true, branch: { select: { name: true } } },
    take: 100_000,
  });

  const bySeries = new Map<string, { branch: string; numbers: number[] }>();
  for (const invoice of invoices) {
    if (filter.financialYear && financialYear(invoice.invoiceDate) !== filter.financialYear) continue;
    const [series] = sortKey(invoice.invoiceNumber);
    const entry = bySeries.get(series) ?? { branch: invoice.branch?.name ?? '', numbers: [] };
    entry.numbers.push(sequenceOf(invoice.invoiceNumber));
    bySeries.set(series, entry);
  }

  return [...bySeries.entries()]
    .map(([series, entry]) => {
      const sorted = [...entry.numbers].sort((a, b) => a - b);
      const missing: number[] = [];
      let truncated = false;

      for (let i = 1; i < sorted.length && !truncated; i += 1) {
        for (let n = sorted[i - 1]! + 1; n < sorted[i]!; n += 1) {
          // Bounded: one unparseable number read as 0 beside 90,000 must not
          // try to list ninety thousand gaps and take the server with it.
          if (missing.length >= 200) {
            truncated = true;
            break;
          }
          missing.push(n);
        }
      }

      return {
        series: series || '(no prefix)',
        branch: entry.branch,
        count: sorted.length,
        first: sorted[0] ?? null,
        last: sorted.at(-1) ?? null,
        missing,
        truncated,
      };
    })
    .sort((a, b) => a.series.localeCompare(b.series));
}

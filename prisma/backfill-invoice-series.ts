/**
 * BACKFILL: MOVE EACH BRANCH'S BILL COUNT INTO ITS OWN SERIES ROW.
 *
 * `Branch.invoiceCounter` was one running integer per branch. Numbering now
 * lives in InvoiceSeries, keyed by financial year so it can restart each April.
 *
 * Without this, the first bill after deploy starts at 1 and collides with the
 * bill numbered 1 last April — the unique index on (tenant, invoiceNumber)
 * catches it, which means the failure arrives as a refused sale with a customer
 * standing at the counter.
 *
 * The count is taken from the bills themselves rather than from the old
 * counter, because the bills are the record: the highest sequence actually
 * issued in each series is, by definition, the right place to carry on from.
 *
 * Safe to run more than once: it only ever raises a counter to match the bills
 * on file, never lowers one.
 *
 *   docker run --rm --network salon --env-file .env api:migrate \
 *     npx tsx prisma/backfill-invoice-series.ts
 */
import { PrismaClient } from '@prisma/client';
import { financialYear } from '../src/modules/billing/gst';
import { sequenceOf } from '../src/modules/billing/invoice-export.service';
import { parseFormat, counterKey } from '../src/modules/billing/invoice-series';

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, settings: true } });
  let written = 0;

  for (const tenant of tenants) {
    const settings = (tenant.settings as Record<string, unknown>) ?? {};
    const format = parseFormat(settings.invoiceSeriesFormat);

    const invoices = await prisma.invoice.findMany({
      where: { tenantId: tenant.id },
      select: { branchId: true, invoiceNumber: true, invoiceDate: true, isGst: true },
    });

    /** branchId + series key -> the highest sequence already issued there. */
    const highest = new Map<string, number>();

    for (const invoice of invoices) {
      // Keyed exactly as the live path keys it, including the non-GST suffix,
      // or the two series would carry on from each other's positions.
      const key = counterKey(format, invoice.invoiceDate, invoice.isGst ? 'GST' : 'NON_GST');
      const id = `${invoice.branchId}\u0000${key}`;
      const sequence = sequenceOf(invoice.invoiceNumber);
      if (sequence > (highest.get(id) ?? 0)) highest.set(id, sequence);
    }

    for (const [id, lastNumber] of highest) {
      const [branchId, key] = id.split('\u0000') as [string, string];
      const existing = await prisma.invoiceSeries.findUnique({
        where: { branchId_key: { branchId, key } },
        select: { lastNumber: true },
      });

      // Only ever upwards. Lowering a counter is how a duplicate is created.
      if (existing && existing.lastNumber >= lastNumber) continue;

      await prisma.invoiceSeries.upsert({
        where: { branchId_key: { branchId, key } },
        create: { tenantId: tenant.id, branchId, key, lastNumber },
        update: { lastNumber },
      });
      written += 1;
      console.log(`${tenant.name}: branch ${branchId} series "${key || 'continuous'}" carries on from ${lastNumber}`);
    }
  }

  console.log(`\n${written} series positions written. Current financial year is ${financialYear(new Date())}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

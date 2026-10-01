-- MORE THAN ONE PERSON ON A BILLED SERVICE.
--
-- Two stylists on one bridal makeup is ordinary, and the bill could record one.
-- The second did the work and earned nothing, because there was one column.
--
-- Guarded throughout: this database is managed with `prisma db push` and has no
-- _prisma_migrations table, so every statement here has to survive being run
-- against a schema that already has the change.
--
-- invoice_items."staffId" IS DELIBERATELY LEFT ALONE. It is the primary
-- performer, and every report in the app reads it — revenue by stylist, the
-- staff filter on the invoice list, a stylist's own page. This table carries the
-- full cast including the primary, so there is one place to read "who was on
-- this line" and nothing downstream has to be rewritten at the same time.

CREATE TABLE IF NOT EXISTS "invoice_item_staff" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "invoiceItemId" TEXT NOT NULL,
  "staffId"       TEXT NOT NULL,
  "sharePct"      DECIMAL(5,2) NOT NULL DEFAULT 100,
  "isPrimary"     BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "invoice_item_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invoice_item_staff_invoiceItemId_staffId_key"
  ON "invoice_item_staff" ("invoiceItemId", "staffId");

CREATE INDEX IF NOT EXISTS "invoice_item_staff_tenantId_staffId_idx"
  ON "invoice_item_staff" ("tenantId", "staffId");

DO $$ BEGIN
  ALTER TABLE "invoice_item_staff"
    ADD CONSTRAINT "invoice_item_staff_invoiceItemId_fkey"
    FOREIGN KEY ("invoiceItemId") REFERENCES "invoice_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "invoice_item_staff"
    ADD CONSTRAINT "invoice_item_staff_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- BACKFILL: every line that already names somebody gets that person as its sole
-- performer, at 100%.
--
-- This one IS safe to backfill, unlike the service-meter migration beside it,
-- and the difference is worth naming. There, inventing history would have
-- changed what a tenant was billed. Here the source and the destination say the
-- same thing — "Priya performed this service" — in two places, and the new place
-- is empty. Without it, every bill raised before today would show no performer
-- at all on the new screen while the old column still reads correctly, which
-- looks exactly like data loss to the person holding the payroll.
--
-- ON CONFLICT DO NOTHING so a re-run is free, and NOT EXISTS so a line already
-- carrying performers (one entered since the deploy) is never touched.
INSERT INTO "invoice_item_staff" ("id", "tenantId", "invoiceItemId", "staffId", "sharePct", "isPrimary")
SELECT
  md5(random()::text || clock_timestamp()::text),
  i."tenantId",
  i."id",
  i."staffId",
  100,
  true
FROM "invoice_items" i
WHERE i."staffId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "invoice_item_staff" s WHERE s."invoiceItemId" = i."id")
ON CONFLICT DO NOTHING;

-- REFERENCE PICTURES FOR THE MENU.
--
-- Guarded, like every migration here: this database is maintained with
-- `prisma db push` and has no _prisma_migrations table, so each statement has to
-- be safe to run twice.

-- ADD VALUE IF NOT EXISTS is idempotent on its own, and cannot run inside a
-- transaction on older Postgres, so it stands alone.
ALTER TYPE "HairGenerationKind" ADD VALUE IF NOT EXISTS 'CATALOG_REFERENCE';

ALTER TABLE "hair_generations" ADD COLUMN IF NOT EXISTS "catalogId" TEXT;

CREATE INDEX IF NOT EXISTS "hair_generations_tenantId_catalogId_status_idx"
  ON "hair_generations" ("tenantId", "catalogId", "status");

-- SET NULL rather than CASCADE, unlike the analysis link added alongside it.
--
-- The two cascades answer different questions. A reading being deleted is a
-- customer withdrawing consent, so the pictures of her face go with it. A menu
-- entry being retired is a salon tidying up — and destroying reference pictures
-- it has already paid for, printed and put on a wall would be a surprising thing
-- for a rename to do.
DO $$
BEGIN
  ALTER TABLE "hair_generations"
    ADD CONSTRAINT "hair_generations_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "hairstyle_catalog" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

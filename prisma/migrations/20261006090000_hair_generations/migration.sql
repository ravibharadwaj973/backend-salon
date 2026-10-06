-- HAIR GENERATIONS — one row per call to the image model.
--
-- Guarded throughout, the same way every migration in this folder written since
-- the drift was measured is guarded. This database is maintained with
-- `prisma db push` and has no _prisma_migrations table, so this file may be
-- applied to a database that already has these objects, or re-applied by hand
-- after a push. Every statement must therefore be safe to run twice.

-- Enums: CREATE TYPE has no IF NOT EXISTS, so each is wrapped.
DO $$
BEGIN
  CREATE TYPE "HairGenerationStatus" AS ENUM ('PENDING', 'SUBMITTED', 'READY', 'FAILED', 'REFUSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "HairGenerationKind" AS ENUM ('MODEL_PORTRAIT', 'STYLE_PREVIEW', 'RECOLOUR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "hair_generations" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "branchId"      TEXT,
  "customerId"    TEXT,
  "designId"      TEXT,
  "kind"          "HairGenerationKind" NOT NULL,
  "status"        "HairGenerationStatus" NOT NULL DEFAULT 'PENDING',
  "prompt"        TEXT NOT NULL,
  "model"         TEXT NOT NULL,
  "seed"          INTEGER,
  "providerId"    TEXT,
  "pollingUrl"    TEXT,
  "inputImageUrl" TEXT,
  "imageUrl"      TEXT,
  "imagePublicId" TEXT,
  "width"         INTEGER,
  "height"        INTEGER,
  "bytes"         INTEGER,
  "error"         TEXT,
  "polls"         INTEGER NOT NULL DEFAULT 0,
  "submittedAt"   TIMESTAMP(3),
  "readyAt"       TIMESTAMP(3),
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hair_generations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "hair_generations_tenantId_createdAt_idx"
  ON "hair_generations" ("tenantId", "createdAt");

-- The sweep that rescues rows whose poll job was lost reads by status and age,
-- across tenants. Without this index it is a full scan every ten minutes.
CREATE INDEX IF NOT EXISTS "hair_generations_status_createdAt_idx"
  ON "hair_generations" ("status", "createdAt");

CREATE INDEX IF NOT EXISTS "hair_generations_tenantId_designId_idx"
  ON "hair_generations" ("tenantId", "designId");

-- Foreign keys: ADD CONSTRAINT has no IF NOT EXISTS either.
--
-- The design is SET NULL rather than CASCADE on purpose. A salon that tidies up
-- its saved looks must not thereby delete pictures it has already shown
-- customers and may have printed — and we paid for each one. The customer link
-- is SET NULL for the same reason, with the picture itself being of a virtual
-- model and not of them.
DO $$
BEGIN
  ALTER TABLE "hair_generations"
    ADD CONSTRAINT "hair_generations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "hair_generations"
    ADD CONSTRAINT "hair_generations_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "hair_generations"
    ADD CONSTRAINT "hair_generations_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "hair_generations"
    ADD CONSTRAINT "hair_generations_designId_fkey"
    FOREIGN KEY ("designId") REFERENCES "hair_designs" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

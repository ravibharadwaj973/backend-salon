-- The hair design studio: a catalogue of styles the salon offers, and the
-- looks designed from them.
--
-- Guarded throughout. This database is managed with `prisma db push` and has no
-- _prisma_migrations table, so every statement here has to survive being run
-- against a database that already has some or all of it.

-- ---------------------------------------------------------------- enums ----
DO $$ BEGIN
  CREATE TYPE "HairTexture" AS ENUM ('STRAIGHT', 'WAVY', 'CURLY', 'COILY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HairLength" AS ENUM ('VERY_SHORT', 'SHORT', 'MEDIUM', 'LONG', 'VERY_LONG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HairDensity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FaceShape" AS ENUM ('OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HairMaintenance" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------ hairstyle catalog ---
CREATE TABLE IF NOT EXISTS "hairstyle_catalog" (
  "id"                    TEXT NOT NULL,
  "tenantId"              TEXT NOT NULL,
  "branchId"              TEXT,
  "kind"                  TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "category"              TEXT,
  "gender"                "Gender" NOT NULL DEFAULT 'UNISEX',
  "description"           TEXT,
  "supportedTextures"     "HairTexture"[] DEFAULT ARRAY[]::"HairTexture"[],
  "supportedLengths"      "HairLength"[] DEFAULT ARRAY[]::"HairLength"[],
  "supportedDensities"    "HairDensity"[] DEFAULT ARRAY[]::"HairDensity"[],
  "recommendedFaceShapes" "FaceShape"[] DEFAULT ARRAY[]::"FaceShape"[],
  "supportsBangs"         BOOLEAN NOT NULL DEFAULT false,
  "supportsLayers"        BOOLEAN NOT NULL DEFAULT false,
  "supportsParting"       BOOLEAN NOT NULL DEFAULT true,
  "supportsFade"          BOOLEAN NOT NULL DEFAULT false,
  "maintenance"           "HairMaintenance" NOT NULL DEFAULT 'MEDIUM',
  "serviceId"             TEXT,
  "previewUrl"            TEXT,
  "isActive"              BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"             INTEGER NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hairstyle_catalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "hairstyle_catalog_tenantId_kind_name_key"
  ON "hairstyle_catalog" ("tenantId", "kind", "name");
CREATE INDEX IF NOT EXISTS "hairstyle_catalog_tenantId_isActive_sortOrder_idx"
  ON "hairstyle_catalog" ("tenantId", "isActive", "sortOrder");

-- ------------------------------------------------------------- designs -----
CREATE TABLE IF NOT EXISTS "hair_designs" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "branchId"      TEXT,
  "customerId"    TEXT,
  "catalogId"     TEXT,
  "name"          TEXT NOT NULL,
  "hairstyleKey"  TEXT NOT NULL,
  "modelKey"      TEXT NOT NULL,
  "texture"       "HairTexture" NOT NULL,
  "length"        "HairLength" NOT NULL,
  "density"       "HairDensity" NOT NULL DEFAULT 'MEDIUM',
  "volume"        INTEGER NOT NULL DEFAULT 50,
  "baseColor"     TEXT NOT NULL,
  "config"        JSONB NOT NULL DEFAULT '{}',
  "notes"         TEXT,
  "serviceId"     TEXT,
  "staffId"       TEXT,
  "appointmentId" TEXT,
  "isCurrent"     BOOLEAN NOT NULL DEFAULT false,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hair_designs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "hair_designs_tenantId_customerId_createdAt_idx"
  ON "hair_designs" ("tenantId", "customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "hair_designs_tenantId_catalogId_idx"
  ON "hair_designs" ("tenantId", "catalogId");

-- ONE CURRENT LOOK PER CUSTOMER, enforced by the database rather than only by
-- the service that maintains it. Two stylists saving a look for the same
-- customer at the same moment is not a rare event in a busy salon, and without
-- this the customer's record ends up with two "current" hairstyles and no way
-- to tell which is true. Partial, so the many non-current designs are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS "hair_designs_one_current_per_customer"
  ON "hair_designs" ("customerId")
  WHERE "isCurrent" AND "customerId" IS NOT NULL;

-- ------------------------------------------------------- foreign keys ------
DO $$ BEGIN
  ALTER TABLE "hairstyle_catalog" ADD CONSTRAINT "hairstyle_catalog_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hairstyle_catalog" ADD CONSTRAINT "hairstyle_catalog_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hairstyle_catalog" ADD CONSTRAINT "hairstyle_catalog_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CASCADE, not SET NULL: a deleted customer's saved looks are that customer's
-- record and nobody else's, so they go with them.
DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL: editing the catalogue must never rewrite a design the customer
-- already agreed to. The design carries its own hairstyleKey and renders without
-- this row.
DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "hairstyle_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hair_designs" ADD CONSTRAINT "hair_designs_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

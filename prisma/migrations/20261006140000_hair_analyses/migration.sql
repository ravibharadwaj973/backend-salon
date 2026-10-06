-- HAIR READINGS, AND THE ADVISOR THAT RANKS AGAINST THEM.
--
-- Guarded throughout: this database is maintained with `prisma db push` and has
-- no _prisma_migrations table, so every statement has to be safe to run twice.

DO $$
BEGIN
  CREATE TYPE "HairlineShape" AS ENUM ('STRAIGHT', 'ROUNDED', 'WIDOWS_PEAK', 'RECEDING', 'UNEVEN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "HairAnalysisSource" AS ENUM ('AI', 'MANUAL', 'CORRECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- A new value on an existing enum. ADD VALUE IF NOT EXISTS is itself idempotent,
-- so no DO block is needed — but it cannot run inside a transaction on older
-- Postgres, which is why it is a statement of its own here.
ALTER TYPE "HairGenerationKind" ADD VALUE IF NOT EXISTS 'CUSTOMER_PREVIEW';

CREATE TABLE IF NOT EXISTS "hair_analyses" (
  "id"                  TEXT NOT NULL,
  "tenantId"            TEXT NOT NULL,
  "branchId"            TEXT,
  "customerId"          TEXT,
  "source"              "HairAnalysisSource" NOT NULL DEFAULT 'AI',
  "faceShape"           "FaceShape",
  "faceShapeConfidence" DOUBLE PRECISION,
  "texture"             "HairTexture",
  "density"             "HairDensity",
  "length"              "HairLength",
  "volume"              INTEGER,
  "hairline"            "HairlineShape",
  "notes"               TEXT,
  "imageUrl"            TEXT,
  "imagePublicId"       TEXT,
  -- Consent as a time rather than a boolean: "when" is the question actually
  -- asked afterwards, and a NULL here on a row with a photograph is a bug.
  "consentAt"           TIMESTAMP(3),
  "createdById"         TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hair_analyses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "hair_analyses_tenantId_customerId_createdAt_idx"
  ON "hair_analyses" ("tenantId", "customerId", "createdAt");

DO $$
BEGIN
  ALTER TABLE "hair_analyses"
    ADD CONSTRAINT "hair_analyses_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "hair_analyses"
    ADD CONSTRAINT "hair_analyses_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CASCADE from the customer, unlike most links in this schema.
--
-- A deleted customer must not leave a photograph of their face behind. Elsewhere
-- SET NULL is the kinder default because it preserves history; here history is
-- the thing being asked to go away.
DO $$
BEGIN
  ALTER TABLE "hair_analyses"
    ADD CONSTRAINT "hair_analyses_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The link from a generated preview back to the reading it was drawn from.
ALTER TABLE "hair_generations" ADD COLUMN IF NOT EXISTS "analysisId" TEXT;

CREATE INDEX IF NOT EXISTS "hair_generations_analysisId_idx" ON "hair_generations" ("analysisId");

-- CASCADE, deliberately: deleting a reading is a customer withdrawing consent,
-- and a customer preview IS that customer's face. The hosted files are destroyed
-- by the service before this cascade removes the record of which files they were.
DO $$
BEGIN
  ALTER TABLE "hair_generations"
    ADD CONSTRAINT "hair_generations_analysisId_fkey"
    FOREIGN KEY ("analysisId") REFERENCES "hair_analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

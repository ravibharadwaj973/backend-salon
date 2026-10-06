-- THE TEN DIMENSIONS A LOOK IS MADE OF, AND THE ANGLES IT IS PHOTOGRAPHED FROM.
--
-- Every statement is guarded. This database is managed with `prisma db push`
-- rather than a migration history, so there is no `_prisma_migrations` table to
-- tell anybody whether this has run — which means it has to be safe to run
-- twice, on a database that already has some of these objects and not others.
-- "IF NOT EXISTS" everywhere, and the DO blocks for the two things Postgres has
-- no IF NOT EXISTS for: CREATE TYPE and ADD CONSTRAINT.

-- ───────────────────────────────────────────────────── new enumerations ─────
-- Three, and only three. The look dimensions themselves (cut family, finish,
-- technique, placement, base colour) are text columns validated against
-- `look-dimensions.ts`, because they are market taxonomies that grow — U-cut,
-- foilyage — and each addition would otherwise be a migration against a live
-- database. These three are closed by anatomy rather than by fashion.

DO $$ BEGIN
  CREATE TYPE "HairPose" AS ENUM ('FRONT', 'THREE_QUARTER', 'SIDE', 'BACK', 'TOP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HairCondition" AS ENUM ('HEALTHY', 'NORMAL', 'POROUS', 'DAMAGED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "Forehead" AS ENUM ('LOW', 'AVERAGE', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ──────────────────────────────── the seven axes, on a catalogue entry ──────
-- All nullable with no default. Null means "not recorded", which is a different
-- fact from any particular value and is read as such everywhere: an entry that
-- has not been described on an axis is not thereby excluded from that axis's
-- filter. The arrays default to empty, which the API already reads as "all of
-- them" rather than "none" — a salon that has not answered has not refused.

ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "cutFamily"      TEXT;
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "fringe"         TEXT;
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "finish"         TEXT;
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "baseColorKey"   TEXT;
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "colorTechnique" TEXT;
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "colorPlacement" TEXT;
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "desiredLooks"   TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "occasions"      TEXT[] NOT NULL DEFAULT '{}';

-- ─────────────────────────── the two readings nothing recorded before ───────
-- `previouslyColored` is nullable rather than defaulting false on purpose:
-- "nobody asked" and "she said no" are different facts, and treating the first
-- as the second is how a lift goes wrong in the bowl.

ALTER TABLE "hair_analyses" ADD COLUMN IF NOT EXISTS "condition"         "HairCondition";
ALTER TABLE "hair_analyses" ADD COLUMN IF NOT EXISTS "colorLevel"        INTEGER;
ALTER TABLE "hair_analyses" ADD COLUMN IF NOT EXISTS "previouslyColored" BOOLEAN;
ALTER TABLE "hair_analyses" ADD COLUMN IF NOT EXISTS "forehead"          "Forehead";

-- ──────────────────────────────────── one row per angle of one style ────────
-- The back of the head is where most of the work is and the front is all anybody
-- photographs. A row per angle rather than four more columns on the catalogue,
-- because each angle needs its own mask (the hair is in different pixels), its
-- own consent (a different photograph of a different person), and its own
-- provenance — sixteen mostly-null columns otherwise, and twenty for a fifth
-- angle.
--
-- previewUrl and maskUrl stay on hairstyle_catalog as the FRONT view, which is
-- what every existing reader already means by "the picture". That is what makes
-- this additive: a style with one photograph remains complete and usable.

CREATE TABLE IF NOT EXISTS "hairstyle_photos" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "catalogId"     TEXT NOT NULL,
  "pose"          "HairPose" NOT NULL,
  "imageUrl"      TEXT NOT NULL,
  "imagePublicId" TEXT,
  "maskUrl"       TEXT,
  "isUploaded"    BOOLEAN NOT NULL DEFAULT false,
  "consentAt"     TIMESTAMP(3),
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hairstyle_photos_pkey" PRIMARY KEY ("id")
);

-- ONE PICTURE PER ANGLE, REPLACED RATHER THAN ACCUMULATED.
--
-- The failure this prevents is a style with eleven front views and no back view.
-- The asset studio is a checklist of angles, not a gallery, and this constraint
-- is what makes it one.
CREATE UNIQUE INDEX IF NOT EXISTS "hairstyle_photos_catalogId_pose_key"
  ON "hairstyle_photos" ("catalogId", "pose");

CREATE INDEX IF NOT EXISTS "hairstyle_photos_tenantId_catalogId_idx"
  ON "hairstyle_photos" ("tenantId", "catalogId");

-- CASCADE on both. A photograph of an angle of a style that no longer exists is
-- an orphan holding a customer's face, which is precisely the row that survives
-- a deletion request. The service destroys the Cloudinary asset as well, which
-- is why imagePublicId is stored.
DO $$ BEGIN
  ALTER TABLE "hairstyle_photos"
    ADD CONSTRAINT "hairstyle_photos_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "hairstyle_photos"
    ADD CONSTRAINT "hairstyle_photos_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "hairstyle_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ──────────────────────────────────────── carry the existing picture over ───
-- Every style that already has a photograph gets it as its FRONT pose, so the
-- new table is not empty on day one and the pose checklist opens showing the
-- truth rather than showing every style as unphotographed.
--
-- ON CONFLICT DO NOTHING makes it idempotent, and the WHERE clause means a
-- second run after somebody has replaced a front view will not overwrite it.
INSERT INTO "hairstyle_photos" ("id", "tenantId", "catalogId", "pose", "imageUrl", "maskUrl", "isUploaded", "createdAt", "updatedAt")
SELECT
  'seed_' || "id",
  "tenantId",
  "id",
  'FRONT',
  "previewUrl",
  "maskUrl",
  "photoIsUploaded",
  "createdAt",
  CURRENT_TIMESTAMP
FROM "hairstyle_catalog"
WHERE "previewUrl" IS NOT NULL
ON CONFLICT ("catalogId", "pose") DO NOTHING;

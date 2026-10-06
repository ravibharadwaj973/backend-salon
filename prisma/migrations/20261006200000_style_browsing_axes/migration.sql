-- The browsing axes, and where a style's photograph came from.
--
-- Guarded like every migration here: this database is maintained with
-- `prisma db push` and has no _prisma_migrations table, so each statement must be
-- safe to run twice.

DO $$
BEGIN
  CREATE TYPE "HairColorFamily" AS ENUM ('BLACK', 'BROWN', 'BLONDE', 'RED', 'GREY', 'FASHION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "SkinTone" AS ENUM ('FAIR', 'LIGHT', 'MEDIUM', 'OLIVE', 'DEEP');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "colorFamily" "HairColorFamily";
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "skinTone" "SkinTone";

-- Defaults to false, which is right for every existing row: everything in the
-- catalogue today was either drawn by the image model or has no picture at all.
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "photoIsUploaded" BOOLEAN NOT NULL DEFAULT false;

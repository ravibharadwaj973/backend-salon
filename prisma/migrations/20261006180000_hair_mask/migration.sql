-- The hair, cut out of the reference photograph.
--
-- One nullable column, guarded like every migration here: this database is
-- maintained with `prisma db push` and has no _prisma_migrations table, so every
-- statement must be safe to run twice.
ALTER TABLE "hairstyle_catalog" ADD COLUMN IF NOT EXISTS "maskUrl" TEXT;

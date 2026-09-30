-- LETTING SOMEBODY ASK TO BE LET BACK IN, AND RECORDING WHO LET THEM.
--
-- Written guarded throughout. This database is managed with `prisma db push`
-- rather than a migration history, so a statement here may meet a column that
-- already exists — and a migration that fails halfway leaves the schema in a
-- state nobody planned. Every statement below can be run twice.

-- ---------------------------------------------------------------------------
-- An audit row can now name an actor who works for us rather than for the salon.
-- Without these two columns a platform admin resetting a locked-out owner wrote
-- a row attributed to nobody: the action most in need of a name had none.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "platformUserId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actorName" TEXT;

-- ---------------------------------------------------------------------------
-- The request queue.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE "PasswordResetStatus" AS ENUM ('PENDING', 'RESOLVED', 'REJECTED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "password_reset_requests" (
  "id"                       TEXT NOT NULL,
  "tenantId"                 TEXT NOT NULL,
  "userId"                   TEXT NOT NULL,
  "email"                    TEXT NOT NULL,
  "role"                     "UserRole" NOT NULL,
  "status"                   "PasswordResetStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestedIp"              TEXT,
  "resolvedAt"               TIMESTAMP(3),
  "resolvedById"             TEXT,
  "resolvedByPlatformUserId" TEXT,
  "resolvedByName"           TEXT,
  "reason"                   TEXT,
  CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "password_reset_requests"
    ADD CONSTRAINT "password_reset_requests_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE INDEX IF NOT EXISTS "password_reset_requests_userId_status_idx"
  ON "password_reset_requests" ("userId", "status");
CREATE INDEX IF NOT EXISTS "password_reset_requests_tenantId_status_idx"
  ON "password_reset_requests" ("tenantId", "status");
CREATE INDEX IF NOT EXISTS "password_reset_requests_status_requestedAt_idx"
  ON "password_reset_requests" ("status", "requestedAt");

-- ONE OPEN ASK PER PERSON, enforced by the database rather than by remembering.
--
-- Partial, on PENDING alone: the same person may of course be reset again next
-- year, so a plain unique on (userId, status) would forbid their second reset
-- ever. Prisma cannot express a partial index, which is why it is here and the
-- schema carries the ordinary index that serves the same lookups.
--
-- The guard matters: a locked-out owner pressing the button eleven times should
-- produce one row in the console, not eleven.
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_requests_one_open_per_user"
  ON "password_reset_requests" ("userId")
  WHERE "status" = 'PENDING';

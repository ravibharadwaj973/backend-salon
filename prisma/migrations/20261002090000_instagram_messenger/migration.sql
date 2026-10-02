-- INSTAGRAM AND MESSENGER DIRECT MESSAGES.
--
-- The same inbox, the same assistant and the same conversation model the salon
-- already has for WhatsApp. A salon loses real bookings to Instagram DMs nobody
-- opened; this is the channel they actually get asked "kitne ka hai" on.
--
-- Guarded throughout: this database is managed with `prisma db push` and has no
-- _prisma_migrations table, so every statement has to survive a second run.

-- Two new channels and two new meters.
ALTER TYPE "Channel"  ADD VALUE IF NOT EXISTS 'INSTAGRAM';
ALTER TYPE "Channel"  ADD VALUE IF NOT EXISTS 'MESSENGER';
ALTER TYPE "MeterKey" ADD VALUE IF NOT EXISTS 'IG_DM';
ALTER TYPE "MeterKey" ADD VALUE IF NOT EXISTS 'FB_DM';

-- The salon's own connected accounts, beside its WhatsApp number.
ALTER TABLE "tenant_messaging_config"
  ADD COLUMN IF NOT EXISTS "igStatus"         "MessagingSetupStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
  ADD COLUMN IF NOT EXISTS "igAccountId"      TEXT,
  ADD COLUMN IF NOT EXISTS "igUsername"       TEXT,
  ADD COLUMN IF NOT EXISTS "igAccessToken"    TEXT,
  ADD COLUMN IF NOT EXISTS "igTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "igConnectedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fbStatus"         "MessagingSetupStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
  ADD COLUMN IF NOT EXISTS "fbPageId"         TEXT,
  ADD COLUMN IF NOT EXISTS "fbPageName"       TEXT,
  ADD COLUMN IF NOT EXISTS "fbAccessToken"    TEXT,
  ADD COLUMN IF NOT EXISTS "fbTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fbConnectedAt"    TIMESTAMP(3);

-- UNIQUE, AND LOAD-BEARING.
--
-- An inbound DM webhook carries the Instagram account id or the Page id and
-- nothing else that identifies the business. That id is the only route from the
-- event to the salon it belongs to. Without these constraints two salons could
-- end up holding the same id and a customer's message would be delivered to the
-- wrong business — the same failure the waPhoneNumberId constraint exists to
-- prevent, and the reason it is written the same way here.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_messaging_config_igAccountId_key"
  ON "tenant_messaging_config" ("igAccountId");

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_messaging_config_fbPageId_key"
  ON "tenant_messaging_config" ("fbPageId");

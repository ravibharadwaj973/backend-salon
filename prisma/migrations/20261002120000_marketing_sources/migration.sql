-- WHAT THE SALON SPENT, AND WHAT CAME BACK.
--
-- Meta can tell a salon how many people clicked. It cannot tell them that
-- twelve of those people sat in a chair and spent ₹48,000, because Meta does
-- not have the invoices. Parlon does. This is the table that joins the two.
--
-- `spend` is typed in by a human on purpose. It could be read from the ads API
-- once that is connected, and one day it will be — but the salon pressing
-- "Boost" on their phone for ₹500 is the real behaviour today, and waiting on
-- an API approval to tell them whether that ₹500 came back leaves the only
-- question they actually have unanswered for a quarter.
--
-- Guarded: this database is managed with `prisma db push` and has no
-- _prisma_migrations table, so every statement must survive a second run.

DO $$ BEGIN
  CREATE TYPE "MarketingKind" AS ENUM ('ORGANIC_POST', 'BOOSTED_POST', 'AD', 'QR', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "marketing_sources" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "branchId"       TEXT,
  "name"           TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "channel"        "Channel" NOT NULL DEFAULT 'INSTAGRAM',
  "kind"           "MarketingKind" NOT NULL DEFAULT 'BOOSTED_POST',
  "spend"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  "dailyBudget"    DECIMAL(12,2),
  "startedOn"      DATE,
  "endedOn"        DATE,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "notes"          TEXT,
  "metaCampaignId" TEXT,
  "metaAdId"       TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_sources_pkey" PRIMARY KEY ("id")
);

-- Per salon, not globally: two salons may both call something "diwali".
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_sources_tenantId_code_key"
  ON "marketing_sources" ("tenantId", "code");
CREATE INDEX IF NOT EXISTS "marketing_sources_tenantId_isActive_idx"
  ON "marketing_sources" ("tenantId", "isActive");

-- A TAP, AND NOTHING ELSE.
--
-- No IP address, no user agent, no cookie. The only question this answers is
-- "how many people tapped this, and when"; every other column would be personal
-- data about somebody who has not yet chosen to give the salon anything.
CREATE TABLE IF NOT EXISTS "marketing_clicks" (
  "id"       TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketing_clicks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "marketing_clicks_tenantId_sourceId_at_idx"
  ON "marketing_clicks" ("tenantId", "sourceId", "at");

DO $$ BEGIN
  ALTER TABLE "marketing_sources" ADD CONSTRAINT "marketing_sources_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "marketing_sources" ADD CONSTRAINT "marketing_sources_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "marketing_clicks" ADD CONSTRAINT "marketing_clicks_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "marketing_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- WHICH POST OR AD SENT THIS PERSON HERE.
--
-- A click-to-DM ad opens the conversation carrying a referral, and Meta hands
-- it over exactly once — on the very first message. Stored on the thread at
-- that moment or lost for good. It is the only way a DM can ever be attributed:
-- everything else in the loop has a link to carry a code, a direct message has
-- this and nothing.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "sourceRef"  TEXT,
  ADD COLUMN IF NOT EXISTS "sourceAdId" TEXT;

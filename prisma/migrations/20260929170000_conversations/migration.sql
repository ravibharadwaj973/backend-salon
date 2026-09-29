-- ONE THREAD PER CUSTOMER, SHARED BY THE ASSISTANT AND THE SALON.
--
-- Written to be safe to run on a database managed with `prisma db push`, which
-- is how this one is managed: every statement is guarded, so applying it twice
-- changes nothing and applying it after a push finds the work already done.

DO $$ BEGIN
  CREATE TYPE "ConversationMode" AS ENUM ('AI', 'HUMAN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "conversations" (
  "id"                    TEXT NOT NULL,
  "tenantId"              TEXT NOT NULL,
  "customerId"            TEXT,
  "branchId"              TEXT,
  "channel"               "Channel" NOT NULL DEFAULT 'WHATSAPP',
  "customerAddress"       TEXT NOT NULL,
  "mode"                  "ConversationMode" NOT NULL DEFAULT 'HUMAN',
  "status"                "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "assignedToId"          TEXT,
  "lastCustomerMessageAt" TIMESTAMP(3),
  "lastMessageAt"         TIMESTAMP(3),
  "needsAttentionAt"      TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- One thread per number per channel. A customer who writes, is answered, and
-- writes again next week belongs in the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_tenantId_channel_customerAddress_key"
  ON "conversations" ("tenantId", "channel", "customerAddress");
CREATE INDEX IF NOT EXISTS "conversations_tenantId_lastMessageAt_idx"
  ON "conversations" ("tenantId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "conversations_tenantId_status_needsAttentionAt_idx"
  ON "conversations" ("tenantId", "status", "needsAttentionAt");

ALTER TABLE "inbound_messages" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;
ALTER TABLE "message_logs"     ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

CREATE INDEX IF NOT EXISTS "inbound_messages_conversationId_receivedAt_idx"
  ON "inbound_messages" ("conversationId", "receivedAt");
CREATE INDEX IF NOT EXISTS "message_logs_conversationId_queuedAt_idx"
  ON "message_logs" ("conversationId", "queuedAt");

-- Foreign keys added only when absent: ADD CONSTRAINT has no IF NOT EXISTS.
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Who typed it, when a person did. The only thing separating a staff reply
-- from the assistant's: on the wire they are identical.
ALTER TABLE "message_logs" ADD COLUMN IF NOT EXISTS "sentByUserId" TEXT;

DO $$ BEGIN
  ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_sentByUserId_fkey"
    FOREIGN KEY ("sentByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

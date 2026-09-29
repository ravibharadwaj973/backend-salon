-- WHAT THE ASSISTANT DID, AS OPPOSED TO WHAT IT SAID.
--
-- Guarded like the conversations migration, for the same reason: this database
-- is managed with `prisma db push`, so every statement has to survive being
-- applied to a schema that already has the work.

DO $$ BEGIN
  CREATE TYPE "ConversationEventKind" AS ENUM (
    'AVAILABILITY_CHECKED',
    'SLOT_OFFERED',
    'APPOINTMENT_BOOKED',
    'BOOKING_FAILED',
    'BRANCH_ASKED',
    'BRANCH_SWITCHED',
    'HANDED_OVER',
    'TAKEN_OVER',
    'ASSISTANT_RESUMED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "conversation_events" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "kind"           "ConversationEventKind" NOT NULL,
  "summary"        TEXT NOT NULL,
  "detail"         JSONB,
  "at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "conversation_events_conversationId_at_idx"
  ON "conversation_events" ("conversationId", "at");

DO $$ BEGIN
  ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

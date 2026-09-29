-- WHAT THE CUSTOMER ACTUALLY SAID.
--
-- Until now, nothing. The webhook received an inbound WhatsApp message, read
-- the text, compared it against STOP, and dropped it. A customer writing "can
-- I come at 4 tomorrow?" reached this server, was parsed well enough to check
-- for one word, and was then discarded — with no record that it ever happened.
--
-- MessageLog could not hold these. It is outbound by construction (toAddress,
-- renderedBody, providerMessageId, delivery timestamps) with no direction
-- column. Adding one would change the meaning of every existing query, which
-- is how a reporting layer starts lying.
CREATE TABLE "inbound_messages" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  -- Null for a number nobody on the book owns. A stranger messaging the salon
  -- is still worth showing, and is how some customers arrive.
  "customerId"        TEXT,
  "branchId"          TEXT,
  "channel"           "Channel" NOT NULL DEFAULT 'WHATSAPP',
  "fromAddress"       TEXT NOT NULL,
  "body"              TEXT NOT NULL,
  "messageType"       TEXT NOT NULL DEFAULT 'text',
  "providerMessageId" TEXT,
  "handledAt"         TIMESTAMP(3),
  "handledBy"         TEXT,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- THE CONSTRAINT THAT MATTERS.
--
-- Meta retries a webhook until it gets a 200 and does not care that it already
-- had one, so the same customer message arrives two or three times. That is
-- harmless while nothing acts on it. The moment anything replies
-- automatically, every retry is another message to a real person — and this
-- index is what stops that, rather than anybody remembering to.
CREATE UNIQUE INDEX "inbound_messages_providerMessageId_key"
  ON "inbound_messages"("providerMessageId");

CREATE INDEX "inbound_messages_tenantId_receivedAt_idx"
  ON "inbound_messages"("tenantId", "receivedAt");
CREATE INDEX "inbound_messages_tenantId_customerId_receivedAt_idx"
  ON "inbound_messages"("tenantId", "customerId", "receivedAt");
-- The unhandled queue: the only list anybody will actually open.
CREATE INDEX "inbound_messages_tenantId_handledAt_idx"
  ON "inbound_messages"("tenantId", "handledAt");

ALTER TABLE "inbound_messages"
  ADD CONSTRAINT "inbound_messages_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting a customer record must not erase the fact
-- that somebody wrote in. The message still happened.
ALTER TABLE "inbound_messages"
  ADD CONSTRAINT "inbound_messages_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- THE SERVICE WINDOW, AS A FACT THE SEND PATH CAN CHECK CHEAPLY.
--
-- WhatsApp permits a free-form reply only within 24 hours of the customer's
-- last message. Nothing tracked that, so a reply sent outside it returned
-- 131047 and the salon experienced their answer as silently never arriving.
-- Denormalised onto the customer rather than joined from inbound_messages,
-- because it is read on every outbound WhatsApp send.
ALTER TABLE "customers" ADD COLUMN "lastInboundAt" TIMESTAMP(3);

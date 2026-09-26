-- What a link was for, so a message with three buttons can say which was tapped.
CREATE TYPE "LinkDestination" AS ENUM ('GALLERY', 'SERVICE', 'OFFER', 'BRANCH', 'BOOKING', 'INVOICE', 'FEEDBACK', 'OTHER');

ALTER TABLE "TrackedLink" ADD COLUMN "destination" "LinkDestination" NOT NULL DEFAULT 'OTHER',
-- When the link stops being THIS customer's link. Not when it stops working:
-- see the column comment in schema.prisma.
ADD COLUMN "identifiesUntil" TIMESTAMP(3);

-- One tab's worth of events tied together, and what each one was about.
ALTER TABLE "site_visits" ADD COLUMN "sessionId" TEXT,
ADD COLUMN "metadata" JSONB;

CREATE INDEX "site_visits_tenantId_customerId_at_idx" ON "site_visits"("tenantId", "customerId", "at");
CREATE INDEX "site_visits_sessionId_idx" ON "site_visits"("sessionId");

-- A rollup of the events, so a segment can ask "who has been looking at hair
-- spa?" without scanning a log that grows forever.
CREATE TABLE "customer_interests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 1,
    "firstViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_interests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_interests_customerId_kind_refId_key" ON "customer_interests"("customerId", "kind", "refId");
CREATE INDEX "customer_interests_tenantId_kind_refId_lastViewedAt_idx" ON "customer_interests"("tenantId", "kind", "refId", "lastViewedAt");

ALTER TABLE "customer_interests" ADD CONSTRAINT "customer_interests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

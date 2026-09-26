-- The salon's own website, used to build {{website_link}} / {{gallery_link}}
-- and as the allow-list for the arrival token on tracked links.
ALTER TABLE "tenants" ADD COLUMN "websiteUrl" TEXT;

-- The step between "clicked" and "booked" that nothing measured.
ALTER TABLE "message_logs" ADD COLUMN "siteVisitedAt" TIMESTAMP(3),
ADD COLUMN "siteViews" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trackedLinkId" TEXT,
    "messageLogId" TEXT,
    "campaignId" TEXT,
    "customerId" TEXT,
    "event" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "site_visits_tenantId_at_idx" ON "site_visits"("tenantId", "at");
CREATE INDEX "site_visits_messageLogId_idx" ON "site_visits"("messageLogId");
CREATE INDEX "site_visits_campaignId_at_idx" ON "site_visits"("campaignId", "at");

ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_messageLogId_fkey" FOREIGN KEY ("messageLogId") REFERENCES "message_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

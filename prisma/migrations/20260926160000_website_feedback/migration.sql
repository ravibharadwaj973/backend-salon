-- A rating left after a visit and one typed into a public form are not the
-- same evidence. Kept apart so the salon's own average cannot be moved by a
-- stranger. See the enum's comment in schema.prisma.
CREATE TYPE "FeedbackSource" AS ENUM ('VISIT', 'WEBSITE');

ALTER TABLE "feedback" ADD COLUMN "source" "FeedbackSource" NOT NULL DEFAULT 'VISIT',
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvedById" TEXT,
ADD COLUMN "authorName" TEXT,
ADD COLUMN "authorPhone" TEXT;

CREATE INDEX "feedback_tenantId_source_createdAt_idx" ON "feedback"("tenantId", "source", "createdAt");
CREATE INDEX "feedback_tenantId_isPublic_createdAt_idx" ON "feedback"("tenantId", "isPublic", "createdAt");

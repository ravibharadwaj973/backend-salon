-- WHAT THE CUSTOMER THOUGHT OF EACH SERVICE, ONE ROW EACH.
--
-- A visit is rarely one thing. Somebody has a cut and a facial, loves the cut,
-- is unimpressed by the facial, and leaves 4 overall — a number that is not
-- true about either service. The single `serviceRating` column could not hold
-- that, so "which of my services is letting me down?" had no answer in the
-- data, which is the question the whole feedback feature is bought for.
--
-- A ROW PER SERVICE, NOT A COLUMN PER SERVICE. Salons do not share a service
-- list: one sells Bridal Makeup and Pedicure, the next Beard Styling and Hair
-- Spa. Columns would mean a migration every time a salon added a service.
--
-- No backfill. Existing feedback has one overall service rating and no way to
-- know how it split, and inventing a split would put numbers in a report that
-- nobody ever typed. Old rows keep `serviceRating`; new ones get both, with
-- the old column filled from the mean so every existing report keeps working.

CREATE TABLE "feedback_service_ratings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_service_ratings_pkey" PRIMARY KEY ("id")
);

-- One rating per service per visit. A form that posts twice must not count the
-- haircut twice, and a re-submission must correct rather than accumulate.
CREATE UNIQUE INDEX "feedback_service_ratings_feedbackId_serviceId_key"
  ON "feedback_service_ratings"("feedbackId", "serviceId");

-- The service-performance table: this tenant's ratings, grouped by service.
CREATE INDEX "feedback_service_ratings_tenantId_serviceId_idx"
  ON "feedback_service_ratings"("tenantId", "serviceId");

ALTER TABLE "feedback_service_ratings"
  ADD CONSTRAINT "feedback_service_ratings_feedbackId_fkey"
  FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT rather than CASCADE, deliberately. A service the salon retires still
-- has to answer for the months it was sold; deleting its ratings along with it
-- would quietly raise the salon's averages, which is precisely what this table
-- exists to make impossible.
ALTER TABLE "feedback_service_ratings"
  ADD CONSTRAINT "feedback_service_ratings_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

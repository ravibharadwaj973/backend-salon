-- WHAT THE WORDS SAID, ALONGSIDE WHAT THE CUSTOMER SCORED.
--
-- The ratings already on `feedback` are the customer's own taps. These columns
-- are a reading of their comment, and they are deliberately separate: a model
-- that "corrects" four stars to 3.6 has destroyed the only hard number in the
-- row. Nothing in the analysis path writes to `rating`.
--
-- All nullable, and no backfill. Existing feedback stays unanalysed until
-- somebody asks for it; `analyzedAt` is what distinguishes "not looked at yet"
-- from "looked at and the model had nothing", so an empty sentiment is never
-- ambiguous.

CREATE TYPE "FeedbackSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- Fixed rather than free text, because every feedback report groups by it. A
-- free-text topic column cannot answer "is waiting time getting worse?" — the
-- same complaint arrives spelled six ways and each one counts as its own
-- problem. Adding a value here is a migration, which is the right amount of
-- friction for a dimension the whole dashboard depends on.
CREATE TYPE "FeedbackTopicKind" AS ENUM (
  'SERVICE',
  'STAFF',
  'CLEANLINESS',
  'WAITING_TIME',
  'PRICE',
  'VALUE',
  'AMBIENCE',
  'BOOKING',
  'PRODUCT_QUALITY',
  'RESULT',
  'CUSTOMER_SERVICE'
);

ALTER TABLE "feedback"
  ADD COLUMN "sentiment" "FeedbackSentiment",
  ADD COLUMN "sentimentScore" DOUBLE PRECISION,
  ADD COLUMN "analyzedAt" TIMESTAMP(3),
  ADD COLUMN "reviewDraft" TEXT;

CREATE TABLE "feedback_topics" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "topic" "FeedbackTopicKind" NOT NULL,
  "sentiment" "FeedbackSentiment" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feedback_topics_pkey" PRIMARY KEY ("id")
);

-- One reading per topic per feedback. A model that returns WAITING_TIME twice,
-- once positive and once negative, has not given a second data point — and a
-- re-run of the analysis must not double every count.
CREATE UNIQUE INDEX "feedback_topics_feedbackId_topic_key" ON "feedback_topics"("feedbackId", "topic");

-- The dashboard's only question: of this tenant's feedback, how much of it
-- mentioned this topic, and how did it go.
CREATE INDEX "feedback_topics_tenantId_topic_sentiment_idx" ON "feedback_topics"("tenantId", "topic", "sentiment");

-- Cascade: a deleted piece of feedback has no topics. Keeping orphans would
-- leave them counted in every report with nothing to click through to.
ALTER TABLE "feedback_topics"
  ADD CONSTRAINT "feedback_topics_feedbackId_fkey"
  FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- REPLIES TO CUSTOMERS GET THEIR OWN METER.
--
-- Guarded throughout: this database is managed with `prisma db push` rather than
-- a migration history, so every statement here must survive being run twice.

-- ---------------------------------------------------------------------------
-- The meter itself.
--
-- A free-form WhatsApp reply inside the 24-hour customer service window was
-- being charged to WA_UTILITY -- the allowance that pays for appointment
-- confirmations and reminders. Two things were wrong with that. Meta did not
-- charge for those messages at all between November 2024 and 1 October 2026, so
-- the salon's paid allowance was being spent on messages that cost nothing. And
-- when the allowance ran out, the account was blocked from sending -- which
-- stopped the assistant answering customers AND stopped the reminders, because
-- one exhausted meter pauses everything.
--
-- ADD VALUE IF NOT EXISTS needs no DO block and is idempotent on its own.
-- It cannot run inside a transaction on older Postgres, which is why it is the
-- first statement and stands alone.
-- ---------------------------------------------------------------------------
ALTER TYPE "MeterKey" ADD VALUE IF NOT EXISTS 'WA_SERVICE';

-- ---------------------------------------------------------------------------
-- The allowance on each plan.
--
-- 1000 by default, and deliberately generous: this number is what a salon is
-- told to expect, not a wall. Exceeding it does not stop a reply going out --
-- see quota.service.ts -- it just shows up as an overage to be billed.
-- ---------------------------------------------------------------------------
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "waServiceQuota" INTEGER NOT NULL DEFAULT 1000;

-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT DONE HERE: no backfill.
--
-- Every service message sent so far is counted in this month's WA_UTILITY row,
-- and it is tempting to move them. It is not done, for two reasons.
--
-- `message_logs` records the meter it charged at the time, so the history could
-- be recounted -- but a counter is not a log. Rewriting `message_usage.used`
-- would change a number a salon has already been shown, and may already have
-- been invoiced against. A figure somebody was told last month should not
-- silently become a different figure.
--
-- The split takes effect from the next message. Utility counts before this
-- migration read high by however many replies the assistant sent; that is
-- visible in message_logs for anyone who needs to reconcile a specific month.
-- ---------------------------------------------------------------------------

-- THE REVIEW SUGGESTIONS, STORED INSTEAD OF REWRITTEN EVERY TIME.
--
-- They were generated inside the request that asked for them, so the customer
-- waited several seconds on a thank-you screen while a model composed five
-- reviews — and the screen gave up waiting at three. The Google button was
-- already on screen by then, people tapped it, and they arrived at an empty
-- Google box with nothing in their clipboard. The whole feature almost never
-- landed.
--
-- A refresh also produced a different five, so a sentence somebody had half
-- chosen disappeared when the page reloaded.
--
-- Now written once, in the background, the moment the rating is saved.
--
-- Guarded: this database is managed with `prisma db push` and has no
-- _prisma_migrations table, so it must survive being run twice. No backfill —
-- an old feedback row simply has none, and asking for its suggestions generates
-- and stores them on the spot, exactly as before.

ALTER TABLE "feedback"
  ADD COLUMN IF NOT EXISTS "reviewDrafts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

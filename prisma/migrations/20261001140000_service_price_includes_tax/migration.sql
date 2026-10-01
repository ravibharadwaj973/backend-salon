-- WHETHER A SERVICE'S PRICE ALREADY HAS GST IN IT, PER SERVICE.
--
-- Until now this was one switch for the whole salon. A salon whose treatment
-- prices are quoted tax-inclusive but whose packages or premium services are
-- quoted plus-tax had no way to say so, and every bill got one of the two
-- answers wrong.
--
-- NULLABLE, WITH NO BACKFILL AND NO DEFAULT. Null means "use the salon's
-- setting", which is exactly what every service does today, so nothing about any
-- existing bill changes. Giving the column a default of true or false would have
-- answered the question for thousands of services that never asked it, and the
-- answer would have been wrong for whichever salons price the other way — and it
-- would have been wrong silently, in the direction of a few percent on every
-- line. This column is for the exceptions.
--
-- Guarded: this database is managed with `prisma db push` and has no
-- _prisma_migrations table, so it must survive being run twice.

ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "priceIncludesTax" BOOLEAN;

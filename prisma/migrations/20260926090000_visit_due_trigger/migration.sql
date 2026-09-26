-- A journey trigger that fires on the customer's own visit cycle rather than
-- on one fixed gap for the whole book. See src/modules/customers/visit-due.ts.
ALTER TYPE "JourneyTrigger" ADD VALUE 'VISIT_DUE';

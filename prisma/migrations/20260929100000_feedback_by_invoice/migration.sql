-- FEEDBACK CAN HANG OFF A BILL, NOT ONLY AN APPOINTMENT.
--
-- It used to hang off an appointment alone, which quietly excluded every
-- walk-in. A customer billed straight through the counter has no appointment,
-- so there was no id for the feedback page to key to: the message was refused
-- rather than sent to a dead link, and that customer could never be asked for
-- feedback — and therefore never asked for a Google review.
--
-- In a salon where walk-ins are most of the trade, that was most customers.
-- The review pipeline the product is sold on was only ever running for the
-- half of the business that books ahead.
--
-- Every paying customer has an invoice, so the invoice is the other key. One
-- of the two is set, never both; the page accepts either id in the same URL.

ALTER TABLE "feedback" ADD COLUMN "invoiceId" TEXT;

-- One piece of feedback per bill, matching the rule already on appointments.
-- A customer who opens the link twice gets told they have already told us,
-- rather than leaving two ratings that both count.
CREATE UNIQUE INDEX "feedback_invoiceId_key" ON "feedback"("invoiceId");

-- SetNull, like the appointment side: a deleted bill must not take the
-- customer's rating with it. The rating happened; the paperwork is separate,
-- and an average that changes when old bills are tidied up is not an average
-- anybody can act on.
ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

import { windowEnd, windowStart } from './attribution';

/**
 * DID THE AUTOMATION ACTUALLY BRING ANYBODY BACK?
 *
 * An automation page could say how many messages went out, how many were read,
 * and what they cost. It could not say whether a single customer returned
 * because of one — which is the only question a salon owner is really asking,
 * and the one a campaign has been able to answer all along.
 *
 * ── The unit is the RUN, not the message ─────────────────────────────────
 *
 * This is the one place an automation must not copy the campaign code. A
 * campaign sends each customer one message, so per-message and per-customer
 * are the same thing. An automation sends a sequence: booking confirmation,
 * reminder, thank-you, review request. Attribute per message and one visit is
 * counted four times, and the automation appears to have quadrupled the
 * salon's takings.
 *
 * So a journey RUN is one row here — one customer, entering once. The window
 * opens when the run's first message actually went out, and closes the
 * configured number of days after its LAST one, because a sequence spread over
 * a fortnight should not be judged on a window that shut while it was still
 * sending.
 *
 * ── What it does not claim ───────────────────────────────────────────────
 *
 * Nothing here is proof of cause. A customer who was coming anyway still books
 * inside the window and still counts, which is why the number should be read
 * next to the quiet group rather than on its own — see computeLift. The
 * honest description of this figure is "came back after we messaged them", and
 * the page says exactly that rather than "bookings driven".
 */

export interface AttributableMessage {
  /** Null for a message not tied to a run — those are ignored. */
  runId: string | null;
  customerId: string | null;
  status: string;
  queuedAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  clickedAt: Date | null;
  repliedAt: Date | null;
}

/** A booking, by when the customer DECIDED — not when the appointment falls. */
export interface BookingEvent {
  customerId: string;
  decidedAt: Date;
}

export interface SaleEvent {
  customerId: string;
  at: Date;
  amount: number;
}

export interface JourneyOutcomes {
  /** Runs with at least one message that actually left the building. */
  reached: number;
  /** Of those, how many read, clicked or replied to anything in the sequence. */
  engaged: number;
  booked: number;
  visited: number;
  revenue: number;
}

export function attributeJourney(input: {
  messages: AttributableMessage[];
  bookings: BookingEvent[];
  sales: SaleEvent[];
  windowDays: number;
}): JourneyOutcomes {
  /** One entry per run: the customer, the window, and whether they engaged. */
  const runs = new Map<
    string,
    { customerId: string; from: Date; last: Date; engaged: boolean }
  >();

  for (const message of input.messages) {
    if (!message.runId || !message.customerId) continue;
    // Nothing left the building, so the customer's behaviour afterwards is not
    // evidence about this automation either way.
    if (message.status === 'SKIPPED' || message.status === 'FAILED') continue;

    const start = windowStart(message);
    if (!start) continue;

    const engaged = Boolean(message.readAt ?? message.clickedAt ?? message.repliedAt);
    const existing = runs.get(message.runId);

    if (!existing) {
      runs.set(message.runId, {
        customerId: message.customerId,
        from: start,
        last: start,
        engaged,
      });
      continue;
    }

    if (start < existing.from) existing.from = start;
    if (start > existing.last) existing.last = start;
    // Read any one of them and the sequence was noticed.
    existing.engaged = existing.engaged || engaged;
  }

  const bookingsBy = groupBy(input.bookings, (b) => b.customerId);
  const salesBy = groupBy(input.sales, (s) => s.customerId);

  const outcomes: JourneyOutcomes = {
    reached: runs.size,
    engaged: 0,
    booked: 0,
    visited: 0,
    revenue: 0,
  };

  for (const run of runs.values()) {
    if (run.engaged) outcomes.engaged += 1;

    const until = windowEnd(run.last, input.windowDays);

    const booked = (bookingsBy.get(run.customerId) ?? []).some(
      (b) => b.decidedAt >= run.from && b.decidedAt <= until,
    );
    if (booked) outcomes.booked += 1;

    const theirSales = (salesBy.get(run.customerId) ?? []).filter(
      (s) => s.at >= run.from && s.at <= until,
    );
    if (theirSales.length > 0) {
      outcomes.visited += 1;
      outcomes.revenue += theirSales.reduce((sum, s) => sum + s.amount, 0);
    }
  }

  // Money, to the paisa, and never carried as a float beyond this point.
  outcomes.revenue = Math.round(outcomes.revenue * 100) / 100;
  return outcomes;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

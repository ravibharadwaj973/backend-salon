import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { AppError } from '../../core/errors';
import { runAsTenant, runUnscoped } from '../../core/context';
import { availableSlots } from '../appointments/availability.service';
import { createAppointment } from '../appointments/appointment.service';

/**
 * WHAT THE ASSISTANT MAY ASK THE BACKEND TO DO.
 *
 * The model proposes; this decides. Every function here re-establishes the
 * facts from the database rather than trusting anything that came out of a
 * sentence — the service must exist and be bookable for THIS salon, the slot
 * must be genuinely free at the moment of writing, and the customer must be
 * one we know.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────
 *
 * The model never reaches Postgres. It returns a request; the request is
 * validated; the write happens through the same createAppointment() the
 * reception desk uses, with the same conflict check and the same transaction.
 * Two customers asking for 6pm at the same moment is not a hypothetical, and
 * the only thing that resolves it correctly is the database — not a model, and
 * not a check performed two seconds earlier.
 */

export interface SlotOffer {
  serviceId: string;
  serviceName: string;
  startAt: Date;
  staffId: string | null;
  staffName: string | null;
  label: string;
}

/**
 * The service the customer meant, or nothing.
 *
 * Exact match first, then a contained-word match, because a customer writes
 * "hair spa" and the catalogue says "Hair Spa (60 min)". Never fuzzy beyond
 * that: booking somebody a Hair Colour because they typed "hair" is worse than
 * asking them which they meant.
 */
export async function matchService(tenantId: string, said: string | null) {
  if (!said) return null;
  const wanted = said.trim().toLowerCase();
  if (!wanted) return null;

  const services = await runUnscoped(() =>
    prisma.service.findMany({
      where: { tenantId, isActive: true, onlineBookable: true },
      select: { id: true, name: true, durationMin: true },
    }),
  );

  return (
    services.find((s) => s.name.toLowerCase() === wanted) ??
    services.find((s) => s.name.toLowerCase().includes(wanted)) ??
    services.find((s) => wanted.includes(s.name.toLowerCase())) ??
    null
  );
}

/**
 * Real free times, from the real diary.
 *
 * `time` narrows to that hour when given; without it the whole day comes back
 * and the caller offers the first few. Returns [] for a closed day, which the
 * assistant must report as closed rather than as "nothing free" — those are
 * different answers and a customer acts differently on each.
 */
export async function checkAvailability(input: {
  tenantId: string;
  branchId: string;
  serviceId: string;
  serviceName: string;
  date: Date;
  time?: string | null;
}): Promise<SlotOffer[]> {
  const staffSlots = await runAsTenant(input.tenantId, () =>
    availableSlots({ branchId: input.branchId, date: input.date, serviceIds: [input.serviceId] }),
  ).catch(() => []);

  const offers: SlotOffer[] = [];
  for (const staff of staffSlots) {
    for (const slot of staff.slots) {
      if (!slot.available) continue;
      if (input.time && slot.label !== input.time) continue;
      offers.push({
        serviceId: input.serviceId,
        serviceName: input.serviceName,
        startAt: slot.start,
        staffId: staff.staffId,
        staffName: staff.staffName,
        label: slot.label,
      });
    }
  }

  // Earliest first: a customer asking "what's free Saturday" wants the
  // shortest wait, not whichever stylist the query happened to return first.
  return offers.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * Create the appointment — the only write in this whole path.
 *
 * Goes through createAppointment(), the same function the reception desk uses,
 * so it inherits the conflict check, the transaction, the blacklist rule and
 * everything else that has ever been learned about booking. A second
 * availability check here would be a comfort rather than a guarantee: between
 * the offer and the yes, somebody else can take the slot, and only the write
 * itself can settle that.
 *
 * Marked SOURCE = ONLINE so a salon can tell at a glance which appointments
 * came from the assistant rather than the desk.
 */
export async function bookOffer(input: {
  tenantId: string;
  branchId: string;
  customerId: string;
  offer: SlotOffer;
}): Promise<{ ok: true; appointmentId: string } | { ok: false; reason: string; taken: boolean }> {
  try {
    const appointment = await runAsTenant(input.tenantId, () =>
      createAppointment({
        branchId: input.branchId,
        customerId: input.customerId,
        startAt: input.offer.startAt,
        services: [
          {
            serviceId: input.offer.serviceId,
            ...(input.offer.staffId ? { staffId: input.offer.staffId } : {}),
          },
        ],
        source: 'ONLINE',
        sourceRef: 'whatsapp-assistant',
      }),
    );
    logger.info(
      {
        tenantId: input.tenantId,
        branchId: input.branchId,
        customerId: input.customerId,
        appointmentId: appointment.id,
        serviceId: input.offer.serviceId,
        startAt: input.offer.startAt,
      },
      'assistant booked an appointment',
    );
    return { ok: true, appointmentId: appointment.id };
  } catch (err) {
    /**
     * TWO DIFFERENT FAILURES WEARING THE SAME FACE.
     *
     * One is expected: somebody took the slot between the offer and the yes.
     * The customer is told honestly and offered what is still free, which is
     * the only decent answer.
     *
     * The other is a bug — a service that is not bookable, a customer the
     * booking rules refuse, a branch mismatch, a validation error. Both used to
     * come back as the same `ok: false`, and the caller says "sorry, that time
     * has just gone" to either. So every real fault was reported to the customer
     * as bad luck and to us as nothing at all, and the only symptom anybody
     * could see was "the assistant never books anything".
     *
     * The distinction is drawn from the error itself: a conflict is the
     * expected race, anything else is ours to fix, and only the second is worth
     * waking somebody for.
     */
    const message = err instanceof Error ? err.message : 'could not book';
    const taken =
      err instanceof AppError ? err.statusCode === 409 : /not available|conflict/i.test(message);

    if (taken) {
      logger.info(
        { tenantId: input.tenantId, customerId: input.customerId, startAt: input.offer.startAt },
        'assistant could not book: the slot went between the offer and the yes',
      );
    } else {
      logger.error(
        {
          err,
          tenantId: input.tenantId,
          branchId: input.branchId,
          customerId: input.customerId,
          serviceId: input.offer.serviceId,
          startAt: input.offer.startAt,
        },
        'assistant could not book and it was NOT a taken slot — the customer was told the ' +
          'time had gone, which is not what happened',
      );
    }

    return { ok: false, reason: message, taken };
  }
}

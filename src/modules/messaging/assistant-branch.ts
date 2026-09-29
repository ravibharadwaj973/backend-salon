import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';

/**
 * WHICH SHOP? — ASKED, NOT GUESSED.
 *
 * A salon with two locations cannot have an appointment booked without one,
 * because a time being free is a fact about a room and a stylist, not about a
 * business. Until now a customer with no branch on file simply fell through:
 * the assistant answered their question pleasantly and never offered a time,
 * which from the customer's side looks like being ignored.
 *
 * ── Why this is a conversation and not a default ──────────────────────────
 *
 * The tempting fix is to use the salon's first branch. That books somebody into
 * a shop on the other side of the city, and they find out when they arrive at
 * the wrong one — or worse, when they don't, and a stylist sits idle holding a
 * slot. A wrong branch is not a smaller version of a right one.
 *
 * So: use what we know when we know it, ask when we do not, and never infer.
 * The order below is the whole policy —
 *
 *   1. the customer's own branch, if the salon has recorded one;
 *   2. the branch they just named, if it is unambiguous;
 *   3. the only branch there is (a single-shop salon is never asked, because
 *      there is no question to ask);
 *   4. otherwise ASK, and hold the request until they answer.
 *
 * ── Why ambiguity returns nothing rather than a best guess ────────────────
 *
 * "Andheri" against branches called Andheri West and Andheri East matches both.
 * Picking the first is a coin toss with a customer's evening on it, and the
 * customer is right there, mid-conversation, able to settle it in four
 * characters. Every tier below therefore requires exactly one match; two
 * matches means asking again, which is cheap and honest.
 */

/** As many as fit a WhatsApp message somebody will actually read. */
const MAX_LISTED = 8;

export interface BranchChoice {
  id: string;
  name: string;
  /** Used for matching — a customer names the area far more often than the shop. */
  city: string | null;
}

export type BranchResolution =
  | {
      kind: 'RESOLVED';
      branchId: string;
      branchName: string;
      /**
       * True when the salon has more than one shop, and therefore when the
       * branch has to be SAID.
       *
       * "Done — Hair Spa on Tuesday. See you then." is a complete confirmation
       * for a salon with one address and a riddle for a salon with two. The
       * customer is not told where to go, and neither is anybody reading the
       * thread. A single-shop salon does not need telling which shop, so this
       * is what decides rather than always naming it.
       */
      ofMany: boolean;
    }
  /** Ask the customer. `branches` is in the order the question lists them. */
  | { kind: 'ASK'; branches: BranchChoice[]; question: string }
  /** The salon has no active branch at all — nothing can be booked anywhere. */
  | { kind: 'NONE' };

export async function bookableBranches(tenantId: string): Promise<BranchChoice[]> {
  const branches = await runUnscoped(() =>
    prisma.branch.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true, city: true },
      // Oldest first, so the list a customer sees is stable between messages.
      // A list that reorders itself makes "2" mean two different shops.
      orderBy: { createdAt: 'asc' },
      take: MAX_LISTED,
    }),
  );
  return branches;
}

/**
 * The branch the customer meant, or null when it is not certain.
 *
 * `branches` must be in the order the question presented them, because a
 * customer answering a numbered list replies "2" and nothing else — which is
 * the single most common answer shape and the reason the order is pinned.
 */
export function matchBranch(branches: BranchChoice[], said: string | null): BranchChoice | null {
  if (!said || branches.length === 0) return null;
  const raw = said.trim();
  if (!raw) return null;

  /**
   * A bare number is an ordinal, and only a bare one.
   *
   * "2" answers the question. "2 people" and "at 2" do not, and treating them
   * as a choice of shop would silently book the wrong one — so the whole
   * message has to be the number, optionally with the punctuation people type
   * when copying a list back ("2." or "2)").
   */
  const ordinal = /^([1-9])\s*[.)]?$/.exec(raw);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    return branches[index] ?? null;
  }

  const wanted = raw.toLowerCase();

  /** A tier counts only if exactly one branch matches it. Two is a question. */
  const only = (matches: BranchChoice[]): BranchChoice | null =>
    matches.length === 1 ? matches[0]! : null;

  return (
    only(branches.filter((b) => b.name.toLowerCase() === wanted)) ??
    only(branches.filter((b) => (b.city ?? '').toLowerCase() === wanted)) ??
    only(branches.filter((b) => b.name.toLowerCase().includes(wanted))) ??
    only(branches.filter((b) => (b.city ?? '').toLowerCase().includes(wanted))) ??
    // The customer wrote more than the name: "the andheri west one, please".
    only(branches.filter((b) => wanted.includes(b.name.toLowerCase()))) ??
    only(branches.filter((b) => Boolean(b.city) && wanted.includes(b.city!.toLowerCase()))) ??
    null
  );
}

/**
 * The question, numbered.
 *
 * Numbered because it gives the customer a one-character reply and gives us an
 * unambiguous match for it. The name is still there for anyone who answers in
 * words, and the city is appended when it is not already in the name — "Glow
 * Studio" and "Glow Studio" tell a customer nothing about which is nearer.
 */
export function branchQuestion(branches: BranchChoice[]): string {
  /**
   * The city earns its place only when it tells the customer something.
   *
   * Two shops both in Mumbai gain nothing from "(Mumbai)" twice — it is a longer
   * message that distinguishes nothing, and length costs attention in a list
   * somebody is meant to answer in one character. Across cities it is the whole
   * point.
   */
  const cities = new Set(branches.map((b) => (b.city ?? '').toLowerCase()).filter(Boolean));
  const citiesDiffer = cities.size > 1;

  const lines = branches.map((branch, index) => {
    const city =
      citiesDiffer && branch.city && !branch.name.toLowerCase().includes(branch.city.toLowerCase())
        ? ` (${branch.city})`
        : '';
    return `${index + 1}. ${branch.name}${city}`;
  });

  const count = branches.length === 2 ? 'two' : branches.length === 3 ? 'three' : String(branches.length);
  const opening =
    branches.length === 1
      ? 'Which location would you like?'
      : `We have ${count} locations — which would you like?`;

  return [opening, ...lines, '', 'Just reply with the number or the name.'].join('\n');
}

/**
 * Where to book, given everything we know.
 *
 * `said` is the customer's own words, passed so a branch named in the same
 * breath as the booking ("can I come to Bandra tomorrow at 6") is used without
 * a second round trip.
 */
/**
 * THE SHOP THEY ACTUALLY GO TO.
 *
 * Asked before the customer is. A salon that has served somebody four times at
 * Gomti Nagar should not open the fifth conversation by asking them which of its
 * shops they mean — it is the one question a regular knows we already have the
 * answer to, and asking it is the app admitting it does not know its own
 * customers.
 *
 * Their record's `branchId` is the first answer and is usually set; this is for
 * the customer it is not set on, which is most of the ones created from a
 * walk-in, a QR rating or an imported list. The appointment book knows anyway.
 *
 * Only their LAST visit, and only one query. Somebody who went to Bandra once
 * two years ago and to Gomti Nagar last week means Gomti Nagar, and a tally
 * across their whole history would have to decide what to do about a tie —
 * which is a question with no good answer and a customer sitting there waiting.
 * The most recent visit is both the simplest rule and the right one.
 *
 * `customerId` may be null: a message from a number nobody has on file never
 * reaches this far, but the type says so and a wrong guess here would be a
 * stranger's branch attached to somebody else's booking.
 */
async function branchTheyLastVisited(input: {
  tenantId: string;
  customerId: string | null;
}): Promise<string | null> {
  if (!input.customerId) return null;

  const last = await runUnscoped(() =>
    prisma.appointment.findFirst({
      where: {
        tenantId: input.tenantId,
        customerId: input.customerId,
        // No status filter on purpose. A cancelled booking still says which shop
        // they chose, and somebody who called off one visit has not changed
        // where they go.
      },
      orderBy: { startAt: 'desc' },
      select: { branchId: true },
    }),
  ).catch(() => null);

  return last?.branchId ?? null;
}

export async function resolveBranch(input: {
  tenantId: string;
  /** The branch the salon has on the customer's record, if any. */
  customerBranchId: string | null;
  /** The branch the inbound message was attributed to, if any. */
  messageBranchId: string | null;
  /** Who is asking, so their own history can answer before they are asked. */
  customerId: string | null;
  said: string | null;
}): Promise<BranchResolution> {
  /**
   * Their own branch wins, and is never overridden by something they typed.
   *
   * A customer the salon has already placed at a shop is not asked which shop
   * they mean — they have a stylist there and a history there. If they do mean
   * to visit the other one, they will say so, and a person can move it: that is
   * a better failure than interrogating every regular about their own salon.
   */
  /**
   * The shops first, once, and everything else is decided against that list.
   *
   * It also answers a question the caller needs either way — whether there is
   * more than one shop, and so whether the branch has to be named out loud.
   */
  const branches = await bookableBranches(input.tenantId);
  if (branches.length === 0) return { kind: 'NONE' };

  const ofMany = branches.length > 1;
  const resolved = (branch: BranchChoice): BranchResolution => ({
    kind: 'RESOLVED',
    branchId: branch.id,
    branchName: branch.name,
    ofMany,
  });

  const known =
    input.customerBranchId ?? input.messageBranchId ?? (await branchTheyLastVisited(input));
  if (known) {
    // Matched against the ACTIVE list, so a branch that has since closed falls
    // through and is asked about rather than booked into.
    const listed = branches.find((row) => row.id === known);
    if (listed) return resolved(listed);

    /**
     * The list above is capped at what fits in a question somebody will read.
     * A salon with nine shops therefore has a ninth that is not in it — and a
     * customer whose own branch is that ninth must not be asked to choose from
     * eight it is not among. So a known branch that did not make the list is
     * looked up directly.
     */
    if (branches.length >= MAX_LISTED) {
      const beyond = await runUnscoped(() =>
        prisma.branch.findFirst({
          where: { id: known, tenantId: input.tenantId, isActive: true },
          select: { id: true, name: true, city: true },
        }),
      );
      if (beyond) return resolved(beyond);
    }
  }

  // No choice to offer, so no question worth asking.
  if (!ofMany) return resolved(branches[0]!);

  const named = matchBranch(branches, input.said);
  if (named) return resolved(named);

  return { kind: 'ASK', branches, question: branchQuestion(branches) };
}

/**
 * THE REQUEST, PARKED WHILE WE WAIT FOR AN ANSWER.
 *
 * "I want a haircut tomorrow at 6" plus "Bandra" is one booking spread over two
 * messages, and the second one contains almost none of it. So the first is held
 * — on the customer, in the same column an outstanding slot offer uses, because
 * the two are the same kind of thing (a conversation waiting on a reply) and
 * because reusing the column needs no schema change on a database that has no
 * migration history.
 *
 * The `kind` discriminator is what keeps them apart. A slot offer written before
 * this existed has no `kind` at all, which is why readHeldOffer treats a missing
 * one as a slot offer and this requires the string exactly: an old offer must
 * never be read as a branch question, or a customer's "yes" would resolve to
 * nothing.
 */
export const BRANCH_PENDING = 'BRANCH_CHOICE' as const;

export interface PendingBranchChoice {
  kind: typeof BRANCH_PENDING;
  /** The branches offered, in the order the question listed them. */
  branches: BranchChoice[];
  /** The booking that is waiting on the answer, exactly as it was understood. */
  service: string | null;
  date: string | null;
  time: string | null;
  staff: string | null;
}

export function pendingBranchPayload(input: {
  branches: BranchChoice[];
  service: string | null;
  date: string | null;
  time: string | null;
  staff: string | null;
}): PendingBranchChoice {
  return {
    kind: BRANCH_PENDING,
    branches: input.branches.map((b) => ({ id: b.id, name: b.name, city: b.city })),
    service: input.service,
    date: input.date,
    time: input.time,
    staff: input.staff,
  };
}

/**
 * A parked branch question, or null.
 *
 * Expires on the same clock as a slot offer: a customer who answers "Bandra" two
 * days later is starting a new conversation, not finishing an old one, and the
 * times we were about to check are long gone.
 */
export function readPendingBranch(
  raw: unknown,
  at: Date | null,
  staleMinutes: number,
  now: Date = new Date(),
): PendingBranchChoice | null {
  if (!raw || !at) return null;
  if (now.getTime() - at.getTime() > staleMinutes * 60 * 1000) return null;

  const row = raw as Partial<PendingBranchChoice>;
  if (row.kind !== BRANCH_PENDING) return null;
  if (!Array.isArray(row.branches) || row.branches.length === 0) return null;

  const branches = row.branches
    .filter((b): b is BranchChoice => Boolean(b && typeof b.id === 'string' && typeof b.name === 'string'))
    .map((b) => ({ id: b.id, name: b.name, city: b.city ?? null }));

  if (branches.length === 0) return null;

  return {
    kind: BRANCH_PENDING,
    branches,
    service: row.service ?? null,
    date: row.date ?? null,
    time: row.time ?? null,
    staff: row.staff ?? null,
  };
}

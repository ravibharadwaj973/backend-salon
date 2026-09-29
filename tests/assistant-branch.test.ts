import { describe, expect, it, vi } from 'vitest';

/**
 * Everything exercised here is pure. The module it lives in also reads branches
 * from the database, and importing it would otherwise instantiate a Prisma
 * client — which turns a test about string matching into a test that needs a
 * working engine binary.
 */
vi.mock('../src/core/prisma', () => ({ prisma: {} }));
vi.mock('../src/core/context', () => ({ runUnscoped: <T>(fn: () => Promise<T>) => fn() }));

const {
  BRANCH_PENDING,
  branchQuestion,
  matchBranch,
  pendingBranchPayload,
  readPendingBranch,
} = await import('../src/modules/messaging/assistant-branch');
type BranchChoice = import('../src/modules/messaging/assistant-branch').BranchChoice;

/**
 * WHICH SHOP THE CUSTOMER MEANT.
 *
 * A salon with two locations cannot have an appointment booked without one, and
 * a wrong branch is not a smaller version of a right one — it is a customer
 * standing outside the wrong door and a stylist holding a slot nobody comes to.
 *
 * So most of what is pinned here is the REFUSAL to guess: every match has to be
 * the only one of its kind, because the customer is right there and can settle
 * it in four characters. Asking twice is cheap; booking the wrong shop is not.
 */

const ANDHERI: BranchChoice = { id: 'b_and', name: 'Glow Studio Andheri West', city: 'Mumbai' };
const BANDRA: BranchChoice = { id: 'b_ban', name: 'Glow Studio Bandra', city: 'Mumbai' };
const PUNE: BranchChoice = { id: 'b_pun', name: 'Glow Studio', city: 'Pune' };

describe('answering with a number', () => {
  const branches = [ANDHERI, BANDRA];

  it('takes a bare number as the position in the list we sent', () => {
    expect(matchBranch(branches, '2')?.id).toBe('b_ban');
    expect(matchBranch(branches, '1')?.id).toBe('b_and');
  });

  it('accepts the punctuation people type when copying a list back', () => {
    expect(matchBranch(branches, '2.')?.id).toBe('b_ban');
    expect(matchBranch(branches, ' 2) ')?.id).toBe('b_ban');
  });

  it('ignores a number that is part of a sentence', () => {
    /**
     * The case this guard exists for. "at 2" is a time and "2 people" is a
     * party size; reading either as a choice of shop would book the wrong one
     * silently, which is the single worst outcome available here.
     */
    expect(matchBranch(branches, 'can I come at 2')).toBeNull();
    expect(matchBranch(branches, '2 people')).toBeNull();
    expect(matchBranch(branches, 'for 2')).toBeNull();
  });

  it('ignores a number past the end of the list', () => {
    expect(matchBranch(branches, '5')).toBeNull();
  });
});

describe('a bare number when nothing was numbered', () => {
  const branches = [ANDHERI, BANDRA];

  it('is refused once a time is already on the table', () => {
    /**
     * The switch path. A customer who has been offered 6pm and replies "2" is
     * far likelier to mean two o'clock than shop number two, and reading it as a
     * shop would move a booking they never asked to move. The ordinal rule is
     * only safe directly after a numbered question.
     */
    expect(matchBranch(branches, '2', { ordinals: false })).toBeNull();
    expect(matchBranch(branches, '1', { ordinals: false })).toBeNull();
  });

  it('still takes a name in that state, which is the whole point', () => {
    // "actually, Bandra" has to work, or the branch is a decision nobody can
    // revisit once it has been made for them.
    expect(matchBranch(branches, 'bandra', { ordinals: false })?.id).toBe('b_ban');
    expect(matchBranch(branches, 'can we do the Bandra one instead', { ordinals: false })?.id).toBe('b_ban');
  });
});

describe('answering with a name', () => {
  const branches = [ANDHERI, BANDRA];

  it('matches the branch name exactly', () => {
    expect(matchBranch(branches, 'Glow Studio Bandra')?.id).toBe('b_ban');
  });

  it('matches on the part of the name a customer actually says', () => {
    // Nobody types the full shop name. They type the area.
    expect(matchBranch(branches, 'bandra')?.id).toBe('b_ban');
    expect(matchBranch(branches, 'Andheri')?.id).toBe('b_and');
  });

  it('matches when the branch is named inside a longer sentence', () => {
    expect(matchBranch(branches, 'the Glow Studio Bandra one please')?.id).toBe('b_ban');
  });

  it('matches the city when that is what distinguishes the shops', () => {
    expect(matchBranch([BANDRA, PUNE], 'pune')?.id).toBe('b_pun');
  });

  it('refuses a name that fits two shops', () => {
    /**
     * The ambiguity case, and the reason every tier requires exactly one match.
     * "Andheri" against Andheri West and Andheri East is a coin toss with
     * somebody's evening on it.
     */
    const east: BranchChoice = { id: 'b_ae', name: 'Glow Studio Andheri East', city: 'Mumbai' };
    expect(matchBranch([ANDHERI, east], 'andheri')).toBeNull();
  });

  it('refuses a city that fits two shops', () => {
    expect(matchBranch([ANDHERI, BANDRA], 'mumbai')).toBeNull();
  });

  it('refuses a name that fits nothing', () => {
    expect(matchBranch(branches, 'thane')).toBeNull();
  });

  it('refuses an empty answer', () => {
    expect(matchBranch(branches, '')).toBeNull();
    expect(matchBranch(branches, '   ')).toBeNull();
    expect(matchBranch(branches, null)).toBeNull();
  });
});

describe('naming a shop inside a sentence', () => {
  const branches = [ANDHERI, BANDRA];

  it('finds the area a customer actually says', () => {
    // "Glow Studio Bandra" is the shop's name; "Bandra" is what people call it.
    expect(matchBranch(branches, 'can we do the Bandra one instead')?.id).toBe('b_ban');
    expect(matchBranch(branches, 'is andheri open on sunday')?.id).toBe('b_and');
  });

  it('refuses the words the shops have in common', () => {
    /**
     * The guard that makes the rule safe. These two share two words of three,
     * so "Glow Studio" identifies nothing — and matching on any word would have
     * picked whichever came first.
     */
    expect(matchBranch(branches, 'the glow studio one please')).toBeNull();
    expect(matchBranch(branches, 'studio')).toBeNull();
  });

  it('matches whole words only', () => {
    // Otherwise a branch called "West" is found inside "westbound".
    const west: BranchChoice = { id: 'b_w', name: 'West', city: 'Mumbai' };
    const east: BranchChoice = { id: 'b_e', name: 'East', city: 'Mumbai' };
    expect(matchBranch([west, east], 'I take the westbound train')).toBeNull();
    expect(matchBranch([west, east], 'the west one')?.id).toBe('b_w');
  });

  it('is not fooled by a sentence naming neither', () => {
    expect(matchBranch(branches, 'what time do you close')).toBeNull();
  });
});

describe('the question we send', () => {
  it('numbers the options so a one-character reply is possible', () => {
    const text = branchQuestion([ANDHERI, BANDRA]);
    expect(text).toContain('1. Glow Studio Andheri West');
    expect(text).toContain('2. Glow Studio Bandra');
  });

  it('appends the city when the shops are in different cities', () => {
    // Two shops called "Glow Studio" tell a customer nothing about which is
    // nearer. Here the city is the only thing that distinguishes them.
    const text = branchQuestion([BANDRA, PUNE]);
    expect(text).toContain('Glow Studio (Pune)');
  });

  it('leaves the city out when every shop is in the same one', () => {
    // "(Mumbai)" twice is a longer message that distinguishes nothing, and
    // length costs attention in a list meant to be answered in one character.
    expect(branchQuestion([ANDHERI, BANDRA])).not.toContain('(Mumbai)');
  });

  it('does not repeat a city the name already says', () => {
    const inCity: BranchChoice = { id: 'b_p2', name: 'Glow Studio Pune', city: 'Pune' };
    expect(branchQuestion([BANDRA, inCity])).toContain('2. Glow Studio Pune\n');
  });

  it('stays grammatical however many there are', () => {
    expect(branchQuestion([ANDHERI, BANDRA])).toContain('two locations');
    expect(branchQuestion([ANDHERI, BANDRA, PUNE])).toContain('three locations');
    expect(branchQuestion([ANDHERI])).toContain('Which location would you like?');
  });

  it('invites either form of answer, since both are matched', () => {
    expect(branchQuestion([ANDHERI, BANDRA]).toLowerCase()).toContain('number or the name');
  });

  it('lists every option it was given, in order', () => {
    const lines = branchQuestion([ANDHERI, BANDRA, PUNE]).split('\n');
    expect(lines.filter((l) => /^\d\./.test(l))).toHaveLength(3);
    expect(lines.findIndex((l) => l.startsWith('1.'))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('3.')),
    );
  });
});

describe('the request parked while we wait for the answer', () => {
  const payload = pendingBranchPayload({
    branches: [ANDHERI, BANDRA],
    service: 'haircut',
    date: '2026-09-30',
    time: '18:00',
    staff: null,
  });

  it('survives a round trip through the Json column', () => {
    // What comes back out of Postgres is parsed JSON, not the object we put in.
    const stored = JSON.parse(JSON.stringify(payload)) as unknown;
    const read = readPendingBranch(stored, new Date(), 60);

    expect(read?.service).toBe('haircut');
    expect(read?.date).toBe('2026-09-30');
    expect(read?.time).toBe('18:00');
    expect(read?.branches.map((b) => b.id)).toEqual(['b_and', 'b_ban']);
  });

  it('keeps the branches in the order the question listed them', () => {
    // Because the customer answers "2", and "2" must mean the same shop on the
    // way back as it did on the way out.
    const read = readPendingBranch(JSON.parse(JSON.stringify(payload)), new Date(), 60);
    expect(matchBranch(read!.branches, '2')?.id).toBe('b_ban');
  });

  it('expires, because an answer two days later starts a new conversation', () => {
    const anHourAgo = new Date(Date.now() - 61 * 60 * 1000);
    expect(readPendingBranch(payload, anHourAgo, 60)).toBeNull();
  });

  it('is nothing without a timestamp to age it against', () => {
    expect(readPendingBranch(payload, null, 60)).toBeNull();
  });

  it('is nothing when the column is empty', () => {
    expect(readPendingBranch(null, new Date(), 60)).toBeNull();
  });
});

describe('the two held shapes are never read as each other', () => {
  it('does not read a slot offer as a branch question', () => {
    /**
     * They share one column. A slot offer written before the branch question
     * existed carries no `kind`, and reading it as a parked question would make
     * a customer's "Bandra" resume a booking request that does not exist.
     */
    const slotOffer = {
      serviceId: 's1',
      serviceName: 'Haircut',
      startAt: new Date().toISOString(),
      staffId: null,
      staffName: null,
      label: '6:00 pm',
    };
    expect(readPendingBranch(slotOffer, new Date(), 60)).toBeNull();
  });

  it('marks its own payload so the slot reader can tell them apart', () => {
    expect(pendingBranchPayload({ branches: [ANDHERI], service: null, date: null, time: null, staff: null }).kind).toBe(
      BRANCH_PENDING,
    );
  });

  it('rejects a payload whose branch list did not survive', () => {
    // No branches means no question could be re-asked and no answer matched, so
    // there is nothing to resume.
    expect(readPendingBranch({ kind: BRANCH_PENDING, branches: [] }, new Date(), 60)).toBeNull();
    expect(readPendingBranch({ kind: BRANCH_PENDING }, new Date(), 60)).toBeNull();
    expect(
      readPendingBranch({ kind: BRANCH_PENDING, branches: [{ name: 'no id' }] }, new Date(), 60),
    ).toBeNull();
  });
});

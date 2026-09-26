import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { segmentWhere } from '../src/modules/marketing/segment.service';

/**
 * THE BUG THIS EXISTS TO PREVENT.
 *
 * A hand-picked segment carries `rules: {}`, and buildSegmentWhere turns empty
 * rules into "every active customer". The review screen — the one directly
 * above the send button, whose entire job is to be trusted before an
 * irreversible action — therefore reported:
 *
 *     43 messages will be sent on WhatsApp
 *     Estimated spend ₹34
 *
 * for a segment containing four people.
 *
 * The send was right and the screen was wrong, which is the safer way round
 * and still unacceptable: an owner reading two different numbers has no way to
 * know which one is real, and the next thing they stop believing is the send
 * confirmation itself.
 *
 * The cause was structural. Three functions each decided independently how to
 * turn a saved segment into a query, and one of them forgot to ask whether the
 * segment was a rule or a list. These tests pin down both the behaviour and the
 * structure, because fixing only the behaviour leaves the fourth call site free
 * to make the same mistake.
 */
describe('turning a saved segment into a query', () => {
  it('scopes a hand-picked segment to its own members', async () => {
    const where = await segmentWhere({
      id: 'seg_1',
      tenantId: 't1',
      isDynamic: false,
      // The shape a hand-picked segment actually carries, and the one that
      // used to mean "everybody".
      rules: {},
    });

    expect(where).toEqual({
      tenantId: 't1',
      isActive: true,
      segmentMembers: { some: { segmentId: 'seg_1' } },
    });
  });

  it('ignores whatever rules a hand-picked segment happens to carry', async () => {
    // A segment converted from a rule to a list keeps its old rules on the row.
    // Honouring them would quietly re-widen it to the rule's audience.
    const where = await segmentWhere({
      id: 'seg_2',
      tenantId: 't1',
      isDynamic: false,
      rules: { match: 'all', conditions: [{ field: 'tier', op: 'eq', value: 'GOLD' }] },
    });

    expect(where).toMatchObject({ segmentMembers: { some: { segmentId: 'seg_2' } } });
    expect(JSON.stringify(where)).not.toContain('GOLD');
  });

  it('never returns a where that matches the whole book for a list', async () => {
    // The specific failure: a query with nothing narrowing it but the tenant.
    const where = (await segmentWhere({ id: 'seg_3', tenantId: 't1', isDynamic: false, rules: {} })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(where)).toContain('segmentMembers');
  });

  it('uses the rules for a rule-based segment', async () => {
    const where = await segmentWhere({
      id: 'seg_4',
      tenantId: 't1',
      isDynamic: true,
      rules: { match: 'all', conditions: [] },
    });
    // Whatever the rules produce, it must NOT be member-scoped: a dynamic
    // segment has no stored members, so that would match nobody at all.
    expect(where).not.toHaveProperty('segmentMembers');
    expect(where).toMatchObject({ tenantId: 't1' });
  });
});

describe('the structure that caused it', () => {
  const SOURCE = readFileSync(
    join(__dirname, '..', 'src/modules/marketing/segment.service.ts'),
    'utf8',
  );

  it('builds a where from a saved segment in exactly one place', async () => {
    // Every other caller must go through segmentWhere. A direct
    // buildSegmentWhere(segment.tenantId, ...) is the mistake itself: it skips
    // the isDynamic question entirely, which is how a list became the book.
    const direct = SOURCE.match(/buildSegmentWhere\(\s*segment\./g) ?? [];
    expect(
      direct,
      'a saved segment must go through segmentWhere, which decides rule-vs-list',
    ).toHaveLength(1); // the one inside segmentWhere itself
  });

  it('keeps that one call inside segmentWhere', () => {
    const helper = SOURCE.slice(
      SOURCE.indexOf('export async function segmentWhere('),
      SOURCE.indexOf('export async function previewSegment('),
    );
    expect(helper).toContain('buildSegmentWhere(segment.tenantId');
    expect(helper).toContain('isDynamic');
  });

  it('would catch a new caller that skipped the check', async () => {
    // Proves the guard is not vacuous: this is what a fourth call site looks
    // like, and the pattern above finds it.
    const offending = 'const where = await buildSegmentWhere(segment.tenantId, rules);';
    expect(offending.match(/buildSegmentWhere\(\s*segment\./g) ?? []).toHaveLength(1);
  });
});

/**
 * THE CONDITIONS THAT DECIDE WHETHER SOMEBODY IS LEFT ALONE.
 *
 * These four are different from the rest of the segment fields: the others pick
 * who to include, and getting one wrong means a smaller or larger list. These
 * decide whether a customer who was messaged on Tuesday gets messaged again
 * today, and whether a page somebody opened is read back as interest. Both are
 * felt by a person rather than seen on a screen.
 */
describe('the quiet period, and what it counts as having messaged somebody', () => {
  const where = (field: string, value: unknown) =>
    segmentWhere({
      id: 'seg_q',
      tenantId: 't1',
      isDynamic: true,
      rules: { match: 'all', conditions: [{ field, op: 'gte', value }] },
    });

  it('is built from their messages rather than a stored column', async () => {
    // A "last marketing at" column drifts and needs a backfill. `none` across
    // the relation cannot be out of date.
    const sql = JSON.stringify(await where('noMarketingInDays', 7));
    expect(sql).toContain('messages');
    expect(sql).toContain('none');
  });

  it('counts marketing only, so a booking confirmation does not lock somebody out', async () => {
    /**
     * The failure this prevents: counting every message would exclude the
     * customers who come most often — they get a confirmation and a reminder
     * every visit — which is exactly backwards for a rebooking campaign.
     */
    const sql = JSON.stringify(await where('noMarketingInDays', 7));
    expect(sql).toContain('MARKETING');
  });

  it('does not count a message that never left the building', async () => {
    // A SKIPPED message annoyed nobody. Treating it as contact would hold a
    // customer out of a campaign because of the app's own fault.
    const sql = JSON.stringify(await where('noMarketingInDays', 7));
    expect(sql).toContain('SKIPPED');
    expect(sql).toContain('FAILED');
  });
});

describe('segmenting on what somebody looked at', () => {
  const where = (field: string, value: unknown) =>
    segmentWhere({
      id: 'seg_i',
      tenantId: 't1',
      isDynamic: true,
      rules: { match: 'all', conditions: [{ field, op: 'eq', value }] },
    });

  it('reads the rollup, not the event log', async () => {
    // The events grow forever. A segment that scanned them would get slower
    // every month for no better answer.
    const sql = JSON.stringify(await where('viewedService', 'svc-spa'));
    expect(sql).toContain('interests');
    expect(sql).toContain('SERVICE');
    expect(sql).toContain('svc-spa');
  });

  it('separates a service from its category', async () => {
    const service = JSON.stringify(await where('viewedService', 'svc-spa'));
    const category = JSON.stringify(await where('viewedCategory', 'cat-hair'));
    expect(service).toContain('"kind":"SERVICE"');
    expect(category).toContain('"kind":"CATEGORY"');
  });

  it('asks whether a link was ever tapped, not whether it is currently CLICKED', async () => {
    /**
     * A message that was clicked and later replied to has moved past CLICKED.
     * A salon asking "who reads my messages" means ever, so this is on the
     * clickedAt timestamp rather than on the status column.
     */
    const sql = JSON.stringify(await where('clickedAnyMessage', true));
    expect(sql).toContain('clickedAt');
    expect(sql).not.toContain('"status"');
  });

  it('inverts to people who have never tapped one', async () => {
    const sql = JSON.stringify(await where('clickedAnyMessage', false));
    expect(sql).toContain('none');
  });
});

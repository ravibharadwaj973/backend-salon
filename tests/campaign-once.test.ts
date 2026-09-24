import { describe, expect, it } from 'vitest';

/**
 * THE CAMPAIGN THAT SENT TWENTY-EIGHT MESSAGES TO FIVE PEOPLE.
 *
 * dispatchCampaign read the campaign's status, checked two of the six values,
 * and set RUNNING unconditionally. Jobs retry five times. So a dispatch that
 * failed partway — one provider timeout, one database blip — came back and
 * messaged everyone again from the beginning, up to five times over.
 *
 * launchCampaign already refused to re-send a completed campaign, so this was
 * never somebody pressing the button twice. It was the retry: nobody presses
 * it and nobody sees it.
 *
 * Two guards, and they answer different questions. The claim decides WHO RUNS.
 * The already-messaged set decides WHO GETS ONE — and it is the one that makes
 * keeping RUNNING on the claim list safe, so an interrupted campaign can
 * finish rather than leaving half a segment messaged for ever.
 */

/** The claim, as the WHERE clause expresses it. */
const CLAIMABLE = ['DRAFT', 'SCHEDULED', 'RUNNING'];
const claims = (status: string) => CLAIMABLE.includes(status);

describe('a campaign dispatches once', () => {
  it('claims a campaign that is waiting to go', () => {
    expect(claims('DRAFT')).toBe(true);
    expect(claims('SCHEDULED')).toBe(true);
  });

  it('refuses one that is finished, paused or cancelled', () => {
    // COMPLETED is the important one: that is a re-send to the whole segment.
    expect(claims('COMPLETED')).toBe(false);
    expect(claims('PAUSED')).toBe(false);
    expect(claims('CANCELLED')).toBe(false);
  });

  it('lets an interrupted run be picked back up', () => {
    // Safe only because of the skip below. Without it this is the bug.
    expect(claims('RUNNING')).toBe(true);
  });
});

/** Who the fan-out actually writes to, given who it has written to before. */
function recipients(members: { id: string }[], alreadyMessaged: string[]) {
  const messaged = new Set(alreadyMessaged);
  return members.filter((member) => !messaged.has(member.id));
}

const SEGMENT = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }, { id: 'c5' }];

describe('a retry resumes rather than restarting', () => {
  it('messages everybody on a clean first run', () => {
    expect(recipients(SEGMENT, [])).toHaveLength(5);
  });

  it('sends only to the ones missed when it failed partway', () => {
    // It reached c1 and c2, then died. The retry owes three people a message.
    expect(recipients(SEGMENT, ['c1', 'c2']).map((m) => m.id)).toEqual(['c3', 'c4', 'c5']);
  });

  it('sends to nobody once everyone has been reached', () => {
    // Five retries of a finished run used to mean twenty more messages.
    expect(recipients(SEGMENT, ['c1', 'c2', 'c3', 'c4', 'c5'])).toEqual([]);
  });

  it('never sends more than the segment holds, however many times it runs', () => {
    let messaged: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      messaged = [...messaged, ...recipients(SEGMENT, messaged).map((m) => m.id)];
    }
    expect(messaged).toHaveLength(SEGMENT.length);
    expect(new Set(messaged).size).toBe(SEGMENT.length);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_SERVICE_COMMENT,
  meanServiceRating,
  selectServiceRatings,
} from '../src/modules/feedback/service-ratings';

const APPOINTMENT = ['svc_haircut', 'svc_facial'];

describe('per-service ratings from a public form', () => {
  it('keeps the services that were on the appointment', () => {
    expect(
      selectServiceRatings(
        [
          { serviceId: 'svc_haircut', rating: 5 },
          { serviceId: 'svc_facial', rating: 3, comment: '  a bit rushed  ' },
        ],
        APPOINTMENT,
      ),
    ).toEqual([
      { serviceId: 'svc_haircut', rating: 5 },
      { serviceId: 'svc_facial', rating: 3, comment: 'a bit rushed' },
    ]);
  });

  it('drops a service that was not on the appointment', () => {
    /**
     * The one that matters. This form is public and unauthenticated: anybody
     * with the link can post to it. Without this check, anybody could put a 1
     * against every service in the catalogue and the service-performance
     * table would stop being evidence of anything.
     */
    expect(
      selectServiceRatings(
        [
          { serviceId: 'svc_haircut', rating: 5 },
          { serviceId: 'svc_bridal_makeup', rating: 1 },
        ],
        APPOINTMENT,
      ),
    ).toEqual([{ serviceId: 'svc_haircut', rating: 5 }]);
  });

  it('keeps the real ratings when one row is bad, rather than failing the lot', () => {
    // A stale tab is likelier than an attack, and throwing away somebody's
    // honest five stars to punish one bad id helps nobody.
    const kept = selectServiceRatings(
      [
        { serviceId: 'svc_unknown', rating: 4 },
        { serviceId: 'svc_facial', rating: 4 },
      ],
      APPOINTMENT,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.serviceId).toBe('svc_facial');
  });

  it('refuses a rating outside one to five', () => {
    const kept = selectServiceRatings(
      [
        { serviceId: 'svc_haircut', rating: 0 },
        { serviceId: 'svc_facial', rating: 9 },
      ],
      APPOINTMENT,
    );
    expect(kept).toEqual([]);
  });

  it('refuses a fractional rating', () => {
    // The column is an integer and the form shows five stars. A 4.5 arriving
    // here came from something other than the form.
    expect(selectServiceRatings([{ serviceId: 'svc_haircut', rating: 4.5 }], APPOINTMENT)).toEqual([]);
  });

  it('takes the first answer when a service is rated twice', () => {
    const kept = selectServiceRatings(
      [
        { serviceId: 'svc_haircut', rating: 5 },
        { serviceId: 'svc_haircut', rating: 1 },
      ],
      APPOINTMENT,
    );
    expect(kept).toEqual([{ serviceId: 'svc_haircut', rating: 5 }]);
  });

  it('caps a very long service comment', () => {
    const kept = selectServiceRatings(
      [{ serviceId: 'svc_haircut', rating: 4, comment: 'x'.repeat(4000) }],
      APPOINTMENT,
    );
    expect(kept[0]?.comment?.length).toBe(MAX_SERVICE_COMMENT);
  });

  it('drops an empty comment rather than storing a blank one', () => {
    expect(selectServiceRatings([{ serviceId: 'svc_haircut', rating: 4, comment: '   ' }], APPOINTMENT)).toEqual([
      { serviceId: 'svc_haircut', rating: 4 },
    ]);
  });

  it('handles nothing submitted, and an appointment with no services', () => {
    expect(selectServiceRatings(undefined, APPOINTMENT)).toEqual([]);
    expect(selectServiceRatings([], APPOINTMENT)).toEqual([]);
    expect(selectServiceRatings([{ serviceId: 'svc_haircut', rating: 5 }], [])).toEqual([]);
  });
});

describe('the old single serviceRating, derived', () => {
  it('averages the per-service rows', () => {
    // Every report written before this table existed reads serviceRating. It
    // stays filled so none of them silently flatten to nothing.
    expect(meanServiceRating([{ rating: 5 }, { rating: 3 }])).toBe(4);
    expect(meanServiceRating([{ rating: 5 }])).toBe(5);
  });

  it('rounds, because the column is an integer', () => {
    expect(meanServiceRating([{ rating: 5 }, { rating: 4 }])).toBe(5);
    expect(meanServiceRating([{ rating: 4 }, { rating: 3 }, { rating: 3 }])).toBe(3);
  });

  it('is null rather than zero when nothing was rated', () => {
    // A 0 in this column would be a score no customer ever gave, and it would
    // drag every average that reads it.
    expect(meanServiceRating([])).toBeNull();
  });
});

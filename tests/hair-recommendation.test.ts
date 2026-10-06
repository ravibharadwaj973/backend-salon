import { describe, expect, it } from 'vitest';
import { WEIGHTS, recommend, scoreCandidate, type Candidate } from '../src/modules/hair-studio/recommendation';

/**
 * THE RANKING IS THE PRODUCT, SO THE RANKING IS WHAT IS PINNED.
 *
 * Almost every assertion here is about ORDER or about a factor's effect, not
 * about an exact score. A test that says "this scores 87" fails the first time
 * anybody tunes a weight, and gets updated to 84 without anybody asking whether
 * the change was right — which is how a test stops being a check and becomes a
 * transcript. A test that says "a cut she cannot have must not outrank one she
 * can" keeps its meaning through every tuning.
 */

const bob: Candidate = {
  id: 'c-bob',
  kind: 'bob',
  name: 'Bob',
  gender: 'FEMALE',
  maintenance: 'MEDIUM',
  supportedTextures: ['STRAIGHT', 'WAVY'],
  supportedLengths: ['SHORT', 'MEDIUM'],
  supportedDensities: ['MEDIUM', 'HIGH'],
  recommendedFaceShapes: ['OVAL', 'HEART'],
  supportsBangs: true,
  supportsFade: false,
};

const wolf: Candidate = {
  id: 'c-wolf',
  kind: 'wolf_cut',
  name: 'Wolf cut',
  gender: 'FEMALE',
  maintenance: 'HIGH',
  supportedTextures: ['WAVY', 'CURLY'],
  supportedLengths: ['MEDIUM', 'LONG'],
  supportedDensities: ['MEDIUM', 'HIGH'],
  recommendedFaceShapes: ['ROUND', 'SQUARE'],
  supportsBangs: true,
  supportsFade: false,
};

const fade: Candidate = {
  id: 'c-fade',
  kind: 'fade',
  name: 'Mid fade',
  gender: 'MALE',
  maintenance: 'HIGH',
  supportedTextures: ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'],
  supportedLengths: ['VERY_SHORT', 'SHORT'],
  supportedDensities: ['LOW', 'MEDIUM', 'HIGH'],
  recommendedFaceShapes: ['OVAL', 'SQUARE'],
  supportsBangs: false,
  supportsFade: true,
};

const buzz: Candidate = {
  id: 'c-buzz',
  kind: 'buzz_cut',
  name: 'Buzz cut',
  gender: 'UNISEX',
  maintenance: 'LOW',
  supportedTextures: ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'],
  supportedLengths: ['VERY_SHORT'],
  supportedDensities: ['LOW', 'MEDIUM', 'HIGH'],
  recommendedFaceShapes: ['OVAL', 'SQUARE'],
  supportsBangs: false,
  supportsFade: false,
};

const ALL = [bob, wolf, fade, buzz];

describe('the weights', () => {
  /**
   * A set of weights summing to 95 turns every result into a slightly wrong
   * number that still looks exactly like a percentage, and nothing anywhere
   * would complain. This is the cheapest possible check and it catches a real
   * class of silent arithmetic bug.
   */
  it('adds up to 100, so a score is a percentage', () => {
    const total = Object.values(WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(100);
  });

  it('weights the face most and a stated preference least', () => {
    expect(WEIGHTS.face).toBeGreaterThan(WEIGHTS.texture);
    expect(WEIGHTS.texture).toBeGreaterThan(WEIGHTS.length);
    expect(WEIGHTS.preference).toBeLessThan(WEIGHTS.face);
  });
});

describe('texture — the one hard no', () => {
  /**
   * A blunt bob in coily hair is not a compromise, it is a different haircut,
   * and the 3D studio cannot even draw it. Everything else in this file is a
   * matter of degree; this has to be able to sink a style outright.
   */
  it('zeroes the texture factor when the style is not cut in that hair', () => {
    const result = scoreCandidate(bob, { texture: 'COILY' });
    const texture = result.factors.find((item) => item.key === 'texture');
    expect(texture?.fit).toBe(0);
    expect(texture?.points).toBe(0);
    expect(result.caution).toMatch(/coily/i);
  });

  it('ranks a style that suits the hair above one that cannot be cut in it', () => {
    const ranked = recommend([bob, wolf], { texture: 'CURLY', faceShape: 'OVAL' }, {}, { minScore: 0 });
    expect(ranked[0]?.kind).toBe('wolf_cut');
  });
});

describe('face shape', () => {
  const faceFit = (candidate: Candidate, shape: Parameters<typeof scoreCandidate>[1]['faceShape']) =>
    scoreCandidate(candidate, { faceShape: shape }).factors.find((f) => f.key === 'face')!.fit;

  it('scores a recommended shape above a neighbouring one, and that above a mismatch', () => {
    // wolf is advised for ROUND and SQUARE, so it has no oval bonus muddying it.
    const exact = faceFit(wolf, 'ROUND');
    const near = faceFit(wolf, 'HEART'); // HEART neighbours ROUND
    const off = faceFit(wolf, 'DIAMOND'); // shares nothing with ROUND or SQUARE
    expect(exact).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(off);
  });

  /**
   * THE OVAL ASYMMETRY, which the first version of this file got wrong by
   * listing OVAL as every shape's neighbour — making the mismatch tier
   * unreachable for any style advised for oval faces, and quietly turning a
   * 30-point factor into a near-binary one.
   *
   * The property is real but one-directional: a cut FOR oval faces is a decent
   * bet for anybody, and it is still not as good as a cut for her actual shape.
   */
  it('treats a cut for oval faces as a decent bet for anybody, but not a match', () => {
    const forHerShape = faceFit(wolf, 'ROUND');
    const ovalCut = faceFit(bob, 'SQUARE'); // bob is advised OVAL + HEART
    const trueMismatch = faceFit(wolf, 'DIAMOND');

    expect(ovalCut).toBeLessThan(forHerShape);
    expect(ovalCut).toBeGreaterThan(trueMismatch);
    expect(scoreCandidate(bob, { faceShape: 'SQUARE' }).factors.find((f) => f.key === 'face')!.note).toMatch(
      /most face shapes/i,
    );
  });

  /**
   * CONFIDENCE PULLS TOWARDS NEUTRAL, NOT TOWARDS ZERO.
   *
   * A 30%-confident guess from a blurry phone photo should barely move the
   * ranking. If low confidence instead PUNISHED every style the guess disagreed
   * with, one bad photograph would reorder the whole list — which is worse than
   * ignoring the photograph.
   */
  it('lets a hesitant reading barely move the score', () => {
    const certain = scoreCandidate(bob, { faceShape: 'SQUARE', faceShapeConfidence: 1 });
    const hesitant = scoreCandidate(bob, { faceShape: 'SQUARE', faceShapeConfidence: 0.2 });
    const blind = scoreCandidate(bob, {});

    const gap = (row: typeof certain) => Math.abs(row.factors.find((f) => f.key === 'face')!.fit - blind.factors.find((f) => f.key === 'face')!.fit);
    expect(gap(hesitant)).toBeLessThan(gap(certain));
  });

  /**
   * An unknown fact scores the middle. Scoring it zero would take the same 30
   * points off every style — the order would be identical and every match would
   * read in the fifties, making a working feature look broken.
   */
  it('does not punish a customer who uploaded no photo', () => {
    const result = scoreCandidate(bob, { texture: 'WAVY', length: 'MEDIUM', density: 'MEDIUM' });
    expect(result.score).toBeGreaterThan(70);
    expect(result.factors.find((item) => item.key === 'face')?.note).toMatch(/no photo/i);
  });
});

describe('length', () => {
  /**
   * Cutting hair off is one appointment; growing it is a year. A style that needs
   * MORE length than the customer has must be penalised harder than one that
   * needs less, or the advisor recommends a wig.
   */
  it('penalises growing out more than cutting down', () => {
    const needsGrowing = scoreCandidate(wolf, { length: 'VERY_SHORT' }).factors.find((f) => f.key === 'length')!;
    const needsCutting = scoreCandidate(bob, { length: 'VERY_LONG' }).factors.find((f) => f.key === 'length')!;
    expect(needsGrowing.fit).toBeLessThan(needsCutting.fit);
    expect(needsGrowing.note).toMatch(/grow/i);
  });

  it('gives full marks when the style works at the length she already has', () => {
    const factor = scoreCandidate(bob, { length: 'MEDIUM' }).factors.find((f) => f.key === 'length')!;
    expect(factor.fit).toBe(1);
    expect(factor.note).toMatch(/length you have/i);
  });

  it('prefers where she wants to end up over where she is now', () => {
    const factor = scoreCandidate(buzz, { length: 'LONG' }, { desiredLength: 'VERY_SHORT' }).factors.find(
      (f) => f.key === 'length',
    )!;
    // Her current long hair is irrelevant once she has said she wants it off.
    expect(factor.fit).toBe(1);
  });
});

describe('maintenance', () => {
  /**
   * The most common way a haircut recommendation fails in real life, and the one
   * nobody records: a cut that needs a salon visit every three weeks given to
   * somebody who will come twice a year.
   */
  it('penalises a style that needs more upkeep than she accepts', () => {
    const factor = scoreCandidate(fade, {}, { maintenance: 'LOW' }).factors.find((f) => f.key === 'maintenance')!;
    expect(factor.fit).toBeLessThan(1);
    expect(factor.note).toMatch(/more than you wanted/i);
  });

  /** The reverse is not a problem, so it is not symmetrically docked. */
  it('gives full marks to a style that needs less upkeep than she accepts', () => {
    const factor = scoreCandidate(buzz, {}, { maintenance: 'HIGH' }).factors.find((f) => f.key === 'maintenance')!;
    expect(factor.fit).toBe(1);
  });

  it('moves a low-upkeep style above a high-upkeep one when she asks for low', () => {
    const relaxed = recommend(ALL, { texture: 'STRAIGHT', faceShape: 'OVAL' }, {}, { minScore: 0, limit: 10 });
    const strict = recommend(
      ALL,
      { texture: 'STRAIGHT', faceShape: 'OVAL' },
      { maintenance: 'LOW' },
      { minScore: 0, limit: 10 },
    );
    const place = (list: typeof relaxed, kind: string) => list.findIndex((item) => item.kind === kind);
    expect(place(strict, 'buzz_cut')).toBeLessThan(place(relaxed, 'buzz_cut'));
  });
});

describe('preferences', () => {
  it('raises a style she has had before', () => {
    const without = scoreCandidate(wolf, { texture: 'WAVY' }).score;
    const withLike = scoreCandidate(wolf, { texture: 'WAVY' }, { likedKinds: ['wolf_cut'] }).score;
    expect(withLike).toBeGreaterThan(without);
  });

  it('demotes a style that cannot take the bangs she asked for', () => {
    const takes = scoreCandidate(bob, { texture: 'WAVY' }, { wantsBangs: true }).score;
    const cannot = scoreCandidate(buzz, { texture: 'WAVY' }, { wantsBangs: true }).score;
    expect(takes).toBeGreaterThan(cannot);
  });

  /**
   * Dislikes are REMOVED, not demoted. A customer who said "not a buzz cut" and
   * is shown a buzz cut fifth has not been listened to, whatever its score.
   */
  it('removes a disliked style entirely rather than ranking it low', () => {
    const ranked = recommend(ALL, { texture: 'STRAIGHT' }, { dislikedKinds: ['buzz_cut'] }, { minScore: 0, limit: 10 });
    expect(ranked.some((item) => item.kind === 'buzz_cut')).toBe(false);
  });

  /**
   * Only 10 points, on purpose. A recommender that merely reflects the request
   * back is a search box with extra steps, so a stated wish must not be able to
   * outrank hair the style cannot be cut in.
   */
  it('cannot make an impossible style win on a stated wish alone', () => {
    /*
     * CURLY, not COILY: wolf cannot be cut in coily hair either, so that version
     * of this test proved nothing except that the preference broke a tie between
     * two impossible styles. The point is a style she CAN have beating one she
     * cannot, with every preference stacked against it.
     */
    const ranked = recommend(
      [bob, wolf],
      { texture: 'CURLY' },
      { likedKinds: ['bob'], wantsBangs: true },
      { minScore: 0 },
    );
    expect(ranked[0]?.kind).toBe('wolf_cut');
  });
});

describe('recommend', () => {
  it('keeps unisex styles in a gendered list rather than hiding half the menu', () => {
    const ranked = recommend(ALL, { gender: 'MALE', texture: 'STRAIGHT' }, {}, { minScore: 0, limit: 10 });
    const kinds = ranked.map((item) => item.kind);
    expect(kinds).toContain('fade');
    expect(kinds).toContain('buzz_cut');
    expect(kinds).not.toContain('bob');
  });

  it('treats an unstated gender as no filter at all', () => {
    const ranked = recommend(ALL, { texture: 'STRAIGHT' }, {}, { minScore: 0, limit: 10 });
    expect(ranked.length).toBe(ALL.length);
  });

  /**
   * A five-slot list padded out with a 38% match teaches a stylist that the
   * numbers are decoration — and after that the 94% at the top means nothing
   * either. Fewer honest results beat five dishonest ones.
   */
  it('returns fewer than the limit rather than padding with bad matches', () => {
    const ranked = recommend(ALL, { texture: 'COILY', faceShape: 'OBLONG', length: 'VERY_LONG' }, { maintenance: 'LOW' });
    expect(ranked.length).toBeLessThan(ALL.length);
    for (const item of ranked) expect(item.score).toBeGreaterThanOrEqual(55);
  });

  it('is deterministic — the same inputs give the same order twice', () => {
    const profile = { texture: 'WAVY' as const, faceShape: 'OVAL' as const, length: 'MEDIUM' as const };
    const first = recommend(ALL, profile, {}, { minScore: 0, limit: 10 }).map((item) => item.catalogId);
    const second = recommend(ALL, profile, {}, { minScore: 0, limit: 10 }).map((item) => item.catalogId);
    expect(first).toEqual(second);
  });

  /**
   * The explanation is built FROM the score, so the words and the number cannot
   * disagree. A model asked to explain a ranking it did not compute writes
   * something plausible, and plausible is worse than terse when a stylist is
   * reading it out to a customer.
   */
  it('explains itself out of the factors that actually did the work', () => {
    const [top] = recommend([bob], { faceShape: 'OVAL', texture: 'WAVY', length: 'MEDIUM' }, {}, { minScore: 0 });
    expect(top?.reason).toMatch(/oval|wavy|length/i);
    expect(top?.factors.reduce((sum, item) => sum + item.points, 0)).toBeCloseTo(top!.score, 0);
  });

  it('cautions only on a real mismatch, not on a nuance', () => {
    const fine = scoreCandidate(bob, { faceShape: 'OVAL', texture: 'WAVY', length: 'MEDIUM', density: 'MEDIUM' });
    expect(fine.caution).toBeNull();
  });
});

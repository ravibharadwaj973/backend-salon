import type { FaceShape, Gender, HairDensity, HairLength, HairMaintenance, HairTexture } from '@prisma/client';
import { kindByKey } from './hairstyle-kinds';

/**
 * WHICH CUTS SUIT THIS PERSON, AND WHY.
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 *
 * THE APPLICATION OWNS THE RANKING. A language model may describe a face; it
 * does not get to decide what the salon is shown, and it certainly does not get
 * to decide it differently on Tuesday. Everything below is arithmetic over the
 * salon's own catalogue: pure, deterministic, offline, and the same answer every
 * time for the same inputs.
 *
 * That is not a stylistic preference. Three things follow from it that could not
 * be had otherwise:
 *
 *   A RECOMMENDATION CAN BE EXPLAINED. Every score decomposes into named factors
 *   with numbers attached, so "why is this at the top" has an answer the stylist
 *   can read and argue with. A model's prose cannot be audited and cannot be
 *   corrected.
 *
 *   IT WORKS WITH NO KEY, NO NETWORK AND NO BILL. The advisor is the feature most
 *   likely to be used on a phone in a salon with bad signal.
 *
 *   IT IS TESTABLE. A weighting that silently stops mattering is exactly the kind
 *   of bug that never raises an error, and this file is pinned by tests that
 *   assert the ORDER changes when the inputs do.
 *
 * ── The weights ───────────────────────────────────────────────────────────
 *
 * As specified, and they add to 100 — asserted in the tests, because a set of
 * weights that quietly sums to 95 turns every score into a slightly wrong
 * percentage that still looks like a percentage.
 */
export const WEIGHTS = {
  face: 30,
  texture: 25,
  length: 15,
  density: 10,
  preference: 10,
  maintenance: 10,
} as const;

export type FactorKey = keyof typeof WEIGHTS;

/** What we know, or have guessed, about the person in the chair. */
export interface HairProfile {
  faceShape?: FaceShape | null;
  /** 0-1, from the analysis. A low confidence must not carry a 30% weight. */
  faceShapeConfidence?: number | null;
  texture?: HairTexture | null;
  density?: HairDensity | null;
  /** What they have now, which is what a cut has to start from. */
  length?: HairLength | null;
  gender?: Gender | null;
}

/** What they say they want, which outranks what suits them. */
export interface HairPreferences {
  /** Where they would like to end up. */
  desiredLength?: HairLength | null;
  /** How much upkeep they will actually accept. */
  maintenance?: HairMaintenance | null;
  /** Styles they have asked for by name or saved before. */
  likedKinds?: string[];
  /** Styles they have ruled out. Removed from the list, not merely demoted. */
  dislikedKinds?: string[];
  wantsBangs?: boolean | null;
  wantsFade?: boolean | null;
}

/** One row of the salon's menu, as much of it as the scoring needs. */
export interface Candidate {
  id: string;
  kind: string;
  name: string;
  gender: Gender;
  category?: string | null;
  maintenance: HairMaintenance;
  /** Empty means "all of them": a salon that never answered has not refused. */
  supportedTextures: HairTexture[];
  supportedLengths: HairLength[];
  supportedDensities: HairDensity[];
  recommendedFaceShapes: FaceShape[];
  supportsBangs: boolean;
  supportsFade: boolean;
  serviceId?: string | null;
}

export interface Factor {
  key: FactorKey;
  /** 0-1, before the weight is applied. */
  fit: number;
  weight: number;
  /** Already weighted. The sum of these is the score. */
  points: number;
  /** Why, in words, or null when the factor had nothing to go on. */
  note: string | null;
}

export interface Recommendation {
  catalogId: string;
  kind: string;
  name: string;
  /** 0-100, rounded. Presented as a percentage match. */
  score: number;
  factors: Factor[];
  /** One or two sentences a stylist can read out. */
  reason: string;
  /** Said out loud rather than hidden, when something genuinely does not fit. */
  caution: string | null;
}

// ------------------------------------------------------------ face shapes ---

/**
 * HOW CLOSE IS THIS FACE TO THE ONES THE CUT IS MEANT FOR?
 *
 * Not a yes/no. Face shapes are a continuum that hairdressing has cut into six
 * names, and adjacent names behave almost identically: a cut that suits a square
 * face does not become wrong for an oblong one, it becomes slightly less
 * obviously right. Scoring that as zero would push good recommendations off a
 * top-five list on the strength of one noisy guess from a photograph.
 *
 * ── The oval asymmetry, which a test caught me getting wrong ───────────────
 *
 * The first version of this listed OVAL as every shape's neighbour, on the
 * received wisdom that almost everything suits an oval face. That wisdom is
 * sound and the encoding was not, because the relation is NOT symmetric and this
 * table is read in one direction only: `NEIGHBOURS[theirFace]` asks "what else is
 * this face like". Putting OVAL in all six lists therefore said something quite
 * different — that any cut advised for oval faces is a near-match for EVERY face
 * — which collapsed the mismatch tier into the neighbour tier and made the whole
 * 30-point factor nearly binary. Two tiers that are always equal is a weighting
 * that has silently stopped working, and nothing would have raised an error.
 *
 * So the two ideas are now separate: this table is genuine shape similarity, and
 * the broadly-flattering property of an oval-advised cut is its own rule below,
 * scored between an exact match and a neighbour. OVAL's own row keeps all five,
 * which is the asymmetry stated correctly: an oval face is a near-match for most
 * cuts, while a cut for oval faces is merely a decent bet for everyone.
 */
const NEIGHBOURS: Record<FaceShape, FaceShape[]> = {
  OVAL: ['ROUND', 'OBLONG', 'HEART', 'DIAMOND', 'SQUARE'],
  ROUND: ['SQUARE', 'HEART'],
  SQUARE: ['ROUND', 'OBLONG'],
  OBLONG: ['SQUARE', 'DIAMOND'],
  HEART: ['ROUND', 'DIAMOND'],
  DIAMOND: ['HEART', 'OBLONG'],
};

/** A cut advised for oval faces is a decent bet for anybody. Not a match. */
const OVAL_BONUS = 0.75;

const LENGTH_ORDER: HairLength[] = ['VERY_SHORT', 'SHORT', 'MEDIUM', 'LONG', 'VERY_LONG'];
const DENSITY_ORDER: HairDensity[] = ['LOW', 'MEDIUM', 'HIGH'];
const MAINTENANCE_ORDER: HairMaintenance[] = ['LOW', 'MEDIUM', 'HIGH'];

const WORDS: Record<string, string> = {
  VERY_SHORT: 'very short',
  SHORT: 'short',
  MEDIUM: 'medium',
  LONG: 'long',
  VERY_LONG: 'very long',
  STRAIGHT: 'straight',
  WAVY: 'wavy',
  CURLY: 'curly',
  COILY: 'coily',
  LOW: 'low',
  HIGH: 'high',
  OVAL: 'oval',
  ROUND: 'round',
  SQUARE: 'square',
  OBLONG: 'oblong',
  HEART: 'heart-shaped',
  DIAMOND: 'diamond',
};
const word = (value: string | null | undefined) => (value ? (WORDS[value] ?? value.toLowerCase()) : '');

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * An unknown factor scores the middle, not zero.
 *
 * This is the most consequential line in the file. A customer who has uploaded
 * no photograph knows nothing about their face shape, and scoring that as 0
 * would take 30 points off EVERY style equally — which does not change the
 * order, but does turn every match into a number in the fifties and make the
 * whole feature look broken. Scoring it as neutral keeps the percentages honest:
 * they say "on what we know", and what we know is listed beside them.
 */
const NEUTRAL = 0.6;

function faceFit(candidate: Candidate, profile: HairProfile): Factor {
  const shape = profile.faceShape;
  const advised = candidate.recommendedFaceShapes.length
    ? candidate.recommendedFaceShapes
    : (kindByKey(candidate.kind)?.faceShapes ?? []);

  if (!shape || advised.length === 0) {
    return factor('face', NEUTRAL, shape ? null : 'No photo yet, so face shape is not part of this score');
  }

  /*
   * Confidence scales the factor towards neutral rather than towards zero. A
   * 40%-confident guess at a face shape should barely move the ranking; it
   * should not actively punish every cut that the guess disagrees with.
   */
  const confidence = clamp01(profile.faceShapeConfidence ?? 1);

  const exact = advised.includes(shape);
  const neighbour = advised.some((item) => NEIGHBOURS[shape].includes(item));
  const broadlyFlattering = advised.includes('OVAL');

  const raw = exact ? 1 : broadlyFlattering ? OVAL_BONUS : neighbour ? 0.65 : 0.25;
  const fit = NEUTRAL + (raw - NEUTRAL) * confidence;

  return factor(
    'face',
    fit,
    exact
      ? `Suits a ${word(shape)} face`
      : broadlyFlattering
        ? 'Cut to suit most face shapes'
        : neighbour
          ? `Close to what suits a ${word(shape)} face`
          : `Usually cut for ${advised.map((item) => word(item)).join(' or ')} faces rather than ${word(shape)}`,
  );
}

function textureFit(candidate: Candidate, profile: HairProfile): Factor {
  const texture = profile.texture;
  if (!texture) return factor('texture', NEUTRAL, null);

  const allowed = candidate.supportedTextures.length
    ? candidate.supportedTextures
    : (kindByKey(candidate.kind)?.textures ?? []);
  if (allowed.length === 0) return factor('texture', NEUTRAL, null);

  if (allowed.includes(texture)) return factor('texture', 1, `Cut for ${word(texture)} hair`);

  /*
   * A texture the style cannot be cut in is the one hard no in this file.
   *
   * Everything else here is a matter of degree; this is not. A blunt line in
   * coily hair is not a compromise, it is a different haircut — and the studio
   * cannot even draw it, so recommending it would produce a configurator that
   * silently ignores the customer's own hair.
   */
  return factor('texture', 0, `Not cut in ${word(texture)} hair`);
}

/**
 * HOW BIG A JUMP IS THIS FROM WHAT THEY HAVE?
 *
 * Scored on distance, and the asymmetry is the point: cutting hair off is one
 * appointment, growing it is a year. A customer with short hair being
 * recommended a very long cut is not being given advice, they are being sold a
 * wig — so a style that needs MORE length than they have is penalised harder
 * than one that needs less.
 */
function lengthFit(candidate: Candidate, profile: HairProfile, preferences: HairPreferences): Factor {
  // Where they want to end up beats where they are. If they have said.
  const target = preferences.desiredLength ?? null;
  const current = profile.length ?? null;
  if (!target && !current) return factor('length', NEUTRAL, null);

  const allowed = candidate.supportedLengths.length
    ? candidate.supportedLengths
    : (kindByKey(candidate.kind)?.lengths ?? LENGTH_ORDER);

  if (target) {
    const fit = allowed.includes(target) ? 1 : 0.2;
    return factor('length', fit, fit === 1 ? `Available at ${word(target)} length` : `Not offered ${word(target)}`);
  }

  const have = LENGTH_ORDER.indexOf(current!);
  // The closest length this style is offered at, in steps away from today.
  let best = 99;
  let bestLength: HairLength = allowed[0] ?? 'MEDIUM';
  for (const option of allowed) {
    const steps = LENGTH_ORDER.indexOf(option) - have;
    const cost = steps > 0 ? steps * 1.8 : -steps;
    if (cost < best) {
      best = cost;
      bestLength = option;
    }
  }

  const fit = clamp01(1 - best / 4);
  const needsGrowing = LENGTH_ORDER.indexOf(bestLength) > have;
  return factor(
    'length',
    fit,
    best === 0
      ? 'Works at the length you have now'
      : needsGrowing
        ? `Needs growing out to ${word(bestLength)}`
        : `Cuts down to ${word(bestLength)}`,
  );
}

function densityFit(candidate: Candidate, profile: HairProfile): Factor {
  const density = profile.density;
  if (!density) return factor('density', NEUTRAL, null);

  const allowed = candidate.supportedDensities.length
    ? candidate.supportedDensities
    : (kindByKey(candidate.kind)?.densities ?? DENSITY_ORDER);
  if (allowed.length === 0) return factor('density', NEUTRAL, null);
  if (allowed.includes(density)) return factor('density', 1, `Works with ${word(density)}-density hair`);

  // Softer than texture: a style cut mostly for thick hair still works on
  // average hair, it just sits differently.
  const steps = Math.min(...allowed.map((item) => Math.abs(DENSITY_ORDER.indexOf(item) - DENSITY_ORDER.indexOf(density))));
  return factor('density', clamp01(1 - steps * 0.45), `Usually cut on ${allowed.map((i) => word(i)).join(' or ')} density`);
}

/**
 * WHAT THEY ASKED FOR, WHICH IS NOT THE SAME AS WHAT SUITS THEM.
 *
 * Deliberately only 10 points, and deliberately not zero. A customer who has
 * said "I want bangs" should see styles with bangs rise, and should still be
 * shown the thing that actually suits their hair — a recommender that only
 * reflects the request back is a search box with extra steps.
 */
function preferenceFit(candidate: Candidate, preferences: HairPreferences): Factor {
  const liked = preferences.likedKinds ?? [];
  const notes: string[] = [];
  let fit = NEUTRAL;

  if (liked.includes(candidate.kind)) {
    fit = 1;
    notes.push('One you have liked before');
  }
  if (preferences.wantsBangs === true) {
    fit = candidate.supportsBangs ? Math.max(fit, 0.95) : Math.min(fit, 0.25);
    notes.push(candidate.supportsBangs ? 'Takes the bangs you wanted' : 'Cannot take bangs');
  }
  if (preferences.wantsFade === true) {
    fit = candidate.supportsFade ? Math.max(fit, 0.95) : Math.min(fit, 0.25);
    notes.push(candidate.supportsFade ? 'Takes the fade you wanted' : 'Has no fade');
  }

  return factor('preference', fit, notes.length ? notes.join('; ') : null);
}

/**
 * UPKEEP, AND WHY IT IS ONLY EVER PENALISED IN ONE DIRECTION.
 *
 * A customer who will accept LOW maintenance and is shown a cut needing a salon
 * visit every three weeks has been given the wrong answer, however well it suits
 * their face — this is the single most common way a haircut recommendation fails
 * in real life, and nobody records it.
 *
 * The reverse is not a problem at all. Somebody willing to come in monthly is
 * not harmed by a cut that needs nothing, so a lower-maintenance style than
 * asked for scores full marks rather than being symmetrically docked.
 */
function maintenanceFit(candidate: Candidate, preferences: HairPreferences): Factor {
  const accepted = preferences.maintenance;
  if (!accepted) return factor('maintenance', NEUTRAL, null);

  const wanted = MAINTENANCE_ORDER.indexOf(accepted);
  const needs = MAINTENANCE_ORDER.indexOf(candidate.maintenance);

  if (needs <= wanted) {
    return factor('maintenance', 1, needs < wanted ? 'Less upkeep than you asked for' : 'Matches the upkeep you accept');
  }
  return factor(
    'maintenance',
    clamp01(1 - (needs - wanted) * 0.5),
    `Needs ${word(candidate.maintenance)} upkeep, more than you wanted`,
  );
}

function factor(key: FactorKey, fit: number, note: string | null): Factor {
  const bounded = clamp01(fit);
  return { key, fit: bounded, weight: WEIGHTS[key], points: bounded * WEIGHTS[key], note };
}

// --------------------------------------------------------------- scoring ----

export function scoreCandidate(
  candidate: Candidate,
  profile: HairProfile,
  preferences: HairPreferences = {},
): Recommendation {
  const factors = [
    faceFit(candidate, profile),
    textureFit(candidate, profile),
    lengthFit(candidate, profile, preferences),
    densityFit(candidate, profile),
    preferenceFit(candidate, preferences),
    maintenanceFit(candidate, preferences),
  ];

  const score = Math.round(factors.reduce((total, item) => total + item.points, 0));

  /**
   * The explanation is BUILT FROM THE SCORE, not written about it.
   *
   * Two sentences from the two factors that actually did the most work, so the
   * words and the number can never disagree. A model asked to explain a ranking
   * it did not compute writes something plausible, and plausible is worse than
   * terse here: a stylist reads it to a customer.
   */
  const spoken = factors.filter((item) => item.note);
  const strong = [...spoken].sort((a, b) => b.points - a.points).filter((item) => item.fit >= 0.6).slice(0, 2);
  const weak = [...spoken].sort((a, b) => a.fit - b.fit)[0];

  const reason = strong.length
    ? `${strong.map((item) => item.note).join('. ')}.`
    : 'Scored on your salon’s own menu; add a photo for a sharper match.';

  return {
    catalogId: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    score,
    factors,
    reason,
    // Only a genuine mismatch earns a caution. A factor at 0.5 is a nuance, and
    // flagging nuances trains people to ignore the flag.
    caution: weak && weak.fit <= 0.3 ? weak.note : null,
  };
}

export interface RecommendOptions {
  limit?: number;
  /** Below this, say nothing rather than padding the list out. */
  minScore?: number;
}

/**
 * The salon's menu, ranked.
 *
 * Returns FEWER than `limit` when fewer than `limit` styles actually fit. A
 * five-slot list padded with a 38% match teaches a stylist that the numbers are
 * decoration, and after that the 94% at the top means nothing either.
 */
export function recommend(
  candidates: Candidate[],
  profile: HairProfile,
  preferences: HairPreferences = {},
  options: RecommendOptions = {},
): Recommendation[] {
  const disliked = new Set(preferences.dislikedKinds ?? []);

  const pool = candidates.filter((candidate) => {
    if (disliked.has(candidate.kind)) return false;
    /*
     * Gender filters, and UNISEX belongs in everybody's list.
     *
     * A filter that hid unisex styles would remove half the menu from both
     * lists, which is the opposite of the intent. OTHER is treated as no filter
     * at all: it is a field about a person, not an instruction about haircuts.
     */
    if (profile.gender === 'MALE' || profile.gender === 'FEMALE') {
      return candidate.gender === profile.gender || candidate.gender === 'UNISEX';
    }
    return true;
  });

  return pool
    .map((candidate) => scoreCandidate(candidate, profile, preferences))
    .filter((item) => item.score >= (options.minScore ?? 55))
    .sort((a, b) =>
      // Name as the final tiebreak, so two identically-scored styles do not swap
      // places between requests and make the list look unstable.
      b.score - a.score || a.name.localeCompare(b.name),
    )
    .slice(0, options.limit ?? 5);
}

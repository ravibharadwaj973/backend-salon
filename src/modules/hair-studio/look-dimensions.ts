/**
 * THE DIMENSIONS A LOOK IS MADE OF, AND THE RULES BETWEEN THEM.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ten dimensions, in two groups, and one derived eleventh.
 *
 *   WHAT WE READ OFF THE CUSTOMER          WHAT A LOOK IS MADE OF
 *   ─────────────────────────────          ──────────────────────
 *   1. Face profile                        4. Haircut
 *   2. Hair profile                        5. Length
 *   3. Preference and context              6. Bangs
 *                                          7. Finish
 *                                          8. Base colour
 *                                          9. Colour technique
 *                                         10. Colour placement
 *
 *                      ↓ derived from all ten ↓
 *                 11. Commitment — sessions, bleach, upkeep
 *
 * A COMPLETE LOOK is one value from each of dimensions 4-10. It is not an
 * eleventh category; it is a point in a seven-dimensional space, which is why
 * `HairstyleCatalog` can hold thousands of them without thousands of generators.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS THE RELATIONS AND NOT JUST THE LISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ten enumerations are a morning's work and they are not the hard part. The hard
 * part is that the dimensions are not independent, and a product that treats
 * them as independent offers its users a cross-product of which a large fraction
 * is professionally meaningless. Four examples, each encoded below:
 *
 *   A technique does not have a free choice of placement. "Global colour applied
 *   to the ends" is not a service. `PLACEMENTS_FOR_TECHNIQUE` is therefore a map
 *   rather than a pair of dropdowns.
 *
 *   A finish is not a free choice either — it is a relation to the hair the
 *   customer already has. Coily hair worn sleek is a chemical service with a
 *   price, a duration and a cost in condition; straight hair worn in defined
 *   curls is not deliverable at all. `finishFeasibility` returns which of those
 *   four answers it is, because "unavailable" and "available, as a chemical
 *   service, for four hours and ₹6000" are different sentences.
 *
 *   A colour is reachable or it is not, and "not in one visit" is the common
 *   case rather than the edge case. Black to blonde is two or three
 *   appointments. The customer is entitled to that number before she agrees,
 *   not after. `sessionsToReach`.
 *
 *   Condition gates colour absolutely. Bleach on hair that is already damaged
 *   is a refusal, not a low-ranked recommendation. `colourFeasibility` returns a
 *   hard no, and nothing downstream is permitted to rank its way around it.
 *
 * Pure, with no imports but types, for the same reason as `design-rules.ts`: the
 * configurator, the API, the recommendation engine and a test all need the same
 * answers, and none of them should need a database to get one.
 */

import type { FaceShape, HairDensity, HairLength, HairTexture } from '@prisma/client';

// ═════════════════════════════════════════════ 1. FACE PROFILE ═════════════
/**
 * DELIBERATELY TWO FIELDS, NOT FIVE.
 *
 * The obvious version of this dimension records face shape, proportions,
 * jawline, forehead and length-to-width ratio. Three of those five are not
 * independent of the first: "square jawline" is most of what SQUARE means,
 * length-to-width is most of what distinguishes OBLONG from ROUND, and
 * proportions are the thing face shape is a summary OF. Recording them
 * separately produces a form a stylist fills in by eye, with four fields that
 * can disagree with each other and no rule for which one wins.
 *
 * Forehead height is the exception and earns its place: it is genuinely
 * independent of face shape, and it is the single most common reason a stylist
 * recommends a fringe. It is also the only one of the five a customer herself
 * will raise unprompted.
 */
export const FOREHEADS = ['LOW', 'AVERAGE', 'HIGH'] as const;
export type Forehead = (typeof FOREHEADS)[number];

// ═════════════════════════════════════════════ 2. HAIR PROFILE ═════════════
/**
 * CONDITION, WHICH NOTHING IN THIS CODEBASE RECORDED UNTIL NOW.
 *
 * It belongs with texture and density as a reading of the hair the customer
 * walked in with, and it is the only one of the three that can make an answer
 * NO rather than merely unsuitable. See `colourFeasibility`.
 *
 * Four values because a stylist can tell these apart by touch in a second, and
 * because the boundary that matters — can this take bleach — falls between
 * NORMAL and POROUS.
 */
export const CONDITIONS = ['HEALTHY', 'NORMAL', 'POROUS', 'DAMAGED'] as const;
export type HairCondition = (typeof CONDITIONS)[number];

/**
 * WHAT THE HAIR ALREADY IS, AS A LEVEL RATHER THAN A NAME.
 *
 * The industry's 1-10 scale, which is the only representation in which "how far
 * is it from here to there" is a subtraction. A customer says "dark brown" and a
 * colourist hears "level 3", and the difference between those two sentences is
 * the whole of `sessionsToReach`.
 *
 * Previously treated colour: a separate boolean, because it changes the answer
 * independently of the level. Box dye at level 3 and virgin hair at level 3 lift
 * differently and unpredictably, and a salon that does not ask gets a surprise
 * in the bowl.
 */
export const COLOR_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type ColorLevel = (typeof COLOR_LEVELS)[number];

// ══════════════════════════════════════ 3. PREFERENCE AND CONTEXT ══════════
export const DESIRED_LOOKS = [
  'NATURAL',
  'MODERN',
  'BOLD',
  'ELEGANT',
  'TRENDY',
  'PROFESSIONAL',
  'EDGY',
] as const;
export type DesiredLook = (typeof DESIRED_LOOKS)[number];

/**
 * OCCASION, AND WHY IT ATTACHES TO THE FINISH RATHER THAN THE LOOK.
 *
 * A haircut is almost never occasion-specific — the same lob goes to an office
 * and to a wedding — so filtering the CUT library by occasion returns nearly
 * everything and teaches people the filter does nothing. What actually changes
 * for a wedding is dimension 7: the finish. So occasion is kept, and it ranks
 * finishes rather than cuts.
 */
export const OCCASIONS = ['EVERYDAY', 'OFFICE', 'PARTY', 'WEDDING', 'BRIDAL', 'VACATION', 'PHOTOSHOOT'] as const;
export type Occasion = (typeof OCCASIONS)[number];

// ═════════════════════════════════════════════ 4. HAIRCUT ══════════════════
/**
 * The cut itself lives in `hairstyle-kinds.ts`, which is the generator registry
 * and the one place a cut may be named. This dimension is the FAMILY above it:
 * what a customer asks for out loud, and what the look-book groups by.
 *
 * U-cut and V-cut are listed because this is the Indian market and they are
 * ordered by name here far more often than "layered cut" is; the kind registry
 * does not have generators for them yet, which is a gap this file makes visible
 * rather than one it hides.
 */
export const CUT_FAMILIES = [
  'BOB',
  'LOB',
  'LAYERS',
  'BUTTERFLY',
  'U_CUT',
  'V_CUT',
  'WOLF',
  'PIXIE',
  'SHAG',
  'BLUNT',
  'ONE_LENGTH',
  /** Men's structural cuts. Not "layers" by another name — see FADES. */
  'FADE',
  'TAPER',
  'UNDERCUT',
  'CROP',
  'QUIFF',
  'POMPADOUR',
  'BUZZ',
] as const;
export type CutFamily = (typeof CUT_FAMILIES)[number];

// ═════════════════════════════════════════════ 5. LENGTH ═══════════════════
/**
 * UNCHANGED AT FIVE VALUES, AND THE SIXTH IS DECLINED ON PURPOSE.
 *
 * The obvious list adds "shoulder" between medium and long. Parlon's MEDIUM is
 * already defined to the collarbone — see LENGTH in `hair-prompt.ts`, where every
 * length is pinned to a landmark on the body rather than to a word — and the
 * distance from shoulder to collarbone is about two inches. A sixth enum value
 * on a live Postgres enum, in every filter and every prompt, is a real cost; two
 * inches already covered by the landmark wording is not a real benefit.
 */
export { type HairLength };

// ═════════════════════════════════════════════ 6. BANGS ════════════════════
/**
 * Its own dimension because the same cut exists with and without them, and
 * because a fringe is the single change most likely to be regretted — which
 * makes it the one most worth previewing before it is cut.
 *
 * BOTTLENECK is added to the set in `design-rules.ts`; it is a distinct shape
 * (narrow at the eye, widening at the cheek) rather than a variant of curtain,
 * and it is asked for by name.
 */
export const FRINGES = ['NONE', 'CURTAIN', 'BOTTLENECK', 'FULL', 'SIDE_SWEPT', 'WISPY', 'MICRO'] as const;
export type Fringe = (typeof FRINGES)[number];

/**
 * WHAT A FRINGE IS FOR, which is what makes this a recommendation and not a
 * decoration. A high forehead is the commonest reason to suggest one, and a low
 * one is a reason to warn against a full fringe.
 */
export const FRINGES_FOR_FOREHEAD: Record<Forehead, readonly Fringe[]> = {
  HIGH: ['CURTAIN', 'FULL', 'BOTTLENECK', 'SIDE_SWEPT'],
  AVERAGE: ['NONE', 'CURTAIN', 'BOTTLENECK', 'SIDE_SWEPT', 'WISPY', 'MICRO'],
  // A full fringe on a low forehead leaves almost no face, and micro bangs even
  // less. Said here once so that no screen has to remember it.
  LOW: ['NONE', 'SIDE_SWEPT', 'WISPY', 'CURTAIN'],
};

// ═════════════════════════════════════════════ 7. FINISH ═══════════════════
/**
 * HOW THE HAIR IS WORN, AS AGAINST WHAT TEXTURE IT IS.
 *
 * ── The collision this name exists to end ─────────────────────────────────
 *
 * "Texture" was doing two jobs in this codebase and in every list of these
 * dimensions I have seen. On a catalogue entry, `supportedTextures` means which
 * NATURAL hair a cut works on. In a design, texture was read as the finished
 * look. Those are different dimensions with a service between them, and one word
 * for both is how a salon ends up promising a coily-haired customer a sleek bob
 * without anyone having decided to sell her a relaxer.
 *
 * So: natural texture keeps `HairTexture` and belongs to the customer.
 * The finish is this enum and belongs to the look.
 */
export const FINISHES = [
  'SLEEK',
  'STRAIGHT',
  'BLOWOUT',
  'SOFT_WAVES',
  'BEACH_WAVES',
  'CURLS',
  'DEFINED_CURLS',
  'TEXTURED',
] as const;
export type Finish = (typeof FINISHES)[number];

/**
 * What it costs to get from the hair somebody has to the hair in the picture.
 *
 *   NATURAL   her own hair, dry it and go. No service, no upkeep.
 *   STYLING   a blow-dry, irons or a wand. Per visit, and gone after a wash.
 *   CHEMICAL  a perm, a relaxer or keratin. Lasting, priced, and it spends
 *             condition — which is why `finishFeasibility` reports it rather
 *             than quietly allowing it.
 *   NO        not honestly deliverable. Defined curls do not survive on
 *             straight hair, whatever is sprayed on them.
 */
export const EFFORTS = ['NATURAL', 'STYLING', 'CHEMICAL', 'NO'] as const;
export type Effort = (typeof EFFORTS)[number];

const FINISH_FROM_TEXTURE: Record<HairTexture, Record<Finish, Effort>> = {
  STRAIGHT: {
    SLEEK: 'NATURAL',
    STRAIGHT: 'NATURAL',
    BLOWOUT: 'STYLING',
    SOFT_WAVES: 'STYLING',
    BEACH_WAVES: 'STYLING',
    TEXTURED: 'STYLING',
    CURLS: 'CHEMICAL',
    // The one hard no on this row. Defined curls are a curl PATTERN; straight
    // hair has none to define, and a perm produces curls rather than definition.
    DEFINED_CURLS: 'NO',
  },
  WAVY: {
    SOFT_WAVES: 'NATURAL',
    BEACH_WAVES: 'NATURAL',
    TEXTURED: 'NATURAL',
    STRAIGHT: 'STYLING',
    SLEEK: 'STYLING',
    BLOWOUT: 'STYLING',
    CURLS: 'STYLING',
    DEFINED_CURLS: 'CHEMICAL',
  },
  CURLY: {
    CURLS: 'NATURAL',
    DEFINED_CURLS: 'NATURAL',
    TEXTURED: 'NATURAL',
    SOFT_WAVES: 'STYLING',
    BEACH_WAVES: 'STYLING',
    BLOWOUT: 'STYLING',
    STRAIGHT: 'CHEMICAL',
    SLEEK: 'CHEMICAL',
  },
  COILY: {
    DEFINED_CURLS: 'NATURAL',
    CURLS: 'NATURAL',
    TEXTURED: 'NATURAL',
    // Everything smooth is chemical on coily hair, blowouts included: a silk
    // press is a thermal service with a real cost in condition, and calling it
    // "styling" is how it ends up unpriced and done on a damaged head.
    BLOWOUT: 'CHEMICAL',
    STRAIGHT: 'CHEMICAL',
    SLEEK: 'CHEMICAL',
    SOFT_WAVES: 'CHEMICAL',
    BEACH_WAVES: 'CHEMICAL',
  },
};

export function finishFeasibility(natural: HairTexture, finish: Finish): Effort {
  return FINISH_FROM_TEXTURE[natural][finish];
}

/**
 * The finishes worth putting in front of somebody, in the order they should
 * appear: her own hair first, then what a blow-dry achieves, then what a
 * chemical service does. Never the impossible one.
 */
export function finishesFor(natural: HairTexture): { finish: Finish; effort: Effort }[] {
  const rank: Record<Effort, number> = { NATURAL: 0, STYLING: 1, CHEMICAL: 2, NO: 3 };
  return FINISHES.map((finish) => ({ finish, effort: finishFeasibility(natural, finish) }))
    .filter((row) => row.effort !== 'NO')
    .sort((a, b) => rank[a.effort] - rank[b.effort]);
}

// ═════════════════════════════════════════ 8. BASE COLOUR ══════════════════
/**
 * The named shades a salon sells, each pinned to a LEVEL.
 *
 * The level is the point. A name is what a customer says and a level is what
 * decides whether the thing she said is one appointment or three, so every shade
 * carries one and nothing downstream has to guess.
 */
export const BASE_COLORS = [
  { key: 'BLACK', label: 'Black', level: 1 },
  { key: 'SOFT_BLACK', label: 'Soft black', level: 2 },
  { key: 'ESPRESSO', label: 'Espresso', level: 2 },
  { key: 'DARK_BROWN', label: 'Dark brown', level: 3 },
  { key: 'CHOCOLATE', label: 'Chocolate brown', level: 4 },
  { key: 'CHESTNUT', label: 'Chestnut', level: 5 },
  { key: 'CARAMEL', label: 'Caramel', level: 6 },
  { key: 'COPPER', label: 'Copper', level: 6 },
  { key: 'BURGUNDY', label: 'Burgundy', level: 4 },
  { key: 'DARK_BLONDE', label: 'Dark blonde', level: 7 },
  { key: 'BLONDE', label: 'Blonde', level: 8 },
  { key: 'LIGHT_BLONDE', label: 'Light blonde', level: 9 },
  { key: 'PLATINUM', label: 'Platinum', level: 10 },
  /**
   * GREY IS NOT A LEVEL, it is a state of the hair.
   *
   * Level 10 by luminance and nothing like platinum to work with: it has no
   * pigment to lift and it takes colour unevenly. Marked rather than scored, so
   * that `sessionsToReach` is not asked a question it would answer wrongly.
   */
  { key: 'GREY', label: 'Grey / silver', level: 10, isGrey: true },
  /** Violet, blue, pink. A statement, and it needs a pale canvas first. */
  { key: 'FASHION', label: 'Fashion shade', level: 9, needsPreLift: true },
] as const;

export type BaseColorKey = (typeof BASE_COLORS)[number]['key'];

export const baseColor = (key: BaseColorKey) => BASE_COLORS.find((row) => row.key === key)!;

// ═════════════════════════════════════ 9. COLOUR TECHNIQUE ═════════════════
/** HOW the colour is put on. */
export const COLOR_TECHNIQUES = [
  'GLOBAL',
  'ROOT',
  'HIGHLIGHTS',
  'LOWLIGHTS',
  'BABYLIGHTS',
  'BALAYAGE',
  'OMBRE',
  'COLOR_MELT',
] as const;
export type ColorTechnique = (typeof COLOR_TECHNIQUES)[number];

// ═════════════════════════════════ 10. COLOUR PLACEMENT ════════════════════
/** WHERE it appears. */
export const COLOR_PLACEMENTS = [
  'FULL',
  'ROOTS',
  'CROWN',
  'FACE_FRAMING',
  'MONEY_PIECE',
  'MIDS_TO_ENDS',
  'ENDS',
  'UNDERLAYER',
  'HIDDEN',
  'PANELS',
] as const;
export type ColorPlacement = (typeof COLOR_PLACEMENTS)[number];

/**
 * TECHNIQUE × PLACEMENT IS NOT A GRID.
 *
 * Eight techniques by ten placements is eighty combinations, and roughly half of
 * them name nothing a colourist could do. Global colour has no placement — it is
 * the whole head by definition. Ombre's placement is what ombre MEANS. Offering
 * the full cross-product in two dropdowns is how a professional tool loses the
 * professionals using it, in the first five minutes, permanently.
 *
 * Note where "money piece" sits. It is commonly listed as a technique; it is a
 * PLACEMENT — a brightened section at the front — and the technique producing it
 * is foils or babylights. Listing it among the techniques makes the two
 * dimensions overlap and leaves a UI that can express the same thing twice.
 */
export const PLACEMENTS_FOR_TECHNIQUE: Record<ColorTechnique, readonly ColorPlacement[]> = {
  // By definition the whole head. One legal placement, so no choice is offered.
  GLOBAL: ['FULL'],
  ROOT: ['ROOTS'],
  HIGHLIGHTS: ['FULL', 'CROWN', 'FACE_FRAMING', 'MONEY_PIECE', 'UNDERLAYER', 'HIDDEN', 'PANELS'],
  // Lowlights add depth, which is pointless at the ends and invisible at the
  // face — they go through the body of the hair or underneath it.
  LOWLIGHTS: ['FULL', 'CROWN', 'UNDERLAYER', 'PANELS'],
  // Fine and soft by construction: a babylight panel would be neither.
  BABYLIGHTS: ['FULL', 'CROWN', 'FACE_FRAMING', 'MONEY_PIECE'],
  BALAYAGE: ['MIDS_TO_ENDS', 'ENDS', 'FACE_FRAMING', 'FULL', 'PANELS'],
  // Ombre IS a placement — graduated into the ends. The only variable is how
  // high it starts.
  OMBRE: ['ENDS', 'MIDS_TO_ENDS'],
  COLOR_MELT: ['FULL', 'MIDS_TO_ENDS'],
};

export function placementAllowed(technique: ColorTechnique, placement: ColorPlacement): boolean {
  return PLACEMENTS_FOR_TECHNIQUE[technique].includes(placement);
}

/**
 * Whether the technique requires lifting the hair's own pigment — which is the
 * question condition gets to veto.
 *
 * Lowlights and root colour deposit; they are safe on hair that could not take
 * bleach, and that makes them the honest alternative to offer rather than a
 * flat refusal.
 */
export const LIFTS: Record<ColorTechnique, boolean> = {
  GLOBAL: false,
  ROOT: false,
  LOWLIGHTS: false,
  COLOR_MELT: false,
  HIGHLIGHTS: true,
  BABYLIGHTS: true,
  BALAYAGE: true,
  OMBRE: true,
};

// ═════════════════════════════════════ 11. COMMITMENT (derived) ════════════
/**
 * WHAT THE LOOK ACTUALLY COSTS HER, IN VISITS AND IN WEEKS.
 *
 * Derived rather than chosen, which is why it is not one of the ten. It is also
 * the dimension that decides whether a recommendation is any good: a look the
 * customer will not come back to maintain is a look that is wrong for her,
 * however well it suits her face, and a salon that sells it gets one visit and a
 * disappointed customer.
 *
 * Every number here is said to her BEFORE she agrees. That is the whole purpose
 * of computing it.
 */
export interface Commitment {
  /** Appointments to reach the look from the hair she has now. */
  sessions: number;
  /** Whether getting there lifts pigment, with everything that implies. */
  needsLift: boolean;
  /** Weeks until it needs attention. Null when nothing needs doing. */
  upkeepWeeks: number | null;
  /** Why it is as many sessions as it is, in words a customer can hear. */
  reasons: string[];
}

/**
 * HOW MANY VISITS, AND WHY THAT IS NOT ALWAYS ONE.
 *
 * Four levels of lift in a sitting is the professional rule of thumb; past that
 * the hair is being asked for more than it has. Going DARKER is one session
 * almost regardless of distance, which is the asymmetry that surprises customers
 * and is worth encoding rather than explaining each time.
 */
export function sessionsToReach(
  from: { level: ColorLevel | number; isGrey?: boolean; previouslyColored?: boolean },
  to: BaseColorKey,
): { sessions: number; reasons: string[] } {
  const target = baseColor(to);
  const reasons: string[] = [];

  if (target.key === 'GREY') {
    // Not a lift to a level: it is a bleach to near-white and then a toner, and
    // it is the one target where "how far" is the wrong question.
    reasons.push('Silver is a full lift and then a toner, so it is booked as its own appointment');
    return { sessions: from.level >= 8 ? 1 : from.level >= 5 ? 2 : 3, reasons };
  }

  const lift = target.level - from.level;

  if (lift <= 0) {
    reasons.push('Going darker is one appointment whatever the distance');
    return { sessions: 1, reasons };
  }

  let sessions = Math.max(1, Math.ceil(lift / 4));
  if (sessions > 1) {
    reasons.push(`${lift} levels lighter is more than hair will give in one sitting, so it is spread over visits`);
  }

  if ('needsPreLift' in target && target.needsPreLift) {
    reasons.push('A fashion shade needs a pale base before it will read as the colour on the swatch');
  }

  if (from.previouslyColored && lift > 0) {
    // The reason a salon asks. Box dye does not lift evenly and the result is
    // discovered in the bowl rather than predicted.
    sessions += 1;
    reasons.push('Colour already on the hair does not lift evenly, so one visit is kept for correcting it');
  }

  if (from.isGrey) {
    reasons.push('Grey hair has no pigment to lift and takes colour unevenly, so the result is toned rather than lifted');
  }

  return { sessions, reasons };
}

/**
 * THE HARD NO, AND WHY IT IS HERE RATHER THAN IN THE RANKING.
 *
 * Bleach on damaged hair does not deserve a low score, because a low score is
 * still an offer and this one is a refusal. A recommendation engine that merely
 * ranks it below other things will eventually surface it — on a day when the
 * salon has little else that fits — and the result is hair in the basin.
 *
 * So feasibility is a gate that runs before scoring, and the refusal carries the
 * alternative with it: depositing techniques are safe on hair that cannot be
 * lifted, which is a real answer rather than a closed door.
 */
export function colourFeasibility(
  hair: { condition: HairCondition; level: ColorLevel | number; previouslyColored?: boolean },
  wanted: { technique: ColorTechnique; base: BaseColorKey },
): { ok: boolean; reason?: string; instead?: ColorTechnique[] } {
  const lifts = LIFTS[wanted.technique] || baseColor(wanted.base).level > hair.level;

  if (!lifts) return { ok: true };

  if (hair.condition === 'DAMAGED') {
    return {
      ok: false,
      reason:
        'This hair is not in a condition to be lifted. Anything that lightens it risks breakage, and no result is worth that.',
      instead: COLOR_TECHNIQUES.filter((technique) => !LIFTS[technique]),
    };
  }

  if (hair.condition === 'POROUS' && baseColor(wanted.base).level - hair.level > 4) {
    return {
      ok: false,
      reason:
        'Porous hair will take the lift unevenly over this many levels. It is reachable, but over more than one appointment with a treatment between them.',
      instead: COLOR_TECHNIQUES.filter((technique) => !LIFTS[technique]),
    };
  }

  return { ok: true };
}

/**
 * How often she has to come back, which is a property of PLACEMENT far more than
 * of technique.
 *
 * The rule in one line: the closer the colour starts to the scalp, the sooner
 * the regrowth shows. A root-to-tip global at level 8 on level 3 hair is a
 * four-week commitment for ever; the same colour painted from the mid-lengths
 * down grows out invisibly and is the answer for somebody who cannot come back
 * every month. This is the single most useful thing a stylist can tell a
 * customer during a colour consultation, and it is almost never recorded.
 */
const UPKEEP_WEEKS: Record<ColorPlacement, number | null> = {
  ROOTS: 4,
  FULL: 5,
  CROWN: 6,
  MONEY_PIECE: 8,
  FACE_FRAMING: 8,
  PANELS: 8,
  UNDERLAYER: 10,
  HIDDEN: 10,
  MIDS_TO_ENDS: 12,
  // Grows out as the hair grows; there is no line to chase.
  ENDS: 14,
};

export function deriveCommitment(input: {
  hair: { condition: HairCondition; level: ColorLevel | number; isGrey?: boolean; previouslyColored?: boolean };
  look: { base: BaseColorKey; technique: ColorTechnique; placement: ColorPlacement; finish: Finish };
  natural: HairTexture;
}): Commitment {
  const { sessions, reasons } = sessionsToReach(input.hair, input.look.base);
  const needsLift = LIFTS[input.look.technique] || baseColor(input.look.base).level > input.hair.level;

  const effort = finishFeasibility(input.natural, input.look.finish);
  const all = [...reasons];

  if (effort === 'CHEMICAL') {
    all.push('The finish in the picture is a chemical service on this hair, not a blow-dry — it is priced and booked separately');
  } else if (effort === 'STYLING') {
    all.push('The finish is a blow-dry or irons, so it comes back curly after a wash unless she styles it');
  }

  return {
    sessions,
    needsLift,
    upkeepWeeks: UPKEEP_WEEKS[input.look.placement],
    reasons: all,
  };
}

// ═══════════════════════════════════ THE PICTURE: POSES ════════════════════
/**
 * THE ANGLES A LOOK IS PHOTOGRAPHED FROM — AND WHY THIS IS NOT DIMENSION 12.
 *
 * A pose is a property of the PICTURE, not of the look. The same butterfly cut
 * photographed from the front and from behind is one look, one price, one
 * booking; four photographs of it are four assets. Filing poses among the ten
 * would multiply the library by four and mean nothing — and it is the same
 * category error as calling a money piece a technique.
 *
 * ── Why more than one angle matters enough to build ───────────────────────
 *
 * Because the back is where the money is and the front is all anyone ever shows.
 * A butterfly cut, a U-cut, a V-cut, layers, a fade — the entire point of each is
 * the shape at the BACK of the head, which a front-facing portrait cannot show at
 * all. A customer approves a front view, sits down, and sees the back in the
 * mirror afterwards. That is the commonest way a technically correct haircut
 * becomes a complaint, and it is a photography problem rather than a cutting one.
 *
 * ── What each angle is actually for ───────────────────────────────────────
 *
 * Listed in the order a salon should shoot them, which is also the order of how
 * much each one adds.
 */
export const POSES = [
  /** What it looks like to her, in a mirror. Never optional. */
  'FRONT',
  /** The angle that shows the cut as a SHAPE. One picture, most information. */
  'THREE_QUARTER',
  /** Length, layers and the line at the jaw. Where a bob is right or wrong. */
  'SIDE',
  /** The graduation, the V or U, the fade. What she cannot see herself. */
  'BACK',
  /** The crown and the parting. Mostly for density and thinning work. */
  'TOP',
] as const;
export type Pose = (typeof POSES)[number];

export const POSE_LABELS: Record<Pose, string> = {
  FRONT: 'Front',
  THREE_QUARTER: 'Three-quarter',
  SIDE: 'Side',
  BACK: 'Back',
  TOP: 'Top',
};

/**
 * FRONT IS THE ONE THAT CANNOT BE MISSING.
 *
 * It is the look-book thumbnail, it is what the studio recolours, and it is what
 * a customer recognises. Everything else is an addition — and a style with only a
 * front view is a complete, usable catalogue entry, which is the property that
 * keeps a salon from being blocked on a four-angle photoshoot it will never book.
 */
export const PRIMARY_POSE: Pose = 'FRONT';

/**
 * Which angles actually earn a photograph for a given cut.
 *
 * Not all five, for every style, as a checklist to be dutifully filled in: that
 * is how a salon decides the feature is too much work and photographs nothing.
 * These are the angles where THAT cut is decided — so a pixie wants the side and
 * the back because its shape lives there, and a one-length cut genuinely does not
 * need four views of the same curtain of hair.
 */
export function posesWorthShooting(cut: CutFamily): readonly Pose[] {
  switch (cut) {
    // The cuts whose whole point is the back. A front view of a V-cut shows
    // nothing that distinguishes it from any other long hair.
    case 'V_CUT':
    case 'U_CUT':
    case 'BUTTERFLY':
    case 'LAYERS':
    case 'WOLF':
    case 'SHAG':
      return ['FRONT', 'THREE_QUARTER', 'BACK'];
    // Short cuts are read in profile: the line at the jaw and the nape.
    case 'BOB':
    case 'LOB':
    case 'PIXIE':
    case 'BLUNT':
      return ['FRONT', 'SIDE', 'BACK'];
    // Men's structural cuts are entirely about the sides and the nape — the
    // taper line is the work, and it is invisible from the front.
    case 'FADE':
    case 'TAPER':
    case 'UNDERCUT':
    case 'BUZZ':
    case 'CROP':
      return ['FRONT', 'SIDE', 'BACK'];
    // Styled upwards: the front and the profile carry it, the back is a nape.
    case 'QUIFF':
    case 'POMPADOUR':
      return ['FRONT', 'SIDE'];
    default:
      return ['FRONT', 'THREE_QUARTER'];
  }
}

// ═══════════════════════════════════════════ A COMPLETE LOOK ═══════════════
/**
 * ONE POINT IN THE SEVEN-DIMENSIONAL SPACE.
 *
 * Not a category of its own: a complete look is a value from each of dimensions
 * 4 to 10, which is what lets a salon's library hold thousands of them without
 * thousands of generators behind it — the cut comes from the kind registry and
 * everything else is a shader over one photograph.
 */
export interface CompleteLook {
  cut: CutFamily;
  length: HairLength;
  fringe: Fringe;
  finish: Finish;
  base: BaseColorKey;
  technique: ColorTechnique;
  placement: ColorPlacement;
}

/**
 * Whether a look is internally coherent, before anybody is asked about hair.
 *
 * Checked separately from feasibility because the two fail for different reasons
 * and deserve different sentences: this one means the LOOK is not a thing,
 * regardless of who wears it, and that is a bug in whatever composed it rather
 * than news about a customer.
 */
export function checkLook(look: CompleteLook): string[] {
  const problems: string[] = [];

  if (!placementAllowed(look.technique, look.placement)) {
    problems.push(
      `${look.technique} does not have a ${look.placement} placement — ${PLACEMENTS_FOR_TECHNIQUE[look.technique].join(', ')}`,
    );
  }

  /*
   * A gradient needs length to be a gradient in. The same rule already exists in
   * design-rules.ts for the configurator; it is here too because a look can be
   * composed by the recommendation engine without passing through that path, and
   * an ombre on a pixie is a picture of nothing either way.
   */
  if ((look.technique === 'OMBRE' || look.placement === 'MIDS_TO_ENDS') && look.length === 'VERY_SHORT') {
    problems.push('A graduated colour needs length to graduate over — not at very short');
  }

  if (look.fringe !== 'NONE' && (look.cut === 'BUZZ' || look.cut === 'PIXIE') && look.fringe === 'MICRO') {
    // Narrow on purpose: a pixie takes a fringe, it just does not take micro
    // bangs, which need length above them to sit against.
    problems.push('Micro bangs need weight above them that this cut does not leave');
  }

  return problems;
}

/**
 * WHAT A SALON MAY WRITE ON THE SEVEN AXES.
 *
 * The axes are TEXT columns rather than Postgres enums — because they are market
 * taxonomies that grow, and each new value would otherwise be a migration against
 * a live database — and a text column with no check is a column that fills up with
 * 'Bob', 'bob', 'BOB ' and 'Boblong'. This is the check, and it is the same
 * arrangement `kind` already has.
 *
 * Null is always allowed and always means "not recorded". That is not laxity: a
 * salon puts a style on the menu long before it has described it on seven axes,
 * and refusing the write until all seven are answered is how a catalogue stays
 * empty. What is refused is a value that is not in the registry, because that is
 * a typo or a stale client rather than an honest gap.
 */
export function checkLookFields(input: {
  cutFamily?: string | null;
  fringe?: string | null;
  finish?: string | null;
  baseColorKey?: string | null;
  colorTechnique?: string | null;
  colorPlacement?: string | null;
  desiredLooks?: string[] | null;
  occasions?: string[] | null;
}): string[] {
  const problems: string[] = [];

  const oneOf = (value: string | null | undefined, allowed: readonly string[], field: string) => {
    if (value == null) return;
    if (!allowed.includes(value)) problems.push(`${field} must be one of ${allowed.join(', ')}`);
  };

  oneOf(input.cutFamily, CUT_FAMILIES, 'cutFamily');
  oneOf(input.fringe, FRINGES, 'fringe');
  oneOf(input.finish, FINISHES, 'finish');
  oneOf(
    input.baseColorKey,
    BASE_COLORS.map((row) => row.key),
    'baseColorKey',
  );
  oneOf(input.colorTechnique, COLOR_TECHNIQUES, 'colorTechnique');
  oneOf(input.colorPlacement, COLOR_PLACEMENTS, 'colorPlacement');

  for (const look of input.desiredLooks ?? []) oneOf(look, DESIRED_LOOKS, 'desiredLooks');
  for (const occasion of input.occasions ?? []) oneOf(occasion, OCCASIONS, 'occasions');

  /*
   * THE CROSS-FIELD CHECK, and the reason this is a function rather than six zod
   * enums. Technique and placement are each individually valid and jointly
   * nonsense far more often than not — "global colour on the ends" passes any
   * check that looks at one field at a time.
   *
   * Only run when both are present and both are known, so that a typo in one
   * reports as a typo rather than as an incompatibility with the other.
   */
  if (
    input.colorTechnique &&
    input.colorPlacement &&
    (COLOR_TECHNIQUES as readonly string[]).includes(input.colorTechnique) &&
    (COLOR_PLACEMENTS as readonly string[]).includes(input.colorPlacement) &&
    !placementAllowed(input.colorTechnique as ColorTechnique, input.colorPlacement as ColorPlacement)
  ) {
    problems.push(
      `${input.colorTechnique} has no ${input.colorPlacement} placement — ` +
        `it can be ${PLACEMENTS_FOR_TECHNIQUE[input.colorTechnique as ColorTechnique].join(', ')}`,
    );
  }

  return problems;
}

/**
 * THE WHOLE MODEL, FOR THE SCREENS THAT HAVE TO DRAW IT.
 *
 * One export rather than eleven imports, and it carries the grouping — which of
 * the dimensions is read off the customer and which composes a look — because
 * that distinction is the one the UI is built on and it should not have to be
 * rediscovered from the names.
 */
export const DIMENSIONS = {
  analysis: ['FACE', 'HAIR', 'PREFERENCE'] as const,
  look: ['CUT', 'LENGTH', 'FRINGE', 'FINISH', 'BASE_COLOR', 'TECHNIQUE', 'PLACEMENT'] as const,
  derived: ['COMMITMENT'] as const,
} as const;

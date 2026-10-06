import { describe, expect, it } from 'vitest';
import {
  BASE_COLORS,
  COLOR_PLACEMENTS,
  COLOR_TECHNIQUES,
  FINISHES,
  FRINGES_FOR_FOREHEAD,
  PLACEMENTS_FOR_TECHNIQUE,
  POSES,
  checkLook,
  checkLookFields,
  colourFeasibility,
  deriveCommitment,
  finishFeasibility,
  finishesFor,
  placementAllowed,
  posesWorthShooting,
  sessionsToReach,
  type CompleteLook,
} from '../src/modules/hair-studio/look-dimensions';

/**
 * WHAT IS WORTH TESTING IN A TAXONOMY.
 *
 * Not that the lists contain what they contain — that asserts a file against
 * itself. What is worth pinning is every place the dimensions CONSTRAIN each
 * other, because those are the rules a later edit can quietly drop: a placement
 * added to the wrong technique, a finish that becomes free, a gate that stops
 * gating. None of those break a build. They produce a tool that offers a stylist
 * a service nobody can perform, which is the way a professional product loses its
 * professionals.
 */

describe('technique × placement is a map, not a grid', () => {
  /**
   * The whole reason the two dimensions are separate AND related. Eighty
   * combinations exist on paper; a colourist can do about half.
   */
  it('refuses the combinations that name nothing a colourist could do', () => {
    expect(placementAllowed('GLOBAL', 'ENDS')).toBe(false);
    expect(placementAllowed('GLOBAL', 'FACE_FRAMING')).toBe(false);
    expect(placementAllowed('ROOT', 'ENDS')).toBe(false);
    expect(placementAllowed('OMBRE', 'ROOTS')).toBe(false);
    expect(placementAllowed('BABYLIGHTS', 'PANELS')).toBe(false);
    expect(placementAllowed('LOWLIGHTS', 'ENDS')).toBe(false);
  });

  it('allows the ones that are the point of each technique', () => {
    expect(placementAllowed('GLOBAL', 'FULL')).toBe(true);
    expect(placementAllowed('BALAYAGE', 'MIDS_TO_ENDS')).toBe(true);
    expect(placementAllowed('OMBRE', 'ENDS')).toBe(true);
    expect(placementAllowed('HIGHLIGHTS', 'MONEY_PIECE')).toBe(true);
  });

  /**
   * A technique with no legal placement is unreachable — it would be a value in a
   * dropdown that produces an invalid look whatever is chosen next.
   */
  it('leaves no technique stranded without a placement', () => {
    for (const technique of COLOR_TECHNIQUES) {
      expect(PLACEMENTS_FOR_TECHNIQUE[technique].length, technique).toBeGreaterThan(0);
    }
  });

  /**
   * And no placement orphaned: one that no technique allows is a value nothing
   * can ever produce, which means either the map is wrong or the placement should
   * not be in the list. Both are worth finding out about.
   */
  it('leaves no placement unreachable by every technique', () => {
    for (const placement of COLOR_PLACEMENTS) {
      const reachable = COLOR_TECHNIQUES.some((technique) => placementAllowed(technique, placement));
      expect(reachable, placement).toBe(true);
    }
  });

  /**
   * MONEY PIECE IS A PLACEMENT, NOT A TECHNIQUE.
   *
   * It is listed as a technique in most versions of this taxonomy. If it ever
   * migrates into the technique list the two dimensions overlap and a UI can
   * express the same thing twice — so the absence is asserted rather than left to
   * a reviewer to notice.
   */
  it('keeps money piece out of the techniques', () => {
    expect(COLOR_TECHNIQUES as readonly string[]).not.toContain('MONEY_PIECE');
    expect(COLOR_PLACEMENTS as readonly string[]).toContain('MONEY_PIECE');
  });
});

describe('a finish is a relation to the hair she has, not a free choice', () => {
  it('is free on hair that already does it', () => {
    expect(finishFeasibility('CURLY', 'CURLS')).toBe('NATURAL');
    expect(finishFeasibility('STRAIGHT', 'SLEEK')).toBe('NATURAL');
    expect(finishFeasibility('COILY', 'DEFINED_CURLS')).toBe('NATURAL');
  });

  /**
   * THE SENTENCE THIS WHOLE FUNCTION EXISTS FOR.
   *
   * Smooth hair on a coily head is a chemical or thermal service with a price and
   * a cost in condition. Reported as CHEMICAL rather than allowed as styling,
   * because the alternative is a salon promising a blow-dry and delivering a
   * relaxer — or worse, promising it for the price of a blow-dry.
   */
  it('calls a silk press what it is, rather than styling', () => {
    expect(finishFeasibility('COILY', 'SLEEK')).toBe('CHEMICAL');
    expect(finishFeasibility('COILY', 'STRAIGHT')).toBe('CHEMICAL');
    expect(finishFeasibility('COILY', 'BLOWOUT')).toBe('CHEMICAL');
  });

  it('says no outright where no service delivers it', () => {
    // Defined curls are a curl pattern. Straight hair has none to define, and a
    // perm produces curls rather than definition.
    expect(finishFeasibility('STRAIGHT', 'DEFINED_CURLS')).toBe('NO');
  });

  /** The impossible one is never offered, and her own hair is offered first. */
  it('orders what to offer by what it costs her', () => {
    const offered = finishesFor('STRAIGHT');
    expect(offered.map((row) => row.finish)).not.toContain('DEFINED_CURLS');
    expect(offered[0]!.effort).toBe('NATURAL');
    const efforts = offered.map((row) => row.effort);
    expect(efforts.indexOf('CHEMICAL')).toBeGreaterThan(efforts.indexOf('STYLING'));
  });

  /** Every natural texture must have an answer for every finish, or a lookup
   *  returns undefined and a feasibility check silently passes. */
  it('answers for every pair', () => {
    for (const texture of ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'] as const) {
      for (const finish of FINISHES) {
        expect(finishFeasibility(texture, finish), `${texture}/${finish}`).toBeTruthy();
      }
    }
  });
});

describe('how many appointments, which is the number she is entitled to first', () => {
  it('is one going darker, whatever the distance', () => {
    // The asymmetry that surprises customers: ten levels down is one visit, four
    // levels up is two.
    expect(sessionsToReach({ level: 9 }, 'BLACK').sessions).toBe(1);
  });

  it('is more than one when the lift is more than hair gives in a sitting', () => {
    const black = sessionsToReach({ level: 1 }, 'PLATINUM');
    expect(black.sessions).toBeGreaterThan(1);
    expect(black.reasons.join(' ')).toContain('levels lighter');
  });

  it('adds a visit for colour already on the hair', () => {
    const virgin = sessionsToReach({ level: 4 }, 'BLONDE');
    const boxDyed = sessionsToReach({ level: 4, previouslyColored: true }, 'BLONDE');
    expect(boxDyed.sessions).toBe(virgin.sessions + 1);
    expect(boxDyed.reasons.join(' ')).toContain('does not lift evenly');
  });

  /** Silver is a bleach and a toner rather than a distance, so it is answered
   *  on its own terms instead of by subtraction. */
  it('treats silver as its own appointment rather than a level', () => {
    const grey = sessionsToReach({ level: 2 }, 'GREY');
    expect(grey.sessions).toBeGreaterThan(1);
    expect(grey.reasons.join(' ')).toContain('toner');
  });

  it('never promises less than one appointment', () => {
    for (const target of BASE_COLORS) {
      for (const level of [1, 5, 10]) {
        expect(sessionsToReach({ level }, target.key).sessions, `${level}→${target.key}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('condition is a gate, not a ranking penalty', () => {
  /**
   * THE MOST IMPORTANT ASSERTION IN THIS FILE.
   *
   * A low score is still an offer, and on a quiet day a recommendation engine
   * will surface its least-bad option. Bleach on damaged hair must not be
   * rankable at all — it has to fail before scoring, every time.
   */
  it('refuses to lift damaged hair at all', () => {
    const verdict = colourFeasibility({ condition: 'DAMAGED', level: 3 }, { technique: 'BALAYAGE', base: 'BLONDE' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('not in a condition');
  });

  /** A refusal that carries the alternative, because depositing colour IS safe
   *  on hair that cannot be lifted — a real answer rather than a closed door. */
  it('offers what is safe instead of only saying no', () => {
    const verdict = colourFeasibility({ condition: 'DAMAGED', level: 3 }, { technique: 'HIGHLIGHTS', base: 'CARAMEL' });
    expect(verdict.instead).toContain('LOWLIGHTS');
    expect(verdict.instead).toContain('ROOT');
    expect(verdict.instead).not.toContain('BALAYAGE');
  });

  it('allows depositing colour on damaged hair, which is the point of the distinction', () => {
    expect(colourFeasibility({ condition: 'DAMAGED', level: 5 }, { technique: 'LOWLIGHTS', base: 'CHOCOLATE' }).ok).toBe(
      true,
    );
    // Going darker does not lift, so it passes even at DAMAGED.
    expect(colourFeasibility({ condition: 'DAMAGED', level: 7 }, { technique: 'GLOBAL', base: 'DARK_BROWN' }).ok).toBe(
      true,
    );
  });

  /**
   * A LIFT THE TECHNIQUE DOES NOT ADMIT TO.
   *
   * Global colour is a depositing technique, so LIFTS says false — but global
   * colour to a LIGHTER level is a lift whatever it is called. The gate reads the
   * target level as well as the technique, and this is the case that catches it.
   */
  it('catches a lift hidden in a depositing technique', () => {
    const verdict = colourFeasibility({ condition: 'DAMAGED', level: 2 }, { technique: 'GLOBAL', base: 'BLONDE' });
    expect(verdict.ok).toBe(false);
  });

  it('spreads a big lift on porous hair rather than refusing it outright', () => {
    const verdict = colourFeasibility({ condition: 'POROUS', level: 2 }, { technique: 'BALAYAGE', base: 'PLATINUM' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('more than one appointment');
  });
});

describe('upkeep is a property of placement, which is the useful thing to tell her', () => {
  const hair = { condition: 'HEALTHY' as const, level: 3 };
  const base = { base: 'CARAMEL' as const, finish: 'SOFT_WAVES' as const };

  /**
   * The single most useful sentence in a colour consultation, and the one almost
   * never recorded: the closer the colour starts to the scalp, the sooner the
   * regrowth shows. Somebody who cannot come back monthly should be sold the
   * balayage rather than the global.
   */
  it('says a root-level colour needs attention far sooner than a painted one', () => {
    const roots = deriveCommitment({ hair, natural: 'WAVY', look: { ...base, technique: 'ROOT', placement: 'ROOTS' } });
    const ends = deriveCommitment({
      hair,
      natural: 'WAVY',
      look: { ...base, technique: 'BALAYAGE', placement: 'ENDS' },
    });
    expect(roots.upkeepWeeks).toBeLessThan(ends.upkeepWeeks!);
  });

  it('warns when the finish in the picture is a chemical service on this hair', () => {
    const commitment = deriveCommitment({
      hair,
      natural: 'COILY',
      look: { base: 'CHOCOLATE', finish: 'SLEEK', technique: 'GLOBAL', placement: 'FULL' },
    });
    expect(commitment.reasons.join(' ')).toContain('chemical service');
  });

  /**
   * Wavy hair ironed straight, NOT curly hair straightened — that one is
   * chemical, which the test above covers. This is the quieter disappointment:
   * the service was honest, the picture was honest, and it is gone on Thursday.
   */
  it('warns when the finish washes out', () => {
    const commitment = deriveCommitment({
      hair,
      natural: 'WAVY',
      look: { base: 'CHOCOLATE', finish: 'STRAIGHT', technique: 'GLOBAL', placement: 'FULL' },
    });
    expect(commitment.reasons.join(' ')).toContain('after a wash');
  });
});

describe('a look has to be a thing before anybody is asked about hair', () => {
  const look: CompleteLook = {
    cut: 'BUTTERFLY',
    length: 'LONG',
    fringe: 'CURTAIN',
    finish: 'SOFT_WAVES',
    base: 'CHOCOLATE',
    technique: 'BALAYAGE',
    placement: 'FACE_FRAMING',
  };

  it('passes the worked example', () => {
    expect(checkLook(look)).toEqual([]);
  });

  it('catches an impossible technique and placement pair', () => {
    expect(checkLook({ ...look, technique: 'GLOBAL', placement: 'ENDS' })[0]).toContain('does not have a');
  });

  /** A gradient needs length to graduate over. The same rule as the
   *  configurator's, repeated because the engine can compose a look without
   *  passing through that path. */
  it('catches a gradient with no length to run down', () => {
    const problems = checkLook({ ...look, length: 'VERY_SHORT', technique: 'OMBRE', placement: 'ENDS' });
    expect(problems.join(' ')).toContain('graduate over');
  });
});

describe('poses are a property of the picture, not of the look', () => {
  /**
   * If a pose ever becomes a look dimension the library multiplies by five and
   * means nothing — four photographs of one butterfly cut are one look, one
   * price, one booking.
   */
  it('always starts from the front, which is the one that cannot be missing', () => {
    for (const cut of ['BOB', 'V_CUT', 'FADE', 'QUIFF', 'ONE_LENGTH'] as const) {
      expect(posesWorthShooting(cut)[0], cut).toBe('FRONT');
    }
  });

  /**
   * THE REASON THIS EXISTS. The cuts whose whole shape lives at the back are the
   * ones a front-facing portrait cannot sell — and a V-cut photographed only
   * from the front is indistinguishable from any other long hair.
   */
  it('asks for the back on the cuts that are decided there', () => {
    for (const cut of ['V_CUT', 'U_CUT', 'BUTTERFLY', 'LAYERS', 'FADE', 'BOB'] as const) {
      expect(posesWorthShooting(cut), cut).toContain('BACK');
    }
  });

  /**
   * And does NOT ask for four angles of everything. A checklist a salon cannot
   * finish is a feature a salon does not start, so a cut with nothing happening
   * at the back is not asked to prove it.
   */
  it('keeps the list short where extra angles add nothing', () => {
    expect(posesWorthShooting('ONE_LENGTH').length).toBeLessThan(posesWorthShooting('BOB').length);
    expect(posesWorthShooting('POMPADOUR')).not.toContain('BACK');
  });

  it('never asks for a pose that is not a pose', () => {
    for (const cut of ['BOB', 'V_CUT', 'FADE', 'QUIFF', 'ONE_LENGTH', 'WOLF'] as const) {
      for (const pose of posesWorthShooting(cut)) {
        expect(POSES as readonly string[], cut).toContain(pose);
      }
    }
  });
});

describe('what a salon may write on the seven axes', () => {
  it('accepts a complete, coherent description', () => {
    expect(
      checkLookFields({
        cutFamily: 'BUTTERFLY',
        fringe: 'CURTAIN',
        finish: 'SOFT_WAVES',
        baseColorKey: 'CHOCOLATE',
        colorTechnique: 'BALAYAGE',
        colorPlacement: 'FACE_FRAMING',
        desiredLooks: ['MODERN', 'NATURAL'],
        occasions: ['EVERYDAY', 'OFFICE'],
      }),
    ).toEqual([]);
  });

  /**
   * NULL IS ALWAYS FINE, and this is not laxity. A salon puts a style on the menu
   * long before it has described it on seven axes, and refusing the write until
   * all seven are answered is how a catalogue stays empty.
   */
  it('allows every axis to be unrecorded', () => {
    expect(checkLookFields({})).toEqual([]);
    expect(checkLookFields({ cutFamily: null, finish: null, colorTechnique: null })).toEqual([]);
  });

  it('refuses a value that is not in the registry, which is a typo or a stale client', () => {
    expect(checkLookFields({ cutFamily: 'bob' })[0]).toContain('cutFamily');
    expect(checkLookFields({ finish: 'SHINY' })[0]).toContain('finish');
    expect(checkLookFields({ baseColorKey: 'PURPLE' })[0]).toContain('baseColorKey');
    expect(checkLookFields({ occasions: ['EVERYDAY', 'FUNERAL'] })[0]).toContain('occasions');
  });

  /**
   * THE CHECK NO PER-FIELD VALIDATION CATCHES. Both values are individually
   * legal; together they name nothing. This is the reason the validator is a
   * function rather than six zod enums.
   */
  it('catches a pair that is valid field by field and nonsense together', () => {
    const problems = checkLookFields({ colorTechnique: 'GLOBAL', colorPlacement: 'ENDS' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no ENDS placement');
    // And it says what WOULD be legal, because the next thing anybody does is
    // guess again.
    expect(problems[0]).toContain('FULL');
  });

  /** A typo in one field must report as a typo, not as an incompatibility with
   *  the other — otherwise the message sends somebody to fix the wrong field. */
  it('reports a typo as a typo even when the other half of the pair is set', () => {
    const problems = checkLookFields({ colorTechnique: 'BALYAGE', colorPlacement: 'ENDS' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('colorTechnique must be one of');
  });
});

describe('fringes answer to the forehead, which is why that field exists', () => {
  it('suggests a fringe for a high forehead and keeps the heavy ones off a low one', () => {
    expect(FRINGES_FOR_FOREHEAD.HIGH).toContain('FULL');
    expect(FRINGES_FOR_FOREHEAD.LOW).not.toContain('FULL');
    expect(FRINGES_FOR_FOREHEAD.LOW).not.toContain('MICRO');
  });

  /** "No fringe" must stay reachable for an average or low forehead — a
   *  recommendation that cannot say "leave it alone" is not a recommendation. */
  it('always leaves “none” available where it is the right answer', () => {
    expect(FRINGES_FOR_FOREHEAD.AVERAGE).toContain('NONE');
    expect(FRINGES_FOR_FOREHEAD.LOW).toContain('NONE');
  });
});

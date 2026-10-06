import type { FaceShape, Gender, HairDensity, HairLength, HairTexture } from '@prisma/client';
import { kindByKey } from './hairstyle-kinds';
import type { DesignConfig } from './design-rules';

/**
 * TURNING A DESIGN INTO ENGLISH.
 *
 * The configurator produces a record: nine enums, a hex colour and a bag of
 * options. The image model wants a paragraph. This file is the whole of that
 * translation and it is pure, with no network and no database, because it is the
 * part most likely to be wrong and the only part a test can actually pin down.
 *
 * ── Why this is not a template string ─────────────────────────────────────
 *
 * Three things have to be true of every prompt it builds, and none of them
 * survive being bolted on later:
 *
 *   1. IT MUST DESCRIBE A HAIRCUT, NOT A PERSON. The salon chose a cut; it did
 *      not choose a body, an outfit or an expression, and a model left to fill
 *      those in draws from whatever its training data thinks a woman in a hair
 *      advert looks like. So the subject is fixed, flat and boring on purpose —
 *      head and shoulders, plain background, neutral expression — and every
 *      adjective that varies describes hair.
 *
 *   2. AN EDIT MUST CHANGE THE HAIR AND NOTHING ELSE. When there is a source
 *      image, the instruction leads with keeping the face: a recolour that
 *      quietly returns a different woman is worse than no recolour, because the
 *      salon has already told a customer this is what she will look like.
 *
 *   3. IT MUST NOT INVITE A PHOTOGRAPH OF A REAL PERSON. Nothing here takes a
 *      name, and the subject is always described as a model. A salon typing a
 *      celebrity's name into a box and getting their face back is a problem we
 *      do not get to have later if we never build the box.
 *
 * The honest limit, stated once: this draws a plausible head wearing the cut. It
 * is not a photograph of the customer, and nothing in the prompt pretends
 * otherwise.
 */

export interface PromptInput {
  /** The generator key, e.g. `layered_bob`. Supplies the name of the cut. */
  hairstyleKey: string;
  /** The salon's own name for it, used when it differs from the generator's. */
  styleName?: string | null;
  gender?: Gender | null;
  texture: HairTexture;
  length: HairLength;
  density?: HairDensity | null;
  /** 0-100. Only the ends of the range are worth saying out loud. */
  volume?: number | null;
  baseColor: string;
  config?: Partial<DesignConfig> | null;
  /** Set when the picture is an edit of one we already hold. */
  editing?: boolean;
  /**
   * Which face the cut should be shown on, for a catalogue reference.
   *
   * Only useful there. A salon's look-book is browsed by somebody trying to
   * recognise their own face in it, so a style advised for round faces shown on a
   * sharply oval one is a picture that argues against itself.
   */
  faceShape?: FaceShape | null;
}

// ----------------------------------------------------------- vocabulary -----

const TEXTURE: Record<HairTexture, string> = {
  STRAIGHT: 'straight',
  WAVY: 'softly wavy',
  CURLY: 'curly',
  COILY: 'tightly coiled',
};

/**
 * Lengths as a stylist says them, with a landmark.
 *
 * "Medium" to a model could be anything between an ear and a waist. A landmark
 * on the body is the one description that survives translation into pixels.
 */
const LENGTH: Record<HairLength, string> = {
  VERY_SHORT: 'cropped very short, close to the head',
  SHORT: 'short, ending around the jaw',
  MEDIUM: 'medium length, falling to the collarbone',
  LONG: 'long, reaching mid-back',
  VERY_LONG: 'very long, past the waist',
};

const DENSITY: Record<HairDensity, string> = {
  LOW: 'fine, sparse hair',
  MEDIUM: 'hair of average thickness',
  HIGH: 'thick, dense hair',
};

const BANGS: Record<string, string> = {
  CURTAIN: 'curtain bangs parted in the middle and sweeping to either side',
  STRAIGHT: 'a straight blunt fringe across the forehead',
  SIDE: 'a side-swept fringe',
  WISPY: 'wispy, feathered bangs',
  MICRO: 'very short micro bangs high on the forehead',
};

const LAYERS: Record<string, string> = {
  LIGHT: 'lightly layered',
  MEDIUM: 'layered through the mid-lengths',
  HEAVY: 'heavily layered with plenty of movement',
};

const PARTING: Record<string, string> = {
  CENTER: 'parted in the centre',
  LEFT: 'parted on the left',
  RIGHT: 'parted on the right',
  DEEP_SIDE: 'a deep side parting',
  NATURAL: '',
};

const FADE: Record<string, string> = {
  LOW: 'a low fade starting just above the ear',
  MID: 'a mid fade on the sides and back',
  HIGH: 'a high fade taken up above the temples',
};

/**
 * HEX IS NOT A WORD, AND A MODEL CANNOT READ ONE.
 *
 * `#3B2417` in a prompt is ignored or, worse, half-read as a number. So the
 * colour is matched to the nearest name a colourist would use — which is also
 * what makes the prompt legible in the database six months later.
 *
 * Matched in RGB rather than a perceptual space on purpose: these are nineteen
 * well-separated points and the names are the same either way, and a colour
 * conversion is a dependency and a rounding error in a file whose whole value is
 * being obviously correct. Tested against the ends of the range.
 */
const SWATCHES: { hex: string; name: string }[] = [
  { hex: '#0a0a0a', name: 'jet black' },
  { hex: '#1c1512', name: 'natural black' },
  { hex: '#2e211c', name: 'darkest brown' },
  { hex: '#3b2417', name: 'dark chocolate brown' },
  { hex: '#4a3121', name: 'medium brown' },
  { hex: '#6b4a2f', name: 'warm chestnut brown' },
  { hex: '#8b5a2b', name: 'light golden brown' },
  { hex: '#a9743f', name: 'caramel brown' },
  { hex: '#c68642', name: 'honey blonde' },
  { hex: '#d9a95c', name: 'golden blonde' },
  { hex: '#e8c88a', name: 'light buttery blonde' },
  { hex: '#f2e2c4', name: 'pale platinum blonde' },
  { hex: '#8c3b1b', name: 'deep auburn' },
  { hex: '#b4441f', name: 'copper red' },
  { hex: '#d2552b', name: 'bright ginger' },
  { hex: '#7a2f3a', name: 'burgundy' },
  { hex: '#9b9b9b', name: 'silver grey' },
  { hex: '#d6d6d6', name: 'white grey' },
  { hex: '#5b4b8a', name: 'violet' },
  { hex: '#2f5f8a', name: 'denim blue' },
  { hex: '#2f7a5a', name: 'emerald green' },
  { hex: '#b03a7a', name: 'magenta pink' },
];

function rgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/** The nearest colour a person would say out loud. Exported for the test. */
export function colourName(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex.trim())) return 'natural brown';
  const [r, g, b] = rgb(hex.trim().toLowerCase());

  let best = SWATCHES[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const swatch of SWATCHES) {
    const [sr, sg, sb] = rgb(swatch.hex);
    const distance = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = swatch;
    }
  }
  return best.name;
}

// -------------------------------------------------------------- the cut -----

/** Every colour effect the design asks for, as a list of phrases. */
function colourEffects(config: Partial<DesignConfig>): string[] {
  const parts: string[] = [];

  if (config.ombre?.enabled) {
    const root = colourName(config.ombre.rootColor);
    const end = colourName(config.ombre.endColor);
    parts.push(`an ombre fading from ${root} at the roots to ${end} at the ends`);
  }
  if (config.balayage?.enabled) {
    const where =
      config.balayage.placement === 'FULL'
        ? 'through the whole length'
        : config.balayage.placement === 'MID'
          ? 'from the mid-lengths down'
          : 'on the ends only';
    parts.push(`hand-painted ${colourName(config.balayage.color)} balayage ${where}`);
  }
  if (config.highlights?.enabled) {
    const weight = config.highlights.intensity === 'STRONG' ? 'bold' : config.highlights.intensity === 'SUBTLE' ? 'fine' : '';
    parts.push(`${weight} ${colourName(config.highlights.color)} highlights`.trim());
  }
  if (config.lowlights?.enabled) {
    parts.push(`${colourName(config.lowlights.color)} lowlights for depth`);
  }
  if (config.moneyPiece?.enabled) {
    parts.push(`a brighter ${colourName(config.moneyPiece.color)} money piece framing the face`);
  }
  if (config.faceFraming?.enabled) {
    parts.push(`${colourName(config.faceFraming.color)} face-framing strands`);
  }
  if (config.rootShadow?.enabled) {
    parts.push(`a soft ${colourName(config.rootShadow.color)} root shadow blended down from the parting`);
  }

  /*
   * Hand-placed sections, described by COUNT and COLOUR rather than by angle.
   *
   * The model has no idea what 0.8 radians means and would be no better off
   * being told; what it can draw is "two hand-painted panels in caramel". The
   * exact placement is the 3D studio's job, which is the honest division — the
   * configurator is where a section is positioned, and the photograph is where
   * the salon sees roughly what that kind of colouring looks like.
   */
  const strips = (config.strips ?? []).filter((strip) => strip.strength > 0);
  if (strips.length) {
    const colours = [...new Set(strips.map((strip) => colourName(strip.color)))];
    parts.push(
      strips.length === 1
        ? `a hand-painted panel of ${colours[0]} through one section`
        : `${strips.length} hand-painted panels in ${colours.join(' and ')}`,
    );
  }

  return parts;
}

/** The haircut itself, in one sentence. The heart of the prompt. */
export function describeHair(input: PromptInput): string {
  const kind = kindByKey(input.hairstyleKey);
  const cut = (input.styleName?.trim() || kind?.label || 'haircut').toLowerCase();
  const config = input.config ?? {};

  const parts: string[] = [];

  parts.push(`a ${cut}`);
  parts.push(LENGTH[input.length]);
  parts.push(`${TEXTURE[input.texture]} hair`);
  parts.push(`in ${colourName(input.baseColor)}`);

  if (input.density) parts.push(DENSITY[input.density]);

  /*
   * Volume is a slider and most of its range is not worth a word. Describing
   * "52% volume" as anything at all adds noise to a prompt whose every clause
   * competes for the model's attention; only the ends change the picture.
   */
  if (typeof input.volume === 'number') {
    if (input.volume >= 80) parts.push('styled with a lot of volume and body');
    else if (input.volume <= 20) parts.push('worn flat and sleek against the head');
  }

  if (config.layers && config.layers !== 'NONE' && LAYERS[config.layers]) parts.push(LAYERS[config.layers]!);
  if ((config.faceFramingLayers ?? 0) > 0) parts.push('with layers cut short around the face');
  if (config.bangs && config.bangs !== 'NONE' && BANGS[config.bangs]) parts.push(`with ${BANGS[config.bangs]}`);
  if (config.parting && PARTING[config.parting]) parts.push(PARTING[config.parting]!);

  if (config.fade) {
    const fade = FADE[config.fade.type] ?? FADE.MID!;
    // The guard number is how a barber says it and how the customer will ask for
    // it; zero is skin, which is a different picture entirely.
    const guard = config.fade.guard === 0 ? 'taken down to the skin' : `cut to a number ${config.fade.guard} guard`;
    parts.push(`${fade}, ${guard}`);
  }

  parts.push(...colourEffects(config));

  return parts.filter(Boolean).join(', ');
}

/**
 * The subject, held still.
 *
 * Unflattering on purpose. Everything about this clause is chosen to stop the
 * model deciding anything the salon did not ask for: a plain studio backdrop
 * rather than a scene, a neutral expression rather than a mood, modest framing
 * rather than a body, and an age floor stated outright. A look-book page is a
 * catalogue of haircuts; the moment it becomes a catalogue of people we are in
 * a business nobody here chose to be in.
 */
function subject(gender: Gender | null | undefined): string {
  const person =
    gender === 'MALE'
      ? 'an adult male model'
      : gender === 'FEMALE'
        ? 'an adult female model'
        : 'an adult model';
  return (
    `A professional salon look-book photograph of ${person}, head and shoulders only, ` +
    'facing the camera with a relaxed neutral expression, plain pale grey studio background, ' +
    'soft even studio lighting, wearing a plain neutral top'
  );
}

/**
 * What the model must not draw.
 *
 * Mostly about the two ways these pictures fail in practice: a hairstyle the
 * salon cannot reproduce because half of it is an extension or a filter, and a
 * photograph that is about the person rather than the haircut.
 */
export const NEGATIVE =
  'text, watermark, logo, signature, hat, hood, headscarf, sunglasses, hands, ' +
  'extra limbs, deformed face, cartoon, illustration, 3d render, heavy makeup, ' +
  'nudity, revealing clothing, child, multiple people, cluttered background, ' +
  'motion blur, oversaturated colours';

/**
 * The whole prompt.
 *
 * Two shapes, and the difference is the first clause. From text, the subject
 * comes first because the model is inventing a person. From an image, KEEPING
 * THE PERSON comes first, in plain imperative language, because everything after
 * it is licence to change things and the face is not on the list.
 */
export function buildPrompt(input: PromptInput): string {
  const hair = describeHair(input);

  if (input.editing) {
    return (
      'Change only the hair in this photograph. ' +
      'Keep the same face, the same facial features, the same skin tone, the same age, ' +
      'the same expression, the same clothing, the same pose, the same framing and the same background, ' +
      'all completely unchanged. ' +
      `Replace the hair with ${hair}. ` +
      'The new hair must sit naturally on the existing head, with a believable hairline and natural shadow ' +
      'where it meets the forehead and ears. Photographic, sharp, salon-quality result.'
    );
  }

  return (
    `${subject(input.gender)}. ` +
    `The hair is ${hair}. ` +
    'Sharp focus on the hair, every strand clearly defined, natural shine, photorealistic, ' +
    'shot on a full-frame camera with an 85mm lens.'
  );
}

const FACE: Record<FaceShape, string> = {
  OVAL: 'an oval face',
  ROUND: 'a round face',
  SQUARE: 'a square jawline',
  OBLONG: 'a long, oblong face',
  HEART: 'a heart-shaped face',
  DIAMOND: 'a diamond-shaped face',
};

/**
 * A REFERENCE PICTURE FOR THE SALON'S MENU.
 *
 * ── Why this is not just buildPrompt with a different caption ──────────────
 *
 * Because it is drawn ONCE and then shown to every customer who opens the look-
 * book, which changes what it has to be. A consultation preview can be a little
 * odd and be regenerated in forty seconds; a catalogue picture that is a little
 * odd is a little odd for a year, on a page the salon uses to sell.
 *
 * So three things are tighter here than anywhere else in this file:
 *
 *   THE FACE IS NAMED. A browser of a look-book is looking for their own face in
 *   it, and a cut advised for round faces shown on a sharply oval one is a
 *   picture that quietly argues against the advice attached to it.
 *
 *   THE WORD "FICTIONAL" IS IN THE PROMPT. It is the one picture here that will
 *   be published on a salon's own page rather than shown across a counter, and
 *   the distinction between "a person" and "a particular person" is the whole
 *   question when something is published.
 *
 *   IT ASKS FOR STRANDS. A reference image is judged on whether the hair reads as
 *   hair at thumbnail size, which is a different request from a flattering
 *   portrait and worth saying outright.
 */
export function buildReferencePrompt(input: PromptInput): string {
  const hair = describeHair(input);
  const person =
    input.gender === 'MALE'
      ? 'a fictional adult man'
      : input.gender === 'FEMALE'
        ? 'a fictional adult woman'
        : 'a fictional adult';
  const face = input.faceShape ? ` with ${FACE[input.faceShape]}` : '';

  return (
    `A photorealistic salon hairstyle reference photograph of ${person}${face}, ` +
    `showing ${hair}. ` +
    'Front-facing, head and shoulders, neutral expression, plain light grey studio background, ' +
    'soft professional salon lighting, natural skin texture, individual hair strands clearly visible, ' +
    'clean commercial beauty photography, sharp focus on the hair.'
  );
}

/**
 * A COLOUR CHANGE, AND NOTHING ELSE.
 *
 * Narrower than a full edit on purpose. The cut is already right in the source
 * image — it is the thing the salon just approved — so naming it again invites
 * the model to re-cut it, and the shape comes back subtly different. The
 * instruction is therefore about pigment and only pigment.
 */
export function buildRecolourPrompt(input: PromptInput): string {
  const config = input.config ?? {};
  const effects = colourEffects(config);
  const extra = effects.length ? `, with ${effects.join(', ')}` : '';

  return (
    'Change only the colour of the hair in this photograph. ' +
    'Keep the same face, the same person, the same haircut, the same length, the same parting, ' +
    'the same styling, the same clothing and the same background, all completely unchanged. ' +
    `Recolour the hair to ${colourName(input.baseColor)}${extra}. ` +
    'Keep the natural shine and the shadows where the hair meets the scalp, so the new colour looks grown ' +
    'rather than painted on. Photographic, sharp, salon-quality result.'
  );
}

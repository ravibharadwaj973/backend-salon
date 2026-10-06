import { z } from 'zod';
import type { FaceShape, HairDensity, HairLength, HairTexture } from '@prisma/client';
import { kindByKey } from './hairstyle-kinds';

/**
 * WHAT A STYLE WILL AND WILL NOT ACCEPT.
 *
 * Every control the studio shows is a promise that a stylist can produce the
 * result. This file is where that promise is checked, and it is pure on purpose:
 * the same rules decide what the configurator renders, what the API accepts and
 * what a test can assert, without a database.
 *
 * Two layers, and they check different things:
 *
 *   checkCatalogEntry  what the SALON may offer  — bounded by the generator
 *   checkDesign        what the CUSTOMER may ask — bounded by the salon's entry
 *
 * The second one is not a formality. A salon that has turned bangs off for its
 * blunt cut has made a decision about its own chair; accepting a design with
 * curtain bangs anyway means a customer walks in holding a picture of something
 * nobody at that salon agreed to cut.
 */

export const HEX = /^#[0-9a-fA-F]{6}$/;

const hex = z.string().regex(HEX, 'A colour must be a hex value like #3B2417');

export const INTENSITIES = ['SUBTLE', 'MEDIUM', 'STRONG'] as const;
export const BANGS = ['NONE', 'CURTAIN', 'STRAIGHT', 'SIDE', 'WISPY', 'MICRO'] as const;
export const LAYERS = ['NONE', 'LIGHT', 'MEDIUM', 'HEAVY'] as const;
export const PARTINGS = ['CENTER', 'LEFT', 'RIGHT', 'DEEP_SIDE', 'NATURAL'] as const;
export const FADE_TYPES = ['LOW', 'MID', 'HIGH'] as const;
/** Clipper guards, as a barber says them. 0 is skin. */
export const FADE_GUARDS = [0, 0.5, 1, 2, 3] as const;
export const BALAYAGE_PLACEMENTS = ['MID', 'ENDS', 'FULL'] as const;

const tint = z.object({
  enabled: z.boolean().default(false),
  color: hex,
  intensity: z.enum(INTENSITIES).default('MEDIUM'),
});

export const designConfigSchema = z
  .object({
    highlights: tint.optional(),
    lowlights: tint.optional(),
    balayage: tint.extend({ placement: z.enum(BALAYAGE_PLACEMENTS).default('ENDS') }).optional(),
    ombre: z
      .object({
        enabled: z.boolean().default(false),
        rootColor: hex,
        midColor: hex.optional(),
        endColor: hex,
      })
      .optional(),
    moneyPiece: z.object({ enabled: z.boolean().default(false), color: hex }).optional(),
    faceFraming: z.object({ enabled: z.boolean().default(false), color: hex }).optional(),
    rootShadow: z
      .object({
        enabled: z.boolean().default(false),
        color: hex,
        /** How far down the shadow reaches, and how softly it lands. */
        depth: z.number().int().min(0).max(100).default(30),
        blend: z.number().int().min(0).max(100).default(50),
      })
      .optional(),

    bangs: z.enum(BANGS).default('NONE'),
    layers: z.enum(LAYERS).default('NONE'),
    /** Only meaningful with layers; 0 means none at the face. */
    faceFramingLayers: z.number().int().min(0).max(100).optional(),
    parting: z.enum(PARTINGS).default('NATURAL'),

    /**
     * HAND-PAINTED SECTIONS, IN THE PICTURE'S OWN COORDINATES.
     *
     * x and y are where on the photograph somebody tapped, 0-1 from the top left.
     * They were an angle around a 3D head until the studio became a photograph;
     * nothing had shipped, so the shape was replaced rather than carried.
     *
     * This schema is `.strip()`ed, which is right — the studio grows controls
     * faster than this API is redeployed — and the cost is that a key it does not
     * know is DROPPED IN SILENCE. A section painted on screen would look perfect
     * until somebody pressed Save and then not exist, with no error anywhere. The
     * test beside this file exists for exactly that.
     */
    strips: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64),
          color: hex,
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().int().min(0).max(100),
          blend: z.number().int().min(0).max(100),
          strength: z.number().int().min(0).max(100),
        }),
      )
      // Six is already more sections than anyone foils by hand, and it is what
      // the shader's fixed loop reads. An unbounded array here is also a JSON
      // column somebody can grow until a row stops fitting.
      .max(6)
      .optional(),

    /**
     * THE COLOUR, AS THE PHOTOGRAPH NEEDS IT.
     *
     * `lift` is the one field with no counterpart in the old mannequin studio and
     * the one that makes the whole thing work: you cannot turn black hair blonde
     * by changing hue, because black has nowhere to go. It is the bleach step —
     * how far the hair's own luminance is rescaled onto the target's level —
     * and without it every dark base stays dark whatever colour is chosen.
     */
    photo: z
      .object({
        lift: z.number().int().min(0).max(100).default(50),
        /**
         * The three that apply to any hairstyle, 50 meaning "as photographed".
         *
         * They are properties of HAIR rather than of a cut — which is why they
         * are here and not on the catalogue entry, and why a salon adding its
         * thirty-fourth style gets them for nothing.
         */
        density: z.number().int().min(0).max(100).default(50),
        shine: z.number().int().min(0).max(100).default(50),
        intensity: z.number().int().min(0).max(100).default(50),
        highlightColor: hex.optional(),
        highlightAmount: z.number().int().min(0).max(100).default(0),
        highlightFace: z.boolean().default(false),
        rootColor: hex.optional(),
        rootDepth: z.number().int().min(0).max(100).default(0),
        endsColor: hex.optional(),
        endsAmount: z.number().int().min(0).max(100).default(0),
        endsStart: z.number().int().min(0).max(100).default(55),
      })
      .optional(),

    fade: z
      .object({
        type: z.enum(FADE_TYPES).default('MID'),
        guard: z.union([z.literal(0), z.literal(0.5), z.literal(1), z.literal(2), z.literal(3)]).default(1),
        topLength: z.number().int().min(0).max(100).default(50),
      })
      .optional(),
  })
  // Unknown keys are dropped rather than rejected: the studio will grow controls
  // faster than this API is redeployed, and a saved look is worth more than a
  // strict error about a field nobody has shipped a reader for yet.
  .strip();

export type DesignConfig = z.infer<typeof designConfigSchema>;

export interface StyleCapabilities {
  kind: string;
  /** Empty means "all of them" — a salon that never answered has not refused. */
  supportedTextures: HairTexture[];
  supportedLengths: HairLength[];
  supportedDensities: HairDensity[];
  supportsBangs: boolean;
  supportsLayers: boolean;
  supportsParting: boolean;
  supportsFade: boolean;
}

export interface DesignShape {
  texture: HairTexture;
  length: HairLength;
  density: HairDensity;
  volume: number;
  baseColor: string;
  config: DesignConfig;
}

function allows<T>(allowed: T[], value: T): boolean {
  return allowed.length === 0 || allowed.includes(value);
}

/**
 * The salon's own entry, bounded by what the generator can draw.
 *
 * A salon may narrow a generator — offering a bob only in medium — and may not
 * widen one. Letting it tick "coily" on a blunt cut would put a control on the
 * screen that produces a straight blunt line whatever the customer picks, which
 * reads as a broken product rather than an honest limit.
 */
export function checkCatalogEntry(entry: {
  kind: string;
  supportedTextures?: HairTexture[];
  supportedLengths?: HairLength[];
  supportedDensities?: HairDensity[];
  recommendedFaceShapes?: FaceShape[];
  supportsBangs?: boolean;
  supportsLayers?: boolean;
  supportsParting?: boolean;
  supportsFade?: boolean;
}): string[] {
  const kind = kindByKey(entry.kind);
  if (!kind) return [`"${entry.kind}" is not a style the studio can draw.`];

  const errors: string[] = [];

  for (const texture of entry.supportedTextures ?? []) {
    if (!kind.textures.includes(texture)) {
      errors.push(`A ${kind.label.toLowerCase()} cannot be drawn in ${texture.toLowerCase()} hair.`);
    }
  }
  for (const length of entry.supportedLengths ?? []) {
    if (!kind.lengths.includes(length)) {
      errors.push(`A ${kind.label.toLowerCase()} is not a ${length.toLowerCase().replace('_', ' ')} cut.`);
    }
  }
  for (const density of entry.supportedDensities ?? []) {
    if (!kind.densities.includes(density)) {
      errors.push(`A ${kind.label.toLowerCase()} does not work at ${density.toLowerCase()} density.`);
    }
  }

  if (entry.supportsBangs && !kind.supportsBangs) errors.push(`A ${kind.label.toLowerCase()} does not take bangs.`);
  if (entry.supportsLayers && !kind.supportsLayers) errors.push(`A ${kind.label.toLowerCase()} does not take layers.`);
  if (entry.supportsParting && !kind.supportsParting) errors.push(`A ${kind.label.toLowerCase()} has no parting.`);
  if (entry.supportsFade && !kind.supportsFade) errors.push(`A ${kind.label.toLowerCase()} does not take a fade.`);

  return errors;
}

/**
 * The customer's design, bounded by the salon's entry.
 *
 * Returns every problem rather than the first, because a configurator that
 * reports one error at a time makes the person fix a form five times.
 */
export function checkDesign(style: StyleCapabilities, design: DesignShape): string[] {
  const kind = kindByKey(style.kind);
  if (!kind) return [`"${style.kind}" is not a style the studio can draw.`];

  const errors: string[] = [];
  const label = kind.label.toLowerCase();

  if (!allows(style.supportedTextures, design.texture)) {
    errors.push(`This ${label} is not offered in ${design.texture.toLowerCase()} hair.`);
  }
  if (!allows(style.supportedLengths, design.length)) {
    errors.push(`This ${label} is not offered at ${design.length.toLowerCase().replace('_', ' ')} length.`);
  }
  if (!allows(style.supportedDensities, design.density)) {
    errors.push(`This ${label} is not offered at ${design.density.toLowerCase()} density.`);
  }

  if (design.volume < 0 || design.volume > 100) errors.push('Volume runs from 0 to 100.');
  if (!HEX.test(design.baseColor)) errors.push('A colour must be a hex value like #3B2417.');

  const config = design.config;

  if (!style.supportsBangs && config.bangs !== 'NONE') {
    errors.push(`This ${label} is not offered with bangs.`);
  }
  if (!style.supportsLayers && config.layers !== 'NONE') {
    errors.push(`This ${label} is not offered with layers.`);
  }
  // Face-framing layers are layers. Allowing them through while layers are off
  // is how an "unlayered" cut arrives at the chair with layers at the face.
  if (!style.supportsLayers && (config.faceFramingLayers ?? 0) > 0) {
    errors.push(`This ${label} is not offered with face-framing layers.`);
  }
  if (!style.supportsParting && config.parting !== 'NATURAL') {
    errors.push(`This ${label} has no parting to set.`);
  }
  if (!style.supportsFade && config.fade) {
    errors.push(`This ${label} is not offered with a fade.`);
  }

  /*
   * Colour has one hard physical limit worth encoding: a gradient needs length
   * to happen over. Everything else about colour is the colourist's judgement
   * and none of this file's business, but root-to-ends on a buzz cut is not a
   * taste I am overruling — it is a centimetre of hair.
   */
  if (design.length === 'VERY_SHORT') {
    if (config.ombre?.enabled) errors.push('There is not enough length for an ombre on a very short cut.');
    if (config.balayage?.enabled) errors.push('There is not enough length for balayage on a very short cut.');
  }

  return errors;
}

/**
 * Fill in what a style implies, so the studio and the saved record agree.
 *
 * Called after checkDesign passes. It only clears what the style cannot do —
 * it never invents a choice the customer did not make.
 */
export function normaliseConfig(style: StyleCapabilities, config: DesignConfig): DesignConfig {
  return {
    ...config,
    bangs: style.supportsBangs ? config.bangs : 'NONE',
    layers: style.supportsLayers ? config.layers : 'NONE',
    faceFramingLayers: style.supportsLayers ? config.faceFramingLayers : undefined,
    parting: style.supportsParting ? config.parting : 'NATURAL',
    fade: style.supportsFade ? config.fade : undefined,
  };
}

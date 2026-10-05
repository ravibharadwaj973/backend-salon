import { describe, expect, it } from 'vitest';
import {
  checkCatalogEntry,
  checkDesign,
  designConfigSchema,
  normaliseConfig,
  type DesignConfig,
  type StyleCapabilities,
} from '../src/modules/hair-studio/design-rules';
import { HAIRSTYLE_KINDS } from '../src/modules/hair-studio/hairstyle-kinds';

/**
 * WHY THESE RULES EXIST AT ALL.
 *
 * Every control the studio puts on screen is a promise that somebody in that
 * salon can cut the result. The failure mode is not a crash — it is a customer
 * arriving with a picture of a bob with a skin fade and curtain bangs, which
 * the configurator happily drew and nobody agreed to cut. These tests are the
 * record of which promises the system is allowed to make.
 */

const config = (over: Partial<DesignConfig> = {}): DesignConfig =>
  designConfigSchema.parse({ bangs: 'NONE', layers: 'NONE', parting: 'NATURAL', ...over });

const style = (over: Partial<StyleCapabilities> = {}): StyleCapabilities => ({
  kind: 'bob',
  supportedTextures: [],
  supportedLengths: [],
  supportedDensities: [],
  supportsBangs: true,
  supportsLayers: true,
  supportsParting: true,
  supportsFade: false,
  ...over,
});

const design = (over: Partial<Parameters<typeof checkDesign>[1]> = {}) => ({
  texture: 'STRAIGHT' as const,
  length: 'MEDIUM' as const,
  density: 'MEDIUM' as const,
  volume: 50,
  baseColor: '#3B2417',
  config: config(),
  ...over,
});

describe('a salon may narrow a generator, never widen it', () => {
  it('refuses a kind the studio has no generator for', () => {
    // The worst possible failure for this screen is a bald head and no error,
    // so an unknown kind is caught at the only point it can be.
    expect(checkCatalogEntry({ kind: 'mullet_supreme' })).toHaveLength(1);
  });

  it('lets a salon offer a bob in straight hair only', () => {
    expect(checkCatalogEntry({ kind: 'bob', supportedTextures: ['STRAIGHT'] })).toEqual([]);
  });

  it('refuses coily on a blunt cut, because a blunt line is the point of it', () => {
    expect(checkCatalogEntry({ kind: 'blunt_cut', supportedTextures: ['COILY'] })).toHaveLength(1);
  });

  it('refuses a fade on a bob', () => {
    expect(checkCatalogEntry({ kind: 'bob', supportsFade: true })).toHaveLength(1);
  });

  it('allows a fade on a fade', () => {
    expect(checkCatalogEntry({ kind: 'fade', supportsFade: true })).toEqual([]);
  });

  it('refuses layers on a blunt cut and a parting on a buzz cut', () => {
    expect(checkCatalogEntry({ kind: 'blunt_cut', supportsLayers: true })).toHaveLength(1);
    expect(checkCatalogEntry({ kind: 'buzz_cut', supportsParting: true })).toHaveLength(1);
  });
});

describe('an unanswered question is not a refusal', () => {
  /**
   * Empty arrays mean "all of them". A salon that has added a style without
   * filling in the texture list has not thereby said the style may not be cut
   * in any texture — and reading it that way would make every freshly added
   * style impossible to design with.
   */
  it('accepts any texture, length and density when the salon specified none', () => {
    expect(checkDesign(style(), design({ texture: 'COILY', length: 'VERY_LONG', density: 'HIGH' }))).toEqual([]);
  });

  it('still enforces a list once the salon has given one', () => {
    const narrowed = style({ supportedLengths: ['SHORT', 'MEDIUM'] });
    expect(checkDesign(narrowed, design({ length: 'MEDIUM' }))).toEqual([]);
    expect(checkDesign(narrowed, design({ length: 'VERY_LONG' }))).toHaveLength(1);
  });
});

describe('a design cannot ask for what the salon does not offer', () => {
  it('refuses bangs on a style that does not take them', () => {
    const noBangs = style({ supportsBangs: false });
    expect(checkDesign(noBangs, design({ config: config({ bangs: 'CURTAIN' }) }))).toHaveLength(1);
  });

  it('refuses face-framing layers when layers are off, not just the layers field', () => {
    /*
     * The one that would have slipped through. Face-framing layers are layers;
     * checking only `layers` lets an "unlayered" cut reach the chair with
     * layers cut at the face, which is exactly the argument this product is
     * supposed to prevent.
     */
    const noLayers = style({ supportsLayers: false });
    expect(checkDesign(noLayers, design({ config: config({ layers: 'NONE', faceFramingLayers: 40 }) }))).toHaveLength(1);
  });

  it('refuses a parting on a buzz cut, where there is nothing to part', () => {
    const noParting = style({ kind: 'buzz_cut', supportsParting: false, supportsLayers: false, supportsBangs: false });
    expect(checkDesign(noParting, design({ config: config({ parting: 'DEEP_SIDE' }) }))).toHaveLength(1);
    expect(checkDesign(noParting, design({ config: config({ parting: 'NATURAL' }) }))).toEqual([]);
  });

  it('refuses a fade on a style without one, and allows it on one with', () => {
    const faded = config({ fade: { type: 'MID', guard: 1, topLength: 60 } });
    expect(checkDesign(style({ supportsFade: false }), design({ config: faded }))).toHaveLength(1);
    expect(
      checkDesign(style({ kind: 'fade', supportsFade: true, supportsBangs: false, supportsLayers: false }), design({ config: faded })),
    ).toEqual([]);
  });

  it('reports every problem at once rather than one at a time', () => {
    // A configurator that surfaces one error per submit makes somebody fix the
    // same form five times.
    const strict = style({ supportsBangs: false, supportsLayers: false, supportedLengths: ['SHORT'] });
    const bad = design({ length: 'LONG', config: config({ bangs: 'SIDE', layers: 'HEAVY' }) });
    expect(checkDesign(strict, bad).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the one physical limit colour has', () => {
  /**
   * Everything else about colour is the colourist's judgement and none of this
   * code's business. A root-to-ends gradient on a centimetre of hair is not a
   * taste being overruled; there is nowhere for it to happen.
   */
  const long = style({ supportsFade: false });

  it('refuses an ombre and balayage on a very short cut', () => {
    const ombre = config({ ombre: { enabled: true, rootColor: '#1C1917', endColor: '#C58B55' } });
    const balayage = config({ balayage: { enabled: true, color: '#C58B55', intensity: 'MEDIUM', placement: 'ENDS' } });
    expect(checkDesign(long, design({ length: 'VERY_SHORT', config: ombre }))).toHaveLength(1);
    expect(checkDesign(long, design({ length: 'VERY_SHORT', config: balayage }))).toHaveLength(1);
  });

  it('allows both from short upwards', () => {
    const ombre = config({ ombre: { enabled: true, rootColor: '#1C1917', endColor: '#C58B55' } });
    expect(checkDesign(long, design({ length: 'SHORT', config: ombre }))).toEqual([]);
  });

  it('leaves a switched-off gradient alone, however short the cut', () => {
    // Carrying the colours with `enabled: false` is how the studio remembers
    // what you had when you toggle it back on. It is not a request.
    const parked = config({ ombre: { enabled: false, rootColor: '#1C1917', endColor: '#C58B55' } });
    expect(checkDesign(long, design({ length: 'VERY_SHORT', config: parked }))).toEqual([]);
  });
});

describe('the config a design is saved with', () => {
  it('rejects a colour that is not a hex value', () => {
    expect(designConfigSchema.safeParse({ highlights: { enabled: true, color: 'caramel' } }).success).toBe(false);
  });

  it('drops a control this version has never heard of rather than refusing the save', () => {
    // The studio will grow controls faster than this API is redeployed, and a
    // saved look is worth more than a strict error about a field nobody can
    // read yet.
    const parsed = designConfigSchema.parse({ bangs: 'WISPY', glitterRoots: true });
    expect(parsed.bangs).toBe('WISPY');
    expect(parsed as Record<string, unknown>).not.toHaveProperty('glitterRoots');
  });

  it('clears what the style cannot do and keeps what it can', () => {
    const plain = style({ supportsBangs: false, supportsLayers: false, supportsParting: false, supportsFade: false });
    const asked = config({
      bangs: 'CURTAIN',
      layers: 'HEAVY',
      faceFramingLayers: 30,
      parting: 'LEFT',
      fade: { type: 'HIGH', guard: 0, topLength: 80 },
      highlights: { enabled: true, color: '#C58B55', intensity: 'STRONG' },
    });

    const out = normaliseConfig(plain, asked);
    expect(out).toMatchObject({ bangs: 'NONE', layers: 'NONE', parting: 'NATURAL' });
    expect(out.fade).toBeUndefined();
    expect(out.faceFramingLayers).toBeUndefined();
    // Colour is not a cut, so nothing here touches it.
    expect(out.highlights).toEqual({ enabled: true, color: '#C58B55', intensity: 'STRONG' });
  });
});

describe('the starter catalogue the salon is handed', () => {
  /**
   * The registry is written by hand, so it is the thing most likely to drift
   * out of agreement with the validator that guards it. If these ever fail, a
   * salon pressing "install" gets rows its own API would refuse to save.
   */
  it('produces only entries this API would accept', () => {
    for (const kind of HAIRSTYLE_KINDS) {
      const errors = checkCatalogEntry({
        kind: kind.key,
        supportedTextures: kind.textures,
        supportedLengths: kind.lengths,
        supportedDensities: kind.densities,
        recommendedFaceShapes: kind.faceShapes,
        supportsBangs: kind.supportsBangs,
        supportsLayers: kind.supportsLayers,
        supportsParting: kind.supportsParting,
        supportsFade: kind.supportsFade,
      });
      expect(errors, `${kind.key} would be refused: ${errors.join(' ')}`).toEqual([]);
    }
  });

  it('gives every generator something to draw and something to sell', () => {
    for (const kind of HAIRSTYLE_KINDS) {
      expect(kind.textures.length, kind.key).toBeGreaterThan(0);
      expect(kind.lengths.length, kind.key).toBeGreaterThan(0);
      expect(kind.densities.length, kind.key).toBeGreaterThan(0);
      expect(kind.variants.length, kind.key).toBeGreaterThan(0);
    }
  });

  it('has no two menu entries that would collide on the catalogue unique key', () => {
    // (tenantId, kind, name) is unique, so a repeated name inside one kind
    // would make `install starter` silently drop a style.
    const seen = new Set<string>();
    for (const kind of HAIRSTYLE_KINDS) {
      for (const name of kind.variants) {
        const key = `${kind.key}::${name}`;
        expect(seen.has(key), `duplicate ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('has unique generator keys', () => {
    const keys = HAIRSTYLE_KINDS.map((kind) => kind.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

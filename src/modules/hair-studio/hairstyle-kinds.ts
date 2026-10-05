import type { FaceShape, Gender, HairDensity, HairLength, HairMaintenance, HairTexture } from '@prisma/client';

/**
 * WHAT THE STUDIO CAN ACTUALLY DRAW.
 *
 * A `kind` is a parametric generator in the 3D studio, not a file and not a
 * salon's menu item. The salon's menu lives in HairstyleCatalog and points at
 * one of these; several menu items may share a generator, which is why the
 * catalogue is unique on (tenant, kind, name) and not on (tenant, kind). "Low
 * Fade", "Mid Fade" and "High Fade" are three things a salon sells and one
 * thing the engine draws.
 *
 * This list is the contract between the two repositories. The backend owns
 * WHICH kinds exist, the studio owns how each one looks, and the catalogue
 * editor reads this list over the API so a salon cannot save a style that
 * renders a bald head. Adding a generator means adding it here too — the
 * coupling is deliberate and visible rather than discovered in production.
 *
 * Bangs, layers and parting are NOT kinds, though a salon may well advertise
 * "curtain bangs" as a service. They are modifiers that apply across many cuts,
 * so they live in a design's config where they can be combined, rather than
 * multiplying the generator list by six.
 */
export interface HairstyleKind {
  key: string;
  label: string;
  gender: Gender;
  category: string;
  /** What the generator can draw. A texture missing here is one it cannot do. */
  textures: HairTexture[];
  lengths: HairLength[];
  densities: HairDensity[];
  /** Advice, never a restriction: a salon may cut what the customer asks for. */
  faceShapes: FaceShape[];
  supportsBangs: boolean;
  supportsLayers: boolean;
  supportsParting: boolean;
  supportsFade: boolean;
  maintenance: HairMaintenance;
  /**
   * The menu entries a salon gets for this generator when it installs the
   * starter catalogue. One generator, several things to sell.
   */
  variants: string[];
}

const ALL_TEXTURES: HairTexture[] = ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'];
const SOFT_TEXTURES: HairTexture[] = ['STRAIGHT', 'WAVY', 'CURLY'];
const ALL_DENSITIES: HairDensity[] = ['LOW', 'MEDIUM', 'HIGH'];

export const HAIRSTYLE_KINDS: HairstyleKind[] = [
  // ------------------------------------------------------------- women ----
  {
    key: 'bob',
    label: 'Bob',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'HEART', 'DIAMOND'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'MEDIUM',
    variants: ['Bob', 'Chin-length bob', 'A-line bob'],
  },
  {
    key: 'lob',
    label: 'Lob',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'SQUARE', 'HEART'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'LOW',
    variants: ['Lob'],
  },
  {
    key: 'pixie',
    label: 'Pixie',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['VERY_SHORT', 'SHORT'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'HEART', 'DIAMOND'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    // A pixie is very often tapered at the nape, so the fade control earns
    // its place here even though this is not a barber cut.
    supportsFade: true,
    maintenance: 'HIGH',
    variants: ['Pixie', 'Long pixie'],
  },
  {
    key: 'butterfly_cut',
    label: 'Butterfly cut',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['MEDIUM', 'LONG', 'VERY_LONG'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'HEART', 'DIAMOND'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'MEDIUM',
    variants: ['Butterfly cut'],
  },
  {
    key: 'layered_cut',
    label: 'Layered cut',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: ALL_TEXTURES,
    lengths: ['MEDIUM', 'LONG', 'VERY_LONG'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'LOW',
    variants: ['Layered cut', 'Long layers', 'Short layers'],
  },
  {
    key: 'wolf_cut',
    label: 'Wolf cut',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['MEDIUM', 'LONG'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'HEART'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'MEDIUM',
    variants: ['Wolf cut'],
  },
  {
    key: 'shag',
    label: 'Shag',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['SHORT', 'MEDIUM', 'LONG'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'SQUARE', 'OBLONG'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'MEDIUM',
    variants: ['Shag'],
  },
  {
    key: 'blunt_cut',
    label: 'Blunt cut',
    gender: 'FEMALE',
    category: "Women's haircut",
    // A blunt line is the point of this cut, and coily hair does not hold one
    // without chemical straightening. Offering it would be a promise the chair
    // cannot keep.
    textures: ['STRAIGHT', 'WAVY'],
    lengths: ['SHORT', 'MEDIUM', 'LONG'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'HEART'],
    supportsBangs: true,
    supportsLayers: false,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'MEDIUM',
    variants: ['Blunt cut'],
  },
  {
    key: 'long_loose',
    label: 'Long and loose',
    gender: 'FEMALE',
    category: "Women's haircut",
    textures: ALL_TEXTURES,
    lengths: ['LONG', 'VERY_LONG'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: false,
    maintenance: 'LOW',
    variants: ['Straight long hair', 'Wavy long hair', 'Curly long hair'],
  },

  // --------------------------------------------------------------- men ----
  {
    key: 'fade',
    label: 'Fade',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ALL_TEXTURES,
    lengths: ['VERY_SHORT', 'SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'],
    supportsBangs: false,
    supportsLayers: false,
    supportsParting: true,
    supportsFade: true,
    // Skin at the sides grows out visibly in a fortnight. The highest-upkeep
    // cut a salon sells, and the one worth saying so about.
    maintenance: 'HIGH',
    variants: ['Low fade', 'Mid fade', 'High fade', 'Skin fade'],
  },
  {
    key: 'taper',
    label: 'Taper',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ALL_TEXTURES,
    lengths: ['VERY_SHORT', 'SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'],
    supportsBangs: false,
    supportsLayers: false,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'MEDIUM',
    variants: ['Taper', 'Taper fade'],
  },
  {
    key: 'buzz_cut',
    label: 'Buzz cut',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ALL_TEXTURES,
    lengths: ['VERY_SHORT'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'SQUARE', 'DIAMOND'],
    supportsBangs: false,
    supportsLayers: false,
    // There is nothing to part.
    supportsParting: false,
    supportsFade: true,
    maintenance: 'LOW',
    variants: ['Buzz cut'],
  },
  {
    key: 'crew_cut',
    label: 'Crew cut',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ALL_TEXTURES,
    lengths: ['VERY_SHORT', 'SHORT'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'SQUARE', 'OBLONG'],
    supportsBangs: false,
    supportsLayers: false,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'MEDIUM',
    variants: ['Crew cut'],
  },
  {
    key: 'crop',
    label: 'Crop',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ALL_TEXTURES,
    lengths: ['SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'OBLONG', 'DIAMOND'],
    supportsBangs: true,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'MEDIUM',
    variants: ['Textured crop', 'French crop'],
  },
  {
    key: 'quiff',
    label: 'Quiff',
    gender: 'MALE',
    category: "Men's haircut",
    textures: SOFT_TEXTURES,
    lengths: ['SHORT', 'MEDIUM'],
    densities: ['MEDIUM', 'HIGH'],
    faceShapes: ['OVAL', 'ROUND', 'SQUARE'],
    supportsBangs: false,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'HIGH',
    variants: ['Quiff'],
  },
  {
    key: 'pompadour',
    label: 'Pompadour',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ['STRAIGHT', 'WAVY'],
    lengths: ['SHORT', 'MEDIUM'],
    densities: ['MEDIUM', 'HIGH'],
    faceShapes: ['OVAL', 'ROUND', 'SQUARE'],
    supportsBangs: false,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'HIGH',
    variants: ['Pompadour'],
  },
  {
    key: 'slick_back',
    label: 'Slick back',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ['STRAIGHT', 'WAVY'],
    lengths: ['SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'SQUARE', 'DIAMOND'],
    supportsBangs: false,
    supportsLayers: false,
    supportsParting: false,
    supportsFade: true,
    maintenance: 'MEDIUM',
    variants: ['Slick back'],
  },
  {
    key: 'undercut',
    label: 'Undercut',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ALL_TEXTURES,
    lengths: ['SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'HEART'],
    supportsBangs: false,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'HIGH',
    variants: ['Undercut', 'Disconnected undercut'],
  },
  {
    key: 'side_part',
    label: 'Side part',
    gender: 'MALE',
    category: "Men's haircut",
    textures: ['STRAIGHT', 'WAVY'],
    lengths: ['SHORT', 'MEDIUM'],
    densities: ALL_DENSITIES,
    faceShapes: ['OVAL', 'ROUND', 'OBLONG', 'HEART'],
    supportsBangs: false,
    supportsLayers: true,
    supportsParting: true,
    supportsFade: true,
    maintenance: 'MEDIUM',
    variants: ['Side part', 'Messy side part'],
  },
];

const BY_KEY = new Map(HAIRSTYLE_KINDS.map((kind) => [kind.key, kind]));

export function kindByKey(key: string): HairstyleKind | undefined {
  return BY_KEY.get(key);
}

export function isKnownKind(key: string): boolean {
  return BY_KEY.has(key);
}

/** The keys, for an error message that tells the caller what IS allowed. */
export function knownKindKeys(): string[] {
  return HAIRSTYLE_KINDS.map((kind) => kind.key);
}

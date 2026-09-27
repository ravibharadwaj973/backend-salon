/**
 * The one bucket that is not a service category.
 *
 * A literal rather than a nullable column: 'studio' is a real place a
 * photograph belongs, and null would mean "unfiled", which is a different
 * thing and would need its own handling everywhere.
 */
export const STUDIO_KEY = 'studio';

/**
 * The Cloudinary tag for a collection.
 *
 * Derived from the NAME rather than the id, because a human types this into
 * Cloudinary when they upload there directly — `gallery-nails` is something an
 * owner can read and retype, and `gallery-cmu2zhi40000gp4db` is not.
 *
 * Which means two categories named "Hair" and "hair" would collide. That is
 * fine: ServiceCategory is unique per tenant on name, so they cannot both
 * exist, and a collision across salons is prevented by the second tag the
 * upload always adds.
 */
export function collectionTag(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `gallery-${slug || 'other'}`;
}

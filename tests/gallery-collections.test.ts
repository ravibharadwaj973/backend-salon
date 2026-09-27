import { describe, expect, it } from 'vitest';
import { STUDIO_KEY, collectionTag } from '../src/modules/gallery/collections';

/**
 * THE GALLERY'S COLLECTIONS ARE THE SALON'S OWN CATEGORIES.
 *
 * They were a fixed list in the code — colour, cuts, treatments, skin, bridal —
 * which was wrong twice over. It assumed every salon is a hair-and-skin salon
 * (a nail bar has Nails, Extensions and Art; a barber has Beard and Fade), and
 * it was a SECOND list of something the salon already had. A customer reading
 * "Colour" in the gallery and "Hair" on the menu is reading about one thing
 * described two ways.
 *
 * What is left to test here is the tag, which is the one value that crosses a
 * boundary: a human types it into Cloudinary, so it has to be readable, stable
 * and free of anything that breaks a URL.
 */
describe('the Cloudinary tag for a collection', () => {
  it('is readable, because a person types it into Cloudinary', () => {
    // Derived from the NAME and not the id for exactly this reason:
    // "gallery-nails" can be retyped from memory, "gallery-cmu2zhi40000g" cannot.
    expect(collectionTag('Nails')).toBe('gallery-nails');
    expect(collectionTag('Hair')).toBe('gallery-hair');
  });

  it('survives the punctuation a real category name has in it', () => {
    // "Spa & Massage" is in the seed catalogue. An ampersand in a Cloudinary tag
    // is asking for trouble, and a space is not allowed at all.
    expect(collectionTag('Spa & Massage')).toBe('gallery-spa-and-massage');
    expect(collectionTag("Men's Grooming")).toBe('gallery-men-s-grooming');
    expect(collectionTag('Hair — Colour')).toBe('gallery-hair-colour');
  });

  it('never trails or doubles a separator', () => {
    expect(collectionTag('  Hair  ')).toBe('gallery-hair');
    // Each & becomes "and" before separators collapse, so this degenerate input
    // gives "andandand". Ugly, and correct: what matters is that no separator
    // doubles up and none trails.
    expect(collectionTag('Hair &&& Skin')).toBe('gallery-hair-andandand-skin');
    expect(collectionTag('Hair / Skin')).toBe('gallery-hair-skin');
    expect(collectionTag('...')).toBe('gallery-other');
  });

  it('always produces a usable tag, whatever the name is', () => {
    /**
     * A category named entirely in Devanagari is a real possibility for an
     * Indian salon, and it strips to nothing here. "gallery-" alone would be a
     * tag that silently matches every collection, so it falls back to a word.
     */
    expect(collectionTag('बाल')).toBe('gallery-other');
    expect(collectionTag('')).toBe('gallery-other');
  });

  it('bounds the length, because a tag is not a description', () => {
    const tag = collectionTag('x'.repeat(200));
    expect(tag.length).toBeLessThanOrEqual('gallery-'.length + 40);
  });

  it('keeps the studio bucket distinct from any category', () => {
    // 'studio' is a real place a photograph belongs — the room, the tools, the
    // shopfront — and deliberately not a nullable column, because null would
    // mean "unfiled", which is a different thing needing its own handling.
    expect(STUDIO_KEY).toBe('studio');
    expect(collectionTag('studio')).toBe('gallery-studio');
  });
});

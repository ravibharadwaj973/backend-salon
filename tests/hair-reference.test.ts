import { describe, expect, it } from 'vitest';
import { thumbnail } from '../src/modules/gallery/thumbnail';
import { buildReferencePrompt } from '../src/modules/hair-studio/hair-prompt';
import type { PromptInput } from '../src/modules/hair-studio/hair-prompt';

/**
 * Both of these fail QUIETLY, which is why they are pinned.
 *
 * A thumbnail helper that stops recognising a url returns the full-size picture:
 * the page still works, it is just slow, and nobody files that. A reference
 * prompt that stops saying "fictional" produces pictures that look exactly as
 * good as the ones before it.
 */

const CLOUDINARY = 'https://res.cloudinary.com/demo/image/upload/v1700000000/parlon/salon/bob.jpg';

describe('thumbnail', () => {
  it('inserts the transformation after /upload/ and leaves the rest alone', () => {
    const small = thumbnail(CLOUDINARY, { width: 400 });
    expect(small).toContain('/image/upload/w_400,h_400,c_fill,g_face,q_auto,f_auto/');
    expect(small).toContain('/v1700000000/parlon/salon/bob.jpg');
  });

  /**
   * A centre crop of a portrait cuts the top of the head off, which on a page
   * about haircuts removes the only part that matters.
   */
  it('keeps the head in frame on a square crop', () => {
    expect(thumbnail(CLOUDINARY)).toContain('g_face');
  });

  it('serves a modern format and an automatic quality', () => {
    const small = thumbnail(CLOUDINARY)!;
    expect(small).toContain('f_auto');
    expect(small).toContain('q_auto');
  });

  it('can fit rather than crop, for somewhere a ragged edge is fine', () => {
    const fitted = thumbnail(CLOUDINARY, { crop: 'fit', width: 800 })!;
    expect(fitted).toContain('w_800,c_fit');
    expect(fitted).not.toContain('c_fill');
  });

  /**
   * previewUrl is a plain string a salon may have pasted from anywhere. Rewriting
   * a path inside a url we do not own gives a 404 at best and somebody else's
   * picture at worst, so anything unrecognised comes back untouched — a full-size
   * picture is a correct answer to "show me this smaller".
   */
  it('refuses to rewrite a url it does not recognise', () => {
    const foreign = 'https://images.example.com/upload/some/hairstyle.jpg';
    expect(thumbnail(foreign)).toBe(foreign);
    expect(thumbnail('http://res.cloudinary.com/demo/image/upload/x.jpg')).toBe(
      'http://res.cloudinary.com/demo/image/upload/x.jpg',
    );
  });

  it('passes null and undefined straight through', () => {
    expect(thumbnail(null)).toBeNull();
    expect(thumbnail(undefined)).toBeNull();
  });

  it('bounds the width, so a caller cannot ask for a 40000px thumbnail', () => {
    expect(thumbnail(CLOUDINARY, { width: 99999 })).toContain('w_2000');
    expect(thumbnail(CLOUDINARY, { width: 1 })).toContain('w_32');
  });
});

const entry: PromptInput = {
  hairstyleKey: 'bob',
  styleName: 'Layered bob',
  gender: 'FEMALE',
  texture: 'WAVY',
  length: 'MEDIUM',
  density: 'MEDIUM',
  volume: 50,
  baseColor: '#3B2417',
  faceShape: 'OVAL',
  config: { bangs: 'NONE', layers: 'MEDIUM', parting: 'NATURAL' },
};

describe('buildReferencePrompt', () => {
  /**
   * This is the one picture here that ends up PUBLISHED on a salon's page rather
   * than shown across a counter, and the distinction between "a person" and "a
   * particular person" is the whole question once something is published.
   */
  it('asks for a fictional person, every time', () => {
    expect(buildReferencePrompt(entry)).toContain('fictional adult woman');
    expect(buildReferencePrompt({ ...entry, gender: 'MALE' })).toContain('fictional adult man');
    expect(buildReferencePrompt({ ...entry, gender: null })).toContain('fictional adult');
  });

  /**
   * Somebody browsing a look-book is looking for their own face in it, so a cut
   * advised for round faces shown on a sharply oval one is a picture that argues
   * against the advice printed beside it.
   */
  it('shows the cut on the face it is advised for', () => {
    expect(buildReferencePrompt({ ...entry, faceShape: 'ROUND' })).toContain('a round face');
    expect(buildReferencePrompt({ ...entry, faceShape: 'HEART' })).toContain('heart-shaped face');
  });

  it('omits the face when the style is advised for none', () => {
    const text = buildReferencePrompt({ ...entry, faceShape: null });
    expect(text).toContain('fictional adult woman, showing');
  });

  /** A reference image is judged on whether hair reads as hair at thumbnail size. */
  it('asks for visible strands and a plain background', () => {
    const text = buildReferencePrompt(entry);
    expect(text).toContain('individual hair strands');
    expect(text).toContain('studio background');
    expect(text).toContain('Front-facing');
  });

  it('still describes the actual haircut', () => {
    const text = buildReferencePrompt(entry);
    expect(text).toContain('layered bob');
    expect(text).toContain('collarbone');
    expect(text).toContain('dark chocolate brown');
    expect(text).not.toContain('#');
  });
});

import { describe, expect, it } from 'vitest';
import { buildContext, decodeDataUrl, signParams } from '../src/modules/gallery/cloudinary';

/**
 * THE SIGNATURE, PINNED TO AN INDEPENDENTLY COMPUTED VALUE.
 *
 * A signature that is subtly wrong comes back as "Invalid Signature" and
 * nothing else — no indication of which parameter, which order, or which
 * exclusion did it. That is a long afternoon, so the algorithm is pinned.
 *
 * Cloudinary's recipe: every signed parameter sorted by name, joined as a
 * query string, the secret appended, SHA-1. The constant below is that recipe
 * applied to the canonical string
 *
 *   public_id=sample_image&timestamp=1315060510abcd
 *
 * and computed OUTSIDE this codebase, with `sha1sum`, rather than copied from
 * anybody's memory of a documentation page. Recompute it the same way if you
 * ever need to doubt it:
 *
 *   printf '%s' 'public_id=sample_image&timestamp=1315060510abcd' | sha1sum
 *
 * If this fails after a refactor, the refactor is wrong.
 */
const KNOWN_SIGNATURE = 'b4ad47fb4e25c7bf5f92a20089f9db59bc302313';

describe('the upload signature', () => {
  it('is the SHA-1 of the canonical string with the secret appended', () => {
    expect(signParams({ public_id: 'sample_image', timestamp: '1315060510' }, 'abcd')).toBe(KNOWN_SIGNATURE);
  });

  it('sorts parameters by name rather than by the order they were written', () => {
    const a = signParams({ timestamp: '1315060510', public_id: 'sample_image' }, 'abcd');
    const b = signParams({ public_id: 'sample_image', timestamp: '1315060510' }, 'abcd');
    expect(a).toBe(b);
    expect(a).toBe(KNOWN_SIGNATURE);
  });

  it('leaves out the parameters Cloudinary excludes', () => {
    // file, api_key and resource_type are not signed. Including any of them
    // produces a signature the server rejects.
    const withExtras = signParams(
      {
        public_id: 'sample_image',
        timestamp: '1315060510',
        file: 'data:image/png;base64,AAAA',
        api_key: '1234567890',
        resource_type: 'image',
      },
      'abcd',
    );
    expect(withExtras).toBe(KNOWN_SIGNATURE);
  });

  it('leaves out empty values, which are not sent either', () => {
    // A signature covering a parameter the request omits fails, and an optional
    // field left blank is exactly how that happens in practice.
    expect(signParams({ public_id: 'sample_image', timestamp: '1315060510', context: '' }, 'abcd')).toBe(
      KNOWN_SIGNATURE,
    );
  });
});

describe('alt text on its way into Cloudinary’s context field', () => {
  it('carries alt and caption', () => {
    expect(buildContext({ alt: 'Balayage on dark hair', caption: 'Four hours, two sittings' })).toBe(
      'alt=Balayage on dark hair|caption=Four hours, two sittings',
    );
  });

  it('cannot be used to inject another field', () => {
    // context is a pipe-delimited key=value list. Without this, an alt text of
    // "before|caption=nonsense" would silently write a caption nobody typed —
    // and one reading "before=after" would create a field called "after".
    const context = buildContext({ alt: 'before|caption=nonsense', caption: 'a=b' });
    expect(context).toBe('alt=before caption nonsense|caption=a b');
    expect(context.split('|')).toHaveLength(2);
  });

  it('is empty when there is nothing to say, so the field is not sent at all', () => {
    expect(buildContext({})).toBe('');
    expect(buildContext({ alt: '   ' })).toBe('');
  });
});

describe('what may be uploaded', () => {
  /** A one-pixel PNG, as a browser would hand it over. */
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gFvXxYoAAAAAElFTkSuQmCC';

  it('accepts a real PNG', () => {
    const { contentType } = decodeDataUrl(PNG);
    expect(contentType).toBe('image/png');
  });

  it('refuses a file whose contents are not an image, whatever it claims to be', () => {
    // A browser will label anything image/jpeg if asked to. What gets served
    // back is decided by the bytes, so the bytes are what is checked.
    const pdf = 'data:image/jpeg;base64,' + Buffer.from('%PDF-1.7\nnot an image at all').toString('base64');
    expect(() => decodeDataUrl(pdf)).toThrow(/JPEG, PNG and WebP/);
  });

  it('refuses SVG even though it is an image', () => {
    // An SVG is a document that can carry a script, and it would be served back
    // under a content type that runs it. A gallery has no use for vector.
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64');
    expect(() => decodeDataUrl(svg)).toThrow();
  });

  it('refuses something that is not a data URL at all', () => {
    expect(() => decodeDataUrl('https://example.com/photo.jpg')).toThrow(/does not look like an image/);
    expect(() => decodeDataUrl('')).toThrow();
  });

  it('refuses an empty file rather than uploading nothing', () => {
    expect(() => decodeDataUrl('data:image/png;base64,' + Buffer.from('').toString('base64'))).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { linkSchema } from '../src/core/validators';
import { createBranchSchema, updateBranchSchema } from '../src/modules/branches/branch.schema';
import { DEFAULT_JOURNEYS, DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';

describe('the link an owner pastes in', () => {
  it('accepts what Google actually hands them', () => {
    for (const url of [
      'https://g.page/r/CxxxxxxxxxxxxEBM/review',
      'https://search.google.com/local/writereview?placeid=ChIJabc123',
      'https://maps.app.goo.gl/abc123',
    ]) {
      expect(linkSchema.parse(url)).toBe(url);
    }
  });

  it('puts the scheme on for them', () => {
    // Owners paste out of a browser bar, which hides "https://".
    expect(linkSchema.parse('g.page/r/CxxxxxxxxxxxxEBM/review')).toBe('https://g.page/r/CxxxxxxxxxxxxEBM/review');
    expect(linkSchema.parse('  g.page/r/abc/review  ')).toBe('https://g.page/r/abc/review');
  });

  it('treats an empty box as "clear it", not as an error', () => {
    expect(linkSchema.parse('')).toBe('');
  });

  it('refuses something that is not a web address', () => {
    for (const bad of ['just some words', 'javascript:alert(1)', 'ftp://files.example.com/x']) {
      expect(() => linkSchema.parse(bad), bad).toThrow();
    }
  });
});

describe('branch schema', () => {
  it('lets the owner set the review link per shop', () => {
    const parsed = updateBranchSchema.parse({ googleReviewUrl: 'g.page/r/abc/review' });
    expect(parsed.googleReviewUrl).toBe('https://g.page/r/abc/review');
  });

  it('does not require it — most branches will not have one on day one', () => {
    expect(() => createBranchSchema.parse({ name: 'Koramangala', code: 'KOR' })).not.toThrow();
  });
});

describe('the happy/unhappy split', () => {
  it('only the positive journey carries a Google link', () => {
    const byName = new Map(DEFAULT_TEMPLATES.map((t) => [t.name, t]));

    const positive = DEFAULT_JOURNEYS.find((j) => j.trigger === 'FEEDBACK_POSITIVE');
    const negative = DEFAULT_JOURNEYS.find((j) => j.trigger === 'FEEDBACK_NEGATIVE');
    expect(positive, 'a journey for 4-5 stars').toBeDefined();
    expect(negative, 'a journey for 1-3 stars').toBeDefined();

    const bodiesOf = (journey: (typeof DEFAULT_JOURNEYS)[number]) =>
      journey.steps
        .map((step) => ('templateName' in step ? byName.get(step.templateName as string) : undefined))
        .filter(Boolean)
        .map((template) => JSON.stringify(template));

    expect(bodiesOf(positive!).some((body) => body.includes('{{google_review_link}}'))).toBe(true);

    // The whole point of the gate: an unhappy customer is never handed the
    // public link. Sending them there is how a salon buys a one-star review.
    for (const body of bodiesOf(negative!)) {
      expect(body).not.toContain('{{google_review_link}}');
    }
  });
});

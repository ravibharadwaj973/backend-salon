import { describe, expect, it } from 'vitest';
import { readFormConfig } from '../src/modules/feedback/website-feedback.service';

/**
 * A PUBLIC FORM IS A FORM ANYBODY CAN FILL IN.
 *
 * Everything this config decides is about what a stranger can make happen on
 * a salon's website. The defaults have to be the safe answers, because a salon
 * that never opens this screen is a salon running whatever is written here.
 */

describe('the feedback form is off until somebody switches it on', () => {
  it('is off when the salon has never touched the setting', () => {
    // A form that exists by default is a form collecting strangers' phone
    // numbers on behalf of a salon that does not know it has one.
    expect(readFormConfig(undefined).enabled).toBe(false);
    expect(readFormConfig({}).enabled).toBe(false);
    expect(readFormConfig({ feedbackForm: {} }).enabled).toBe(false);
  });

  it('is only on for an explicit true, never for something truthy', () => {
    expect(readFormConfig({ feedbackForm: { enabled: 'yes' } }).enabled).toBe(false);
    expect(readFormConfig({ feedbackForm: { enabled: 1 } }).enabled).toBe(false);
    expect(readFormConfig({ feedbackForm: { enabled: true } }).enabled).toBe(true);
  });
});

describe('the salon’s own wording, with the app’s as a floor', () => {
  it('uses the salon’s heading and prompt when they wrote one', () => {
    const config = readFormConfig({
      feedbackForm: { heading: 'Tell Priya how it went', prompt: 'She reads these herself.' },
    });
    expect(config.heading).toBe('Tell Priya how it went');
    expect(config.prompt).toBe('She reads these herself.');
  });

  it('falls back rather than rendering a blank heading', () => {
    // A field cleared to spaces must not leave a heading-shaped hole on a
    // customer-facing page.
    const config = readFormConfig({ feedbackForm: { heading: '   ', prompt: '' } });
    expect(config.heading.length).toBeGreaterThan(0);
    expect(config.prompt.length).toBeGreaterThan(0);
  });

  it('caps the length, because this renders on somebody’s website', () => {
    const config = readFormConfig({ feedbackForm: { heading: 'x'.repeat(500) } });
    expect(config.heading.length).toBeLessThanOrEqual(80);
  });

  it('survives a settings blob of the wrong shape entirely', () => {
    // settings is a JSON column. Anything can be in there, including from an
    // older version of the app, and a customer-facing page must still render.
    expect(() => readFormConfig({ feedbackForm: 'nonsense' })).not.toThrow();
    expect(() => readFormConfig([1, 2, 3])).not.toThrow();
    expect(readFormConfig({ feedbackForm: { heading: 42 } }).heading.length).toBeGreaterThan(0);
  });
});

describe('asking for a phone number', () => {
  it('asks, and insists, unless told otherwise', () => {
    // The salon's reason for collecting feedback is to be able to answer it.
    // A complaint from nobody is a complaint nobody can put right.
    expect(readFormConfig({}).phone).toBe('required');
  });

  it('takes only the three answers it knows', () => {
    expect(readFormConfig({ feedbackForm: { phone: 'optional' } }).phone).toBe('optional');
    expect(readFormConfig({ feedbackForm: { phone: 'off' } }).phone).toBe('off');
    expect(readFormConfig({ feedbackForm: { phone: 'maybe' } }).phone).toBe('required');
  });
});

describe('showing reviews back on the site', () => {
  it('is on by default, since nothing appears until a person approves it', () => {
    // Safe to default on: isPublic is false on every row until somebody at the
    // salon publishes it, so "show reviews" with nothing approved shows
    // nothing at all.
    expect(readFormConfig({}).showReviews).toBe(true);
  });

  it('is off only when explicitly turned off', () => {
    expect(readFormConfig({ feedbackForm: { showReviews: false } }).showReviews).toBe(false);
  });
});

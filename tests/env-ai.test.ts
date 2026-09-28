import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BUG THIS FILE EXISTS FOR.
 *
 * A Groq key was set as GROQ_API on a laptop and on a production server. The
 * code read GROQ_API_KEY. Because no key is a legitimate state — the feature
 * is optional by design — nothing failed, nothing logged, and every sentiment
 * reading and drafted review was a silent no-op for days.
 *
 * `aiReady` is the switch the whole feature hangs off, so it is worth a test
 * that it is on when a key is present under either name, and off when there
 * genuinely is not one.
 */
describe('feedback AI configuration', () => {
  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_API;
  });

  it('turns on for the documented variable', async () => {
    vi.resetModules();
    process.env.GROQ_API_KEY = 'gsk_test_123';
    delete process.env.GROQ_API;
    const { env, aiReady } = await import('../src/config/env');
    expect(aiReady).toBe(true);
    expect(env.GROQ_API_KEY).toBe('gsk_test_123');
  });

  it('turns on for GROQ_API, the name people actually type', async () => {
    vi.resetModules();
    delete process.env.GROQ_API_KEY;
    process.env.GROQ_API = 'gsk_test_456';
    const { env, aiReady } = await import('../src/config/env');
    expect(aiReady).toBe(true);
    // Folded onto the canonical name, so nothing downstream has to know there
    // are two spellings.
    expect(env.GROQ_API_KEY).toBe('gsk_test_456');
  });

  it('prefers the documented name when both are set', async () => {
    vi.resetModules();
    process.env.GROQ_API_KEY = 'gsk_canonical';
    process.env.GROQ_API = 'gsk_alias';
    const { env } = await import('../src/config/env');
    expect(env.GROQ_API_KEY).toBe('gsk_canonical');
  });

  it('stays off with no key, because that is a supported way to run', async () => {
    vi.resetModules();
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_API;
    const { aiReady } = await import('../src/config/env');
    expect(aiReady).toBe(false);
  });
});

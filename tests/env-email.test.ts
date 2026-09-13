import { describe, expect, it, vi } from 'vitest';

describe('email configuration', () => {
  it('a Resend key under Resend’s own variable names switches email on', async () => {
    vi.resetModules();
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.RESEND_FROM_EMAIL = 'hello@glowstudio.in';
    delete process.env.EMAIL_DRIVER;
    delete process.env.EMAIL_API_KEY;
    const { env } = await import('../src/config/env');
    expect(env.EMAIL_DRIVER).toBe('resend');
    expect(env.EMAIL_API_KEY).toBe('re_test_123');
    expect(env.EMAIL_FROM_ADDRESS).toBe('hello@glowstudio.in');
  });

  it('stays on the console driver with no key at all', async () => {
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.EMAIL_API_KEY;
    delete process.env.EMAIL_DRIVER;
    const { env } = await import('../src/config/env');
    expect(env.EMAIL_DRIVER).toBe('console');
  });
});

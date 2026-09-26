import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/core/log-redact';

/**
 * THE LOG LINE THAT LEAKED A SALON'S VERIFY TOKEN.
 *
 * This is the real one, copied from a production container's logs:
 *
 *   GET /api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=200163850
 *       &hub.verify_token=<the salon's token>&hub_mode=subscribe&...
 *
 * Written twice per request — once in `req.url`, once in the message — every
 * time Meta verified the webhook. Anybody with log access could take that token
 * and re-register their own callback URL against the salon's app, which is
 * enough to intercept every delivery receipt and every inbound message.
 */
describe('a URL on its way into the logs', () => {
  it('masks the WhatsApp verify token that started all this', () => {
    const real =
      '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=200163850&hub.verify_token=s3cr3t-token-value&hub_verify_token=s3cr3t-token-value';

    const safe = redactUrl(real);

    expect(safe).not.toContain('s3cr3t-token-value');
    // Both spellings Meta sends. Catching one and missing the other would have
    // left the token in the logs while looking fixed.
    expect(safe).toContain('hub.verify_token=[redacted]');
    expect(safe).toContain('hub_verify_token=[redacted]');
  });

  it('keeps the keys, because the keys are what makes a log line useful', () => {
    // "A verify token was sent and it was wrong" is diagnosable. A path with no
    // query string at all is not — which is why this masks rather than strips.
    const safe = redactUrl('/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=abc');
    expect(safe).toContain('hub.mode=subscribe');
    expect(safe).toContain('hub.verify_token=');
  });

  it('masks a family of names, not an exact list', () => {
    /**
     * Broad on purpose. An exact list has to be updated by whoever adds the
     * next secret-carrying parameter, and they will not — so `refresh_token`
     * and `client_secret` are covered the day somebody introduces them.
     */
    for (const key of ['token', 'access_token', 'refresh_token', 'secret', 'client_secret', 'signature', 'password', 'api_key', 'apikey']) {
      expect(redactUrl(`/x?${key}=leaky`)).not.toContain('leaky');
    }
  });

  it('masks the tracking code, which is not a credential but names a customer', () => {
    // A log full of pv codes is a log that says who browsed what, kept for
    // months, in a system whose retention nobody has thought about.
    expect(redactUrl('/gallery?pv=Tb7nkMy')).toBe('/gallery?pv=[redacted]');
  });

  it('leaves ordinary parameters alone', () => {
    const safe = redactUrl('/api/v1/messages?campaignId=cmp_1&page=2&status=DELIVERED');
    expect(safe).toBe('/api/v1/messages?campaignId=cmp_1&page=2&status=DELIVERED');
  });

  it('is unbothered by URLs with no query at all', () => {
    expect(redactUrl('/health')).toBe('/health');
    expect(redactUrl('')).toBe('');
    expect(redactUrl('/x?')).toBe('/x');
  });

  it('keeps a valueless flag readable', () => {
    expect(redactUrl('/x?debug&page=1')).toBe('/x?debug&page=1');
  });

  it('never returns the raw query when something is unexpected', () => {
    // The failure mode of this has to be "less detail", never "the secret after
    // all", because it runs on every request and a logger must not throw.
    expect(() => redactUrl('/x?%%%&token=abc')).not.toThrow();
    expect(redactUrl('/x?%%%&token=abc')).not.toContain('abc');
  });
});

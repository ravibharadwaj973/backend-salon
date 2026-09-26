/**
 * SECRETS DO NOT GO IN THE LOGS.
 *
 * Found the hard way. The WhatsApp webhook verification arrives as
 *
 *   GET /api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<secret>&...
 *
 * and the HTTP logger wrote the whole URL, twice per request — once in
 * `req.url` and once in the message. So every verification Meta performed
 * copied the salon's verify token into the container logs, where it sits for as
 * long as the logs are kept and travels wherever they are shipped. Anybody with
 * log access could then re-register their own callback URL against the salon's
 * app.
 *
 * ── Why a key allow-list rather than dropping query strings entirely ──────
 *
 * Query strings are most of what makes a log line useful: which campaign,
 * which branch, which page. Throwing them all away to hide one parameter trades
 * a real debugging tool for a blunt fix. So the KEYS are always kept and only
 * the values of sensitive ones are replaced — a log line still says a verify
 * token was present and wrong-looking, without saying what it was.
 *
 * The match is on the key name and is deliberately broad: `token`, `secret`,
 * `signature`, `password`, `key`, and `pv`. A new parameter called
 * `refresh_token` is covered the day somebody adds it, which is the only way
 * this stays true — an exact list would have to be updated by whoever adds the
 * next secret, and they will not.
 */

/**
 * `pv` is in here for a different reason from the rest.
 *
 * It is not a credential; it is the tracked-link code, which identifies one
 * named customer. A log full of them is a log that says who browsed what, kept
 * for months, in a system whose retention nobody has thought about. The app's
 * own tracking is careful to record only what it needs; the logs should not
 * quietly keep more.
 */
const SENSITIVE = /(token|secret|signature|password|passwd|apikey|api_key|^key$|^pv$|^sig$)/i;

/**
 * A URL safe to log: same path, same keys, sensitive values masked.
 *
 * Takes and returns a string because that is what the logger has — a path with
 * a query, never an absolute URL — and it must not throw on anything, since a
 * logger that throws takes the request with it.
 */
export function redactUrl(url: string): string {
  const cut = url.indexOf('?');
  if (cut === -1) return url;

  const path = url.slice(0, cut);
  const query = url.slice(cut + 1);
  if (!query) return path;

  try {
    const parts = query.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;

      const key = pair.slice(0, eq);
      // The bare key is what a reader needs; the value is what leaks.
      return SENSITIVE.test(key) ? `${key}=[redacted]` : pair;
    });

    return `${path}?${parts.join('&')}`;
  } catch {
    /**
     * Anything unparseable loses its whole query string rather than being
     * logged raw. The failure mode of this function has to be "less detail",
     * never "the secret after all".
     */
    return `${path}?[unparsed]`;
  }
}

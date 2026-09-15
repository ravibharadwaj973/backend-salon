/**
 * WHICH SITES MAY CALL THE AUTHENTICATED API.
 *
 * Driven entirely by CORS_ORIGINS, so adding a deployment is an environment
 * change and a restart — never a code change.
 *
 *   CORS_ORIGINS=https://app.parlon.in,https://admin.parlon.in
 *   CORS_ORIGINS=https://*.vercel.app          one pattern for every preview
 *   CORS_ORIGINS=*                             anything (development only)
 *
 * Note what does NOT belong here: a salon's own website. Everything under
 * /public answers any origin by design, because the booking widget runs on
 * sites we have never heard of. Only our own signed-in apps — the salon app and
 * the platform console — need listing.
 */

export interface OriginRule {
  /** What was written in the environment, for logging. */
  raw: string;
  matches: (origin: string) => boolean;
}

/**
 * Compare origins the way a browser sends them: scheme + host + port, lower
 * case, no trailing slash and no path.
 *
 * Pasting a URL out of the address bar gives you "https://app.vercel.app/",
 * which never matches the Origin header "https://app.vercel.app". That one
 * character is the most common reason a correctly-listed site is still refused,
 * so it is normalised away rather than left as a trap.
 */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, '');
  if (!trimmed) return '';

  try {
    return new URL(trimmed).origin;
  } catch {
    // Not a parseable URL (a bare hostname, or a wildcard pattern). Hand it
    // back trimmed so pattern matching can still do something sensible.
    return trimmed;
  }
}

/**
 * Turn one entry into a matcher.
 *
 * A `*` in the host position becomes a single-label wildcard: "https://*.vercel.app"
 * matches "https://salon-git-main-ravi.vercel.app" but NOT
 * "https://vercel.app.attacker.com" — the pattern is anchored at both ends, and
 * the wildcard cannot span a dot, so it cannot climb into another domain.
 */
function compile(entry: string): OriginRule | null {
  const raw = entry.trim();
  if (!raw) return null;

  const normalized = normalizeOrigin(raw);
  if (!normalized) return null;

  if (!normalized.includes('*')) {
    return { raw, matches: (origin) => origin === normalized };
  }

  const pattern = new RegExp(
    `^${normalized
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      // A wildcard stands for one label: letters, digits and hyphens, no dots.
      .join('[a-z0-9-]+')}$`,
  );

  return { raw, matches: (origin) => pattern.test(origin) };
}

export interface CorsPolicy {
  /** True when CORS_ORIGINS is "*" — every origin allowed. */
  allowAll: boolean;
  rules: OriginRule[];
}

export function parseCorsOrigins(value: string): CorsPolicy {
  if (value.trim() === '*') return { allowAll: true, rules: [] };

  return {
    allowAll: false,
    rules: value
      .split(',')
      .map(compile)
      .filter((rule): rule is OriginRule => rule !== null),
  };
}

/**
 * Deliberately pure — no logger, no config, no imports at all.
 *
 * This module is loaded BY config/env, so anything it imports gets pulled in
 * before the environment has finished initialising. Importing the logger here
 * once created exactly that cycle (env -> cors -> logger -> env) and crashed
 * the process at startup with "Cannot access 'isTest' before initialization".
 * Reporting a refusal belongs at the edge, in app.ts, which loads later.
 */
export function isAllowedOrigin(policy: CorsPolicy, origin: string | undefined): boolean {
  // No Origin header at all: a server-to-server call, curl, or a same-origin
  // request. CORS is a browser rule and does not apply.
  if (!origin) return true;
  if (policy.allowAll) return true;

  const normalized = normalizeOrigin(origin);
  return policy.rules.some((rule) => rule.matches(normalized));
}

/** What CORS_ORIGINS was understood to mean, for a log line. */
export function describePolicy(policy: CorsPolicy): string[] {
  return policy.allowAll ? ['*'] : policy.rules.map((rule) => rule.raw);
}

/**
 * True the first time a given origin is refused.
 *
 * Refusals are otherwise completely silent — the browser reports them, the
 * server does not, and whoever deployed the frontend has no idea why it is
 * failing. Once per origin is enough to make it a five-second fix without
 * filling the log.
 */
const reported = new Set<string>();

export function shouldReportRefusal(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (reported.has(normalized)) return false;
  reported.add(normalized);
  return true;
}

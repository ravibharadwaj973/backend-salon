import 'dotenv/config';
import { z } from 'zod';
import { parseCorsOrigins } from '../core/cors';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * How much to log per HTTP request.
   *   summary — one compact line: method, path, status, duration  (default)
   *   off     — nothing for successful requests; errors still logged
   *   full    — the complete request and response objects, for debugging
   */
  HTTP_LOG: z.enum(['summary', 'off', 'full']).default('summary'),
  /** Log any query slower than this, in ms. Raise it if the warnings are noise. */
  SLOW_QUERY_MS: z.coerce.number().int().min(50).default(250),
  CORS_ORIGINS: z.string().default('*'),

  /**
   * Where the salon app is served from — the public origin, not this API's.
   *
   * Every customer-facing link we build points here: the booking page a salon
   * puts on their own website, the feedback link in a WhatsApp message, the
   * Google-review hand-off. It has to be the address a customer's phone can
   * actually open, so it is configuration rather than something guessed from
   * the request.
   */
  PUBLIC_APP_URL: z
    .string()
    .url()
    .default('http://localhost:3000')
    .transform((value) => value.replace(/\/+$/, '')),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  PLATFORM_ADMIN_EMAIL: z.string().email().default('admin@parlon.in'),
  PLATFORM_ADMIN_PASSWORD: z.string().default('Admin@12345'),

  JOB_WORKER_ENABLED: bool(true),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  JOB_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(25),

  MESSAGING_DRIVER: z.enum(['console', 'whatsapp_cloud', 'gupshup']).default('console'),
  WHATSAPP_API_URL: z.string().default('https://graph.facebook.com/v20.0'),
  /// The WhatsApp Business Account the number belongs to. Nothing in the send
  /// path needs it — a message is addressed to the PHONE NUMBER ID — but it is
  /// what Meta's own setup screen shows next to the token, so it gets pasted
  /// into .env expecting to matter. Declared here so it is carried rather than
  /// silently dropped, and so nobody spends an evening wondering why setting it
  /// changed nothing.
  WHATSAPP_WABA_ID: z.string().optional().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(''),
  /// The Meta app secret, used to check the X-Hub-Signature-256 header on every
  /// webhook. One value for the whole platform, because every salon's number
  /// reports to the same Meta app. Left empty, signatures cannot be checked and
  /// anyone who finds the webhook URL can post fake delivery receipts.
  WHATSAPP_APP_SECRET: z.string().optional().default(''),
  // Platform-level fallbacks. A real salon connects its own accounts; these
  // exist for the demo tenant and for local development.
  /// console = log and stop · simulator = pretend carrier that also reports
  /// back, for building against before an MSG91 account exists · msg91 = real
  /// The simulator is refused in production at the point of use.
  SMS_DRIVER: z.enum(['console', 'simulator', 'msg91']).default('console'),
  SMS_API_URL: z.string().default('https://api.msg91.com'),
  SMS_API_KEY: z.string().optional().default(''),
  SMS_SENDER_ID: z.string().optional().default(''),
  SMS_DLT_ENTITY_ID: z.string().optional().default(''),
  /// Estimated, for reporting only — MSG91 does not return a per-message price.
  SMS_COST_PER_SEGMENT: z.coerce.number().min(0).default(0.18),

  EMAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
  EMAIL_API_URL: z.string().default('https://api.resend.com'),
  EMAIL_API_KEY: z.string().optional().default(''),
  EMAIL_FROM_ADDRESS: z.string().optional().default(''),
  EMAIL_FROM_NAME: z.string().optional().default(''),
  /// Resend's own variable names, accepted as aliases so a key pasted straight
  /// from their dashboard works. A Resend key switches the driver on by itself.
  RESEND_API_KEY: z.string().optional().default(''),
  RESEND_FROM_EMAIL: z.string().optional().default(''),
  RESEND_FROM_NAME: z.string().optional().default(''),
  /// The signing secret Resend shows once when you add a webhook endpoint
  /// (`whsec_…`). Without it the delivery webhook is an open endpoint: anyone
  /// who learns the URL can mark messages bounced and switch a customer's
  /// email consent off.
  RESEND_WEBHOOK_SECRET: z.string().optional().default(''),
  EMAIL_COST_PER_MESSAGE: z.coerce.number().min(0).default(0.01),

  DEFAULT_CURRENCY: z.string().default('INR'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  DEFAULT_GST_RATE: z.coerce.number().default(18),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const raw = parsed.data;

/**
 * Fold the Resend-named variables into the generic email ones. Setting
 * RESEND_API_KEY is enough: the driver flips to resend without anyone having to
 * know EMAIL_DRIVER exists.
 */
const emailApiKey = raw.EMAIL_API_KEY || raw.RESEND_API_KEY;
export const env = {
  ...raw,
  EMAIL_API_KEY: emailApiKey,
  EMAIL_FROM_ADDRESS: raw.EMAIL_FROM_ADDRESS || raw.RESEND_FROM_EMAIL,
  EMAIL_FROM_NAME: raw.EMAIL_FROM_NAME || raw.RESEND_FROM_NAME,
  EMAIL_DRIVER: raw.EMAIL_DRIVER === 'console' && emailApiKey ? ('resend' as const) : raw.EMAIL_DRIVER,
};

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * A production server must never send out localhost links.
 *
 * PUBLIC_APP_URL has a localhost default so the app runs out of the box, and
 * that default is the trap: leave it unset in production and every booking
 * link, feedback link and Google-review hand-off in every message says
 * `http://localhost:3000/...`. Nothing errors. The salon sees messages marked
 * delivered, the customer taps a link that cannot open, and nobody finds out
 * until someone asks why the campaign produced no bookings.
 *
 * So it fails at boot instead, while somebody is watching a deploy, rather
 * than quietly at 2am in a journey run.
 */
if (isProd && /localhost|127\.0\.0\.1/.test(env.PUBLIC_APP_URL)) {
  // eslint-disable-next-line no-console
  console.error(
    `PUBLIC_APP_URL is ${env.PUBLIC_APP_URL} in production.\n` +
      'Every booking and review link sent to a customer would point at localhost and open nothing.\n' +
      'Set PUBLIC_APP_URL to the address customers can actually reach, e.g. https://parlon.jharavi.in',
  );
  process.exit(1);
}

/**
 * Parsed once at boot. Supports exact origins and one-label wildcards such as
 * https://*.vercel.app, and forgives the trailing slash you get from copying a
 * URL out of the address bar.
 */
export const corsPolicy = parseCorsOrigins(env.CORS_ORIGINS);

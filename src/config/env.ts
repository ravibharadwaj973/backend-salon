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

  /**
   * Where THIS server can be reached from outside, origin only.
   *
   * Different from PUBLIC_APP_URL: the app is on Vercel, this API is not. It is
   * needed because an uploaded logo's address is stored, not built at render
   * time — the URL goes into an email that is opened weeks later, so it has to
   * be absolute and it has to still be right.
   *
   * Left empty the URL is stored relative, which works inside the app through
   * its proxy and shows a broken image in email. Production refuses to start
   * without it for that reason.
   */
  PUBLIC_API_URL: z
    .string()
    .default('')
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
  /**
   * WHICH SALON OWNS THE NUMBER ABOVE. A slug or an id.
   *
   * Only consulted when WhatsApp is configured here rather than per salon under
   * Settings, and only then because the environment supplies a number without
   * saying whose it is. Sending does not care; an inbound message does, because
   * a customer's reply carries nothing but their phone number and is meaningless
   * until we know which salon they wrote to.
   *
   * Unset is correct for a single-salon deployment (there is only one answer)
   * and for every salon that connected its own account. Unset on a multi-salon
   * deployment with a number here means inbound replies are dropped, and the log
   * says so at error level rather than leaving it to be discovered.
   */
  WHATSAPP_TENANT_ID: z.string().optional().default(''),
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

  /**
   * CLOUDINARY — where photographs live.
   *
   * The cloud name is public: it appears in every delivery URL. The key and
   * secret are not, and they are why this lives here rather than in a website:
   * the secret can delete every image in the account, so it belongs on a server
   * nobody downloads.
   *
   * All three optional. A salon that has not set them up has no gallery
   * uploads, and everything else in the app carries on — the alternative is an
   * app that refuses to boot because nobody signed up to an image host.
   */
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  /**
   * The folder every upload goes into, so a shared Cloudinary account can hold
   * more than this app's pictures without them becoming impossible to tell
   * apart. Each salon gets a subfolder of it.
   */
  CLOUDINARY_FOLDER: z.string().default('parlon'),

  /**
   * GROQ — reading what customers wrote.
   *
   * Optional, and the app is fully usable without it: no key means feedback is
   * simply never analysed, and every rating, alert, journey and report carries
   * on exactly as before. Nothing a salon depends on is behind this.
   *
   * OpenAI-compatible, so BASE_URL can point at any endpoint speaking that
   * protocol if the account moves. MODEL is configurable because a hosted
   * model name is a moving target and a stale default should be a one-line env
   * change rather than a deploy.
   */
  GROQ_API_KEY: z.string().optional().default(''),
  /**
   * The name people actually type, accepted as an alias.
   *
   * Not a hypothetical: the key was set as GROQ_API on both a laptop and a
   * production server, and because a missing key is a legitimate state here —
   * the whole feature is optional — nothing complained. Every analysis, every
   * drafted review and every sentiment reading was a silent no-op for as long
   * as that sat there, and there was no way to tell from the outside that the
   * difference between "off" and "misconfigured" was one word.
   *
   * Two spellings cost a line. Finding this one cost considerably more.
   */
  GROQ_API: z.string().optional().default(''),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  /**
   * A HOSTED MODEL NAME IS NOT A CONSTANT, AND NOT EVERY ACCOUNT HAS THE SAME ONES.
   *
   * The default was `llama-3.3-70b-versatile`, which is a current Groq model
   * and not deprecated — and which this account could not use. Every call came
   * back 404 "does not exist or you do not have access to it", which reads like
   * a wrong name and actually means a different catalogue.
   *
   * So the default is a model from the widely-available gpt-oss family, and the
   * real advice is in .env.example: ask the key which models it has rather than
   * trusting any default, including this one.
   */
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  /**
   * gpt-oss and friends think before answering, and those tokens come out of
   * the same budget as the reply. Labelling feedback and tidying two sentences
   * need none of it: 'low' keeps the latency inside the eight seconds the
   * customer is waiting on the thank-you screen.
   *
   * Sent only when set, and defaulted per model below, because a model that
   * does not understand the parameter answers 400 rather than ignoring it.
   */
  /**
   * A MODEL THAT CAN SEE, WHICH IS NOT THE SAME MODEL.
   *
   * Its own variable rather than reusing GROQ_MODEL, because a text-only model
   * answers 400 to an attached image rather than ignoring it — so one setting for
   * both would mean switching the feedback model quietly broke hair analysis, or
   * the reverse. Empty is a legitimate state: the hair analysis is then filled in
   * by the stylist, which it has to support anyway.
   */
  GROQ_VISION_MODEL: z.string().optional().default(''),
  GROQ_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
  /**
   * A feedback analysis nobody is waiting for. Short on purpose: it runs in a
   * job, and a request that hangs holds a worker slot that reminders need.
   */
  GROQ_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  /**
   * BLACK FOREST LABS — drawing the hair.
   *
   * The key is the only secret here and it never leaves this process: no
   * NEXT_PUBLIC_ twin, no proxying it to the browser, no putting it in a query
   * string. A leaked image-model key is somebody else's bill, charged per
   * picture, and the first anybody notices is the invoice.
   *
   * Optional, like Cloudinary and Groq above. No key means the 3D studio works
   * exactly as it does today — it draws its own hair, in the browser, for free —
   * and the photographic previews simply are not offered. That is the whole
   * point of the ordering: the part a salon uses in the chair does not depend on
   * a third party answering.
   */
  BFL_API_KEY: z.string().optional().default(''),
  /**
   * Regional, and it matters.
   *
   * BFL runs api.eu.bfl.ai and api.us.bfl.ai as well as the global address, and
   * a request submitted to one is NOT visible to another. The submit call here
   * sets the region; every later poll follows the address the provider itself
   * hands back, which is why `pollingUrl` is a stored column rather than
   * something rebuilt from this value.
   */
  BFL_API_URL: z
    .string()
    .url()
    .default('https://api.bfl.ai')
    .transform((value) => value.replace(/\/+$/, '')),
  /**
   * A HOSTED MODEL NAME IS NOT A CONSTANT. Same lesson as GROQ_MODEL above, and
   * it cost a day there: the default was a real, current, undeprecated model
   * that this particular account could not use, and every call came back 404.
   *
   * So this is configuration. Ask the key which models it has rather than
   * trusting the default — including this one.
   *
   * The default WAS `flux-2-klein`, which is not an endpoint, and the first real
   * attempt failed on it twice. The model name is a path segment, so a wrong one
   * is a 404 on a route that does not exist — the provider answers a bare
   * "Not Found" and nothing about it suggests the cause. The submit path now says
   * so in words; this default is the slug the documentation actually lists.
   */
  BFL_MODEL: z.string().default('flux-2-klein-9b'),
  /**
   * One HTTP call, not the whole generation.
   *
   * The generation takes tens of seconds and is waited for by POLLING, never by
   * holding a socket open: a submit that hangs holds a worker slot that
   * appointment reminders need.
   */
  BFL_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** How long between status checks, and how many before giving up. */
  BFL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(4000),
  BFL_MAX_POLLS: z.coerce.number().int().min(1).max(200).default(60),
  /**
   * A CEILING ON THE BILL, PER SALON, PER DAY.
   *
   * Every other third party in this file is metered by the message and billed
   * to the salon. This one is billed to us, per picture, and the button that
   * spends it is in a stylist's hand on a slow afternoon. Without a cap the
   * failure mode is not an outage — it is an invoice.
   *
   * Counted over rows rather than through the quota ledger because that ledger
   * is built around messaging channels; this belongs there eventually, and a
   * number that stops the bleeding today is worth more than the refactor.
   */
  BFL_DAILY_LIMIT_PER_TENANT: z.coerce.number().int().min(0).default(60),

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
  /** Either spelling. See the note on GROQ_API above. */
  GROQ_API_KEY: raw.GROQ_API_KEY || raw.GROQ_API,
  EMAIL_API_KEY: emailApiKey,
  EMAIL_FROM_ADDRESS: raw.EMAIL_FROM_ADDRESS || raw.RESEND_FROM_EMAIL,
  EMAIL_FROM_NAME: raw.EMAIL_FROM_NAME || raw.RESEND_FROM_NAME,
  EMAIL_DRIVER: raw.EMAIL_DRIVER === 'console' && emailApiKey ? ('resend' as const) : raw.EMAIL_DRIVER,
};

/**
 * Whether photographs can be uploaded at all.
 *
 * All three, not just the cloud name: a cloud name on its own is enough to
 * BUILD a delivery URL but not to put anything at the other end of one, and an
 * upload screen that appears and then fails on submit is worse than one that
 * says what is missing.
 */
export const cloudinaryReady = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

/**
 * Whether feedback can be analysed at all.
 *
 * Read before enqueuing rather than inside the job: a queue filling with work
 * that can only fail is worse than no feature, because it buries the jobs that
 * matter under retries of one that never will.
 */
export const aiReady = Boolean(env.GROQ_API_KEY);

/**
 * Whether photographic previews can be generated at all.
 *
 * Checked before a row is written rather than inside the job, for the reason in
 * the note above: a queue filling with work that can only fail buries the jobs
 * that matter under retries of one that never will. A salon with no key is told
 * so by the API in a sentence, on the spot.
 *
 * Cloudinary is deliberately part of this. The provider's own link expires
 * within the hour, so without somewhere to put the bytes a "successful"
 * generation produces a row that shows a broken image by morning — which is
 * worse than not offering the feature, because the salon has already shown it to
 * a customer.
 */
export const fluxReady = Boolean(env.BFL_API_KEY) && cloudinaryReady;

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
 * The base every stored public URL is built from.
 *
 * Relative when PUBLIC_API_URL is unset, which is right for local work: the
 * frontend proxies /api/v1 and the logo appears. It is wrong for email, which
 * is why production insists on the real thing below.
 */
export const PUBLIC_API_BASE = `${env.PUBLIC_API_URL}${env.API_PREFIX}`;

/**
 * A WARNING, NOT AN EXIT — AND THE DIFFERENCE MATTERS.
 *
 * This started as process.exit(1), copying the PUBLIC_APP_URL guard above, and
 * that was the wrong judgement. PUBLIC_APP_URL earns an exit because without
 * it EVERY booking and feedback link in every message points at localhost:
 * the product does not work at all, and failing loudly at deploy is kinder
 * than failing silently at 2am.
 *
 * PUBLIC_API_URL is not that. Without it two features degrade — a logo upload
 * is refused with a sentence, and links go out untracked but correct — and
 * everything else is untouched. Taking an entire salon platform offline over a
 * logo is a worse outage than the one being prevented, and it is exactly what
 * happened: the deploy built, pushed the schema, started the container, and
 * the container exited before it could answer its health check.
 *
 * So it says so, loudly, once, and the server runs.
 */
if (isProd && !env.PUBLIC_API_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    'PUBLIC_API_URL is not set.\n' +
      "  · Logo uploads will be refused, because a logo's address is STORED at upload time and a relative one would\n" +
      "    resolve against the customer's mail client, showing a broken image in every email already sent.\n" +
      '  · Links in messages will not be click-tracked. They will still work.\n' +
      "Set PUBLIC_API_URL to this server's own public address, e.g. https://api.parlon.jharavi.in",
  );
}

/**
 * Parsed once at boot. Supports exact origins and one-label wildcards such as
 * https://*.vercel.app, and forgives the trailing slash you get from copying a
 * URL out of the address bar.
 */
export const corsPolicy = parseCorsOrigins(env.CORS_ORIGINS);

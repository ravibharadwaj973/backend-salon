import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { aiReady, cloudinaryReady, corsPolicy, env, fluxReady, isTest } from './config/env';
import { describePolicy, isAllowedOrigin, shouldReportRefusal } from './core/cors';
import { logger } from './core/logger';
import { redactUrl } from './core/log-redact';
import { contextMiddleware } from './middleware/context';
import { resolveClick } from './messaging/tracked-links';
import { recordClick } from './modules/marketing/marketing-source.service';
import { bookingUrl } from './core/public-links';
import { applyStatusUpdate } from './messaging/dispatcher';
import { errorHandler, notFoundHandler } from './middleware/error';
import { databaseHealthy, prisma } from './core/prisma';
import { runUnscoped } from './core/context';
import { pendingMigrationsAtBoot } from './core/migrations';
import { aiVerified } from './modules/feedback/feedback-ai.service';
import { fluxVerified } from './modules/hair-studio/flux';
import { buildRouter } from './routes';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  /**
   * Two CORS policies, chosen per request.
   *
   * Everything authenticated is locked to the origins we run ourselves, because
   * those requests carry a session.
   *
   * `/public/*` is the opposite: it is the booking surface a salon embeds in
   * their OWN website, and we cannot know in advance what that website is
   * called. So it answers any origin — and is safe to, because it is
   * unauthenticated, sends no cookies (`credentials: false`, which also stops a
   * browser attaching a signed-in user's session to it), is rate-limited per
   * address, and is scoped to one salon by the slug in the URL. A wildcard here
   * exposes exactly what is already public on the booking page.
   */
  const PUBLIC_PREFIX = `${env.API_PREFIX}/public`;

  app.use(
    cors((req, callback) => {
      if (req.path.startsWith(PUBLIC_PREFIX)) {
        callback(null, {
          origin: true,
          credentials: false,
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['Content-Type'],
          maxAge: 86_400,
        });
        return;
      }

      callback(null, {
        // Reflects the caller's own origin when it is allowed. Never a literal
        // "*": a browser refuses a wildcard on a request that carries
        // credentials, and every signed-in call here carries a cookie.
        origin: (origin, done) => {
          const allowed = isAllowedOrigin(corsPolicy, origin ?? undefined);
          if (!allowed && origin && shouldReportRefusal(origin)) {
            logger.warn(
              { origin, allowed: describePolicy(corsPolicy) },
              'CORS: refused an origin that is not in CORS_ORIGINS',
            );
          }
          done(null, allowed);
        },
        credentials: true,
        exposedHeaders: ['X-Request-Id'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id', 'X-Tenant-Id', 'X-Request-Id'],
      });
    }),
  );
  app.use(compression());
  // The raw body is kept for webhook routes only. Meta signs the exact bytes it
  // sent, so a signature cannot be checked against a re-serialised object —
  // key order and whitespace would differ. Holding the buffer for every request
  // would double the memory cost of a large upload, hence the path test.
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        if (req.url?.includes('/webhooks/')) {
          (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(cookieParser());

  if (!isTest && env.HTTP_LOG !== 'off') {
    const compact = env.HTTP_LOG === 'summary';

    app.use(
      pinoHttp({
        logger,
        autoLogging: {
          // Health probes and CORS preflights are every-few-seconds noise that
          // says nothing about the application.
          ignore: (req) =>
            req.url === '/health' || req.url === '/ready' || req.url === '/favicon.ico' || req.method === 'OPTIONS',
        },
        // pino-http's defaults serialise the entire request and response —
        // every header, on every call. One page load then costs a screen of
        // JSON. In summary mode a request is one readable line instead.
        // Applied in BOTH modes. `full` logs more, not less carefully — and it is
        // the mode somebody turns on precisely when they are chasing a problem,
        // which is the worst moment to start writing tokens to disk.
        ...(compact
          ? {
              serializers: {
                req: (req: { method: string; url: string }) => ({ method: req.method, url: redactUrl(req.url) }),
                res: (res: { statusCode: number }) => ({ status: res.statusCode }),
              },
              customSuccessMessage: (req, res) => `${req.method} ${redactUrl(req.url ?? '')} → ${res.statusCode}`,
              customErrorMessage: (req, res, err) =>
                `${req.method} ${redactUrl(req.url ?? '')} → ${res.statusCode} ${err?.message ?? ''}`.trim(),
            }
          : {
              serializers: {
                req: (req: { url?: string }) => ({
                  ...req,
                  url: redactUrl(req.url ?? ''),
                }),
              },
            }),
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      }),
    );
  }

  // Request context (tenant, user, branch) must wrap every handler below.
  app.use(contextMiddleware);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'parlon',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      /**
       * WHICH OPTIONAL FEATURES THIS PROCESS ACTUALLY HAS KEYS FOR.
       *
       * Both are optional by design, which is what made them dangerous: with
       * no key the feature is a silent no-op, and silence looks exactly like a
       * bug. A Groq key was once set under the wrong variable name on a
       * production server and the only way to find out was to read the source,
       * because nothing the server exposed could tell you the difference
       * between "switched off" and "misconfigured".
       *
       * Booleans only. Never the key, never the model name, never the base
       * URL — this endpoint is public because a load balancer has to reach it
       * without credentials, so it may say WHETHER a feature is on and nothing
       * whatsoever about how it is wired. "On or off" is already observable by
       * anyone who uses the app; the configuration is not.
       */
      features: {
        /** A key is configured. Says nothing about whether it works. */
        feedbackAi: aiReady,
        /**
         * Whether the model has actually answered — true after one good call,
         * false once a setting has been rejected, null before anything has been
         * tried.
         *
         * `feedbackAi` was true for days while every request came back 404
         * because the account had no access to the configured model. "A key is
         * present" and "this works" turned out to be very different facts, and
         * only the second one was worth reporting.
         */
        feedbackAiVerified: aiVerified(),
        photoUploads: cloudinaryReady,
        /**
         * Photographic hair previews. Both halves, because either one
         * missing means the same thing on screen: an image model with
         * nowhere to store what it draws produces a link that expires
         * within the hour, which is worse than no feature at all.
         */
        hairImageGeneration: fluxReady,
        hairImageGenerationVerified: fluxVerified(),
      },
      /**
       * How many migrations this database has not run, or null when it cannot
       * be told. Anything above zero means writes to the new columns are
       * failing with a 500 while reads carry on, which is the failure mode
       * that looks like a healthy app.
       *
       * The COUNT, never the names — a migration name describes an unreleased
       * feature. The names go to the startup log, which is not public.
       */
      pendingMigrations: pendingMigrationsAtBoot()?.length ?? null,
    });
  });

  app.get('/ready', (_req, res) => {
    void databaseHealthy().then((healthy) => {
      res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'degraded', database: healthy });
    });
  });

  /**
   * The tracked-link redirect. Deliberately OUTSIDE the API prefix and outside
   * every auth layer: this URL is printed in an SMS, where each character is
   * billed, and it is opened by a customer who has never heard of our API.
   *
   * It answers a redirect and nothing else. No page, no script, no cookie —
   * one hop between the message and where the salon meant to send them.
   */
  app.get('/r/:code', (req, res) => {
    void resolveClick(req.params.code)
      .then((hit) => {
        if (!hit) {
          // An old message forwarded to a friend, or a code that never
          // existed. Not an error worth a stack trace.
          res.status(404).type('text/plain').send('This link has expired.');
          return;
        }

        /**
         * The message moves to CLICKED only while the link still identifies
         * the person who was sent it. A link forwarded to a friend in June
         * would otherwise mark the original customer's message as clicked, and
         * every rate built on that column would quietly include other people's
         * taps.
         */
        if (hit.messageLogId && hit.identifies) {
          void applyStatusUpdate({ providerMessageId: '', messageLogId: hit.messageLogId, status: 'CLICKED' }).catch(
            () => undefined,
          );
        }

        // 302, not 301: a permanent redirect is cached by the phone, and the
        // second tap would never reach us to be counted.
        res.redirect(302, hit.targetUrl);
      })
      .catch(() => res.status(404).type('text/plain').send('This link has expired.'));
  });

  /**
   * THE MARKETING LINK — the one a salon puts in their Instagram bio.
   *
   * A separate path from /r/ above, and not a clever extension of it. That one
   * carries a seven-character random code generated per message; this one
   * carries a word the salon chose, like "diwali-reel", because it goes in a
   * bio, on a printed QR code and inside an ad, where somebody may have to read
   * it or type it. Sharing a namespace between a random code and a chosen word
   * is how "diwali" eventually collides with a generated one.
   *
   * Outside the API prefix and outside auth, like the other: the person opening
   * it has never heard of us and has no session.
   */
  app.get('/go/:code', (req, res) => {
    void recordClick(req.params.code)
      .then(async (hit) => {
        if (!hit) {
          res.status(404).type('text/plain').send('This link has expired.');
          return;
        }

        const tenant = await runUnscoped(() =>
          prisma.tenant.findUnique({ where: { id: hit.tenantId }, select: { slug: true } }),
        ).catch(() => null);

        if (!tenant) {
          res.status(404).type('text/plain').send('This link has expired.');
          return;
        }

        /**
         * `ref` is the whole point: it rides into the booking page, is stored on
         * the appointment as sourceRef, and is what later joins a booking back
         * to the thing that produced it.
         */
        // 302, not 301: a permanent redirect is cached by the phone and the
        // second tap would never reach us to be counted.
        res.redirect(302, bookingUrl(tenant.slug, { ref: hit.code }));
      })
      .catch(() => res.status(404).type('text/plain').send('This link has expired.'));
  });

  app.use(env.API_PREFIX, buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

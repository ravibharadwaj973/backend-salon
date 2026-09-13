import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { corsOrigins, env, isTest } from './config/env';
import { logger } from './core/logger';
import { contextMiddleware } from './middleware/context';
import { errorHandler, notFoundHandler } from './middleware/error';
import { databaseHealthy } from './core/prisma';
import { buildRouter } from './routes';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id', 'X-Tenant-Id', 'X-Request-Id'],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
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
        ...(compact
          ? {
              serializers: {
                req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
                res: (res: { statusCode: number }) => ({ status: res.statusCode }),
              },
              customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
              customErrorMessage: (req, res, err) =>
                `${req.method} ${req.url} → ${res.statusCode} ${err?.message ?? ''}`.trim(),
            }
          : {}),
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
    res.json({ status: 'ok', service: 'salon-os', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  app.get('/ready', (_req, res) => {
    void databaseHealthy().then((healthy) => {
      res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'degraded', database: healthy });
    });
  });

  app.use(env.API_PREFIX, buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import type { Server } from 'node:http';
import { aiReady, cloudinaryReady, env } from './config/env';
import { logger } from './core/logger';
import { connectDatabase, disconnectDatabase } from './core/prisma';
import { createApp } from './app';
import { reclaimStuckJobs, startWorker, stopWorker } from './jobs/worker';

let server: Server | null = null;

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();

  server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, prefix: env.API_PREFIX },
      `Parlon API listening on http://localhost:${env.PORT}${env.API_PREFIX}`,
    );

    /**
     * SAY WHICH OPTIONAL FEATURES ARE OFF, ON EVERY BOOT.
     *
     * Both of these are legitimately optional, which is exactly why they need
     * announcing: a missing key makes the feature a silent no-op, and silence
     * is indistinguishable from a bug. Somebody set GROQ_API instead of
     * GROQ_API_KEY once and spent a long time looking at a feedback page
     * wondering why no review was ever drafted, because nothing anywhere said
     * the model was never called.
     *
     * One line at startup, naming the variable to set. Not a warning when it is
     * on — a log that cries wolf about a working system gets filtered out.
     */
    if (!aiReady) {
      logger.warn(
        { set: 'GROQ_API_KEY (or GROQ_API)' },
        'feedback AI is OFF: no Groq key, so sentiment, topics and drafted reviews will not run',
      );
    }
    if (!cloudinaryReady) {
      logger.warn(
        { set: 'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET' },
        'photo uploads are OFF: Cloudinary is not configured',
      );
    }
  })

  // In small deployments the worker runs in-process; set JOB_WORKER_ENABLED=false
  // and run `npm run start:worker` separately once volume justifies it.
  if (env.JOB_WORKER_ENABLED) {
    await reclaimStuckJobs()
    startWorker();
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');

  const timeout = setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 15_000);

  try {
    await stopWorker();
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    await disconnectDatabase();
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});

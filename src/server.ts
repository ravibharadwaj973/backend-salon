import type { Server } from 'node:http';
import { env } from './config/env';
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

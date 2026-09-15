import pino from 'pino';
import { env, isProd, isTest } from '../config/env';

/**
 * Logging is for reading, and a wall of JSON is not read — it is scrolled past.
 *
 * In production the output is machine-shaped: full ISO timestamps, the service
 * name, pid and hostname, so a log collector can group and filter it. In
 * development all of that is noise on a single developer's terminal, so it is
 * stripped down to a clock time and the message.
 *
 * What gets logged per request is controlled by HTTP_LOG (see app.ts), because
 * request logging is the single loudest thing in a running API.
 */

const devTime = () => `,"time":"${new Date().toTimeString().slice(0, 8)}"`;

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,

  // pid and hostname matter on a fleet of containers, not on a laptop.
  base: isProd ? { service: 'salon-grow', pid: process.pid } : {},
  timestamp: isProd ? pino.stdTimeFunctions.isoTime : devTime,

  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      '*.passwordHash',
      'body.password',
      'accessToken',
      'refreshToken',
      // A phone number is personal data and ends up in message payloads.
      '*.toAddress',
    ],
    censor: '[redacted]',
  },

  transport: isProd
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
});

export type Logger = typeof logger;

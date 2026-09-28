import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../core/errors';
import { logger } from '../core/logger';
import { isProd } from '../config/env';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
  });
};

function mapPrismaError(err: unknown): AppError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const target = (err.meta?.target as string[] | string | undefined) ?? [];
    const fields = Array.isArray(target) ? target : [target];
    switch (err.code) {
      case 'P2002':
        return new AppError(
          `A record with this ${fields.join(', ') || 'value'} already exists`,
          409,
          'DUPLICATE_RECORD',
          { fields },
        );
      case 'P2003':
        return new AppError('Related record not found or still in use', 409, 'FOREIGN_KEY_VIOLATION', {
          field: err.meta?.field_name,
        });
      case 'P2025':
        return new AppError('Record not found', 404, 'NOT_FOUND');
      case 'P2014':
        return new AppError('This change would break a required relation', 409, 'RELATION_VIOLATION');
      /**
       * THE DATABASE IS BEHIND THE CODE.
       *
       * P2021 is a missing table, P2022 a missing column. Both mean one
       * thing in practice: a deploy went out without its migrations. These
       * used to land in the `default` branch below and come back as
       * "Database request failed", which sounds like a bad request and sent
       * people looking at the payload — for days, in one case, while the
       * actual answer was one command.
       *
       * 503, not 400. Nothing is wrong with what the client sent, the server
       * is not correctly deployed, and a retry after the migration runs will
       * work. The message says so in production too: it names no data and no
       * schema detail, only the operational fact and the fix.
       */
      case 'P2021':
      case 'P2022':
        return new AppError(
          'The database is missing a table or column this version needs — pending migrations have not been run.',
          503,
          'SCHEMA_BEHIND_CODE',
          isProd ? undefined : { prisma: err.message },
        );
      default:
        // Prisma's own message names the model and the field; outside
        // production it is the only thing that makes this debuggable.
        return new AppError('Database request failed', 400, `PRISMA_${err.code}`, isProd ? undefined : { prisma: err.message });
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    /**
     * Almost always a client that no longer matches the schema: someone pulled
     * a migration and did not run `prisma generate`, so a query uses a field
     * or a unique constraint the generated client has never heard of.
     *
     * "Invalid database query" on its own sends people hunting through their
     * request payload for an hour. Prisma's message says which model and which
     * argument, so in development it is passed through.
     */
    return new AppError(
      'Invalid database query — the Prisma client may be out of date. Run `npx prisma generate`.',
      400,
      'PRISMA_VALIDATION_ERROR',
      isProd ? undefined : { prisma: err.message.split('\n').slice(-6).join('\n') },
    );
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return new AppError('Database unavailable', 503, 'DATABASE_UNAVAILABLE');
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = err instanceof AppError ? err : mapPrismaError(err);

  if (appError) {
    if (appError.statusCode >= 500) {
      logger.error({ err, requestId: req.ctx?.requestId, path: req.path }, appError.message);
    } else {
      logger.warn(
        { code: appError.code, requestId: req.ctx?.requestId, path: req.path, userId: req.ctx?.userId },
        appError.message,
      );
    }
    res.status(appError.statusCode).json({
      success: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
      },
      requestId: req.ctx?.requestId,
    });
    return;
  }

  const error = err as Error;
  logger.error(
    { err: error, stack: error?.stack, requestId: req.ctx?.requestId, path: req.path },
    'unhandled error',
  );

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isProd ? 'Something went wrong. Please try again.' : (error?.message ?? 'Unknown error'),
      ...(isProd ? {} : { stack: error?.stack }),
    },
    requestId: req.ctx?.requestId,
  });
};

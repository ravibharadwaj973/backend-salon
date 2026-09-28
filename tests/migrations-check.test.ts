import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * THE FAILURE THIS GUARDS.
 *
 * Code shipped that wrote to columns whose migration had not been run. Reads
 * kept working — they touch old columns — so the app looked healthy, and the
 * only thing that broke was a customer pressing Send. In production that came
 * back as "Something went wrong. Please try again." with no clue attached,
 * and days went into the API key, the model name and the prompt before anyone
 * looked at the database.
 *
 * Two things have to hold for that to be a five-minute problem instead:
 * a missing table or column must SAY it is a missing table or column, and it
 * must not be dressed up as the client's fault.
 */
describe('a database behind the code', () => {
  let errorHandler: typeof import('../src/middleware/error').errorHandler;

  function run(err: unknown) {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    errorHandler(err, { path: '/x', ctx: {} } as never, res as never, (() => {}) as never);
    return res as { statusCode: number; body: { error: { code: string; message: string } } };
  }

  beforeEach(async () => {
    vi.resetModules();
    ({ errorHandler } = await import('../src/middleware/error'));
  });

  const missingTable = () =>
    new Prisma.PrismaClientKnownRequestError('The table `feedback_service_ratings` does not exist', {
      code: 'P2021',
      clientVersion: '5.22.0',
    });

  const missingColumn = () =>
    new Prisma.PrismaClientKnownRequestError('The column `feedback.invoiceId` does not exist', {
      code: 'P2022',
      clientVersion: '5.22.0',
    });

  it('names the real problem instead of "Database request failed"', () => {
    for (const err of [missingTable(), missingColumn()]) {
      const res = run(err);
      expect(res.body.error.code).toBe('SCHEMA_BEHIND_CODE');
      expect(res.body.error.message).toMatch(/pending migrations have not been run/);
    }
  });

  it('answers 503, not 400 — nothing is wrong with the request', () => {
    // A 4xx sends somebody hunting through their payload. The server is simply
    // not correctly deployed, and the same request works once it is.
    expect(run(missingTable()).statusCode).toBe(503);
    expect(run(missingColumn()).statusCode).toBe(503);
  });

  it('still hides ordinary Prisma failures behind a generic message', () => {
    // The clarity above is for one specific operational fact. Everything else
    // keeps its existing treatment.
    const res = run(
      new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2000', clientVersion: '5.22.0' }),
    );
    expect(res.body.error.code).toBe('PRISMA_P2000');
  });
});

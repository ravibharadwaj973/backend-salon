import { Prisma, PrismaClient } from '@prisma/client';
import { getContext } from './context';
import { logger } from './logger';
import { env, isProd } from '../config/env';

/**
 * Models that carry a REQUIRED tenantId column are automatically filtered by the
 * active tenant on every top-level query. Models with an optional tenantId
 * (jobs, refresh tokens, webhook events) and platform tables are left alone.
 *
 * This is a safety net, not a substitute for care: Prisma extensions only see
 * top-level operations, so nested writes must still pass tenantId explicitly —
 * which the generated types already force you to do.
 */
const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'tenantId' && f.isRequired && !f.isList))
    .map((m) => m.name),
);

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WHERE_WRITE_OPERATIONS = new Set(['update', 'updateMany', 'delete', 'deleteMany']);

const basePrisma = new PrismaClient({
  log: isProd
    ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
    : [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
});

if (!isProd) {
  // Only slow queries are logged, never every query — a single dashboard load
  // fires dozens, and drowning the real warnings is how they stop being read.
  // Raise SLOW_QUERY_MS if a known-heavy report keeps tripping it.
  basePrisma.$on('query' as never, (e: Prisma.QueryEvent) => {
    if (e.duration > env.SLOW_QUERY_MS) {
      logger.warn({ ms: e.duration, query: e.query.slice(0, 300) }, 'slow query');
    }
  });
}
basePrisma.$on('error' as never, (e: Prisma.LogEvent) => logger.error({ prisma: e }, 'prisma error'));
basePrisma.$on('warn' as never, (e: Prisma.LogEvent) => logger.warn({ prisma: e }, 'prisma warning'));

export const prisma = basePrisma.$extends({
  name: 'tenant-isolation',
  query: {
    $allModels: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async $allOperations({ model, operation, args, query }: any) {
        const ctx = getContext();
        const tenantId = ctx?.tenantId;

        if (!ctx || ctx.bypassTenantScope || !tenantId) return query(args);
        if (!model || !TENANT_SCOPED_MODELS.has(model)) return query(args);

        const next = { ...(args ?? {}) } as Record<string, any>;

        if (READ_OPERATIONS.has(operation) || WHERE_WRITE_OPERATIONS.has(operation)) {
          next.where = { ...(next.where ?? {}), tenantId };
        } else if (operation === 'create') {
          next.data = { tenantId, ...(next.data ?? {}) };
        } else if (operation === 'createMany') {
          const data = next.data;
          next.data = Array.isArray(data)
            ? data.map((row: Record<string, unknown>) => ({ tenantId, ...row }))
            : { tenantId, ...(data ?? {}) };
        } else if (operation === 'upsert') {
          next.where = { ...(next.where ?? {}), tenantId };
          next.create = { tenantId, ...(next.create ?? {}) };
        }

        return query(next);
      },
    },
  },
});

export type ExtendedPrismaClient = typeof prisma;

/** The client shape available inside `prisma.$transaction(async (tx) => ...)`. */
export type TxClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Either the root client or a transaction client — services accept both. */
export type Db = ExtendedPrismaClient | TxClient;

export { Prisma };

export async function connectDatabase(): Promise<void> {
  await basePrisma.$connect();
  logger.info('database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await basePrisma.$disconnect();
  logger.info('database disconnected');
}

export async function databaseHealthy(): Promise<boolean> {
  try {
    await basePrisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Escape hatch for analytics SQL — callers MUST filter by tenant_id themselves. */
export const rawDb = basePrisma;

export const DATABASE_URL_CONFIGURED = Boolean(env.DATABASE_URL);

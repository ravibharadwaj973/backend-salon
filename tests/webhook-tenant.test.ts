import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHOSE SALON DID THE WEBHOOK ARRIVE FOR?
 *
 * The bug these pin down cost days. WhatsApp was configured in the server
 * environment rather than per salon, so no TenantMessagingConfig row carried the
 * number — and the inbound half of the webhook resolves the salon ONLY by that
 * number. Messages went out, delivery receipts came back (those match on a
 * provider message id and never needed the mapping), and every reply a customer
 * sent was dropped one line before it would have been stored.
 *
 * The thing that made it expensive was that it was invisible. So the cases below
 * are as much about what must NOT happen: a number that is nobody's must not be
 * guessed at, because attributing a stranger's message to a salon means the
 * assistant answers with the wrong business's prices and a STOP lands on the
 * wrong customer list.
 */

const env = {
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_TENANT_ID: '',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

/** What the fake database holds for one test case. */
const db = {
  configs: [] as { tenantId: string; waPhoneNumberId: string }[],
  tenants: [] as { id: string; name: string; slug: string }[],
};

vi.mock('../src/config/env', () => ({
  env,
  isTest: true,
  isProd: false,
  aiReady: false,
}));

vi.mock('../src/core/prisma', () => ({
  prisma: {
    tenantMessagingConfig: {
      findUnique: ({ where }: { where: { waPhoneNumberId: string } }) =>
        Promise.resolve(db.configs.find((c) => c.waPhoneNumberId === where.waPhoneNumberId) ?? null),
    },
    tenant: {
      findFirst: ({ where }: { where: { OR: ({ id?: string } | { slug?: string })[] } }) => {
        const wanted = where.OR.map((clause) => Object.values(clause)[0]);
        return Promise.resolve(
          db.tenants.find((t) => wanted.includes(t.id) || wanted.includes(t.slug)) ?? null,
        );
      },
      findMany: ({ take }: { take?: number }) => Promise.resolve(db.tenants.slice(0, take ?? db.tenants.length)),
    },
  },
}));

vi.mock('../src/core/context', () => ({
  runUnscoped: <T>(fn: () => Promise<T>) => fn(),
}));

const { resetEnvTenantCache, tenantForPhoneNumber } = await import('../src/modules/webhooks/webhook-tenant');

beforeEach(() => {
  env.WHATSAPP_PHONE_NUMBER_ID = '';
  env.WHATSAPP_TENANT_ID = '';
  db.configs = [];
  db.tenants = [];
  resetEnvTenantCache();
});

describe('a salon that connected its own WhatsApp', () => {
  it('is found by the number on its config row', async () => {
    db.configs = [{ tenantId: 'glow', waPhoneNumberId: '1111' }];
    await expect(tenantForPhoneNumber('1111')).resolves.toBe('glow');
  });

  it('is preferred over the environment, even when the env names another salon', async () => {
    // The row is the real mapping. An env var is a fallback for deployments
    // that have no row at all, and must never override one that exists.
    db.configs = [{ tenantId: 'glow', waPhoneNumberId: '1111' }];
    db.tenants = [{ id: 'ranjan', name: 'Ranjan', slug: 'ranjan' }];
    env.WHATSAPP_PHONE_NUMBER_ID = '1111';
    env.WHATSAPP_TENANT_ID = 'ranjan';

    await expect(tenantForPhoneNumber('1111')).resolves.toBe('glow');
  });
});

describe('WhatsApp configured in the server environment', () => {
  it('attributes the env number to the salon WHATSAPP_TENANT_ID names, by slug', async () => {
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    env.WHATSAPP_TENANT_ID = 'glow-studio';
    db.tenants = [
      { id: 't_ranjan', name: 'Ranjan', slug: 'ranjan-studio' },
      { id: 't_glow', name: 'Glow Studio', slug: 'glow-studio' },
    ];

    await expect(tenantForPhoneNumber('2222')).resolves.toBe('t_glow');
  });

  it('accepts an id as well as a slug, since either is what somebody has to hand', async () => {
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    env.WHATSAPP_TENANT_ID = 't_glow';
    db.tenants = [{ id: 't_glow', name: 'Glow Studio', slug: 'glow-studio' }];

    await expect(tenantForPhoneNumber('2222')).resolves.toBe('t_glow');
  });

  it('falls back to the only salon there is when nobody said which', async () => {
    // The overwhelmingly common single-salon deployment, which is the one that
    // must work without anybody having to know this setting exists.
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    db.tenants = [{ id: 't_only', name: 'The Only Salon', slug: 'only' }];

    await expect(tenantForPhoneNumber('2222')).resolves.toBe('t_only');
  });

  it('REFUSES TO GUESS between several salons, and drops instead', async () => {
    /**
     * The case that matters most. Picking the first row would make the
     * assistant answer one salon's customers using another salon's prices and
     * diary, and apply a STOP to the wrong customer list. Losing the message is
     * recoverable; misattributing it is not.
     */
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    db.tenants = [
      { id: 't_a', name: 'A', slug: 'a' },
      { id: 't_b', name: 'B', slug: 'b' },
    ];

    await expect(tenantForPhoneNumber('2222')).resolves.toBeNull();
  });

  it('drops when WHATSAPP_TENANT_ID names a salon that does not exist', async () => {
    // A typo in an env file must not silently fall through to the guess, or the
    // correction would never be made.
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    env.WHATSAPP_TENANT_ID = 'glow-studo';
    db.tenants = [{ id: 't_glow', name: 'Glow Studio', slug: 'glow-studio' }];

    await expect(tenantForPhoneNumber('2222')).resolves.toBeNull();
  });
});

describe('a number that is nobody’s', () => {
  it('is not attributed to anyone, even on a single-salon database', async () => {
    // Meta delivers events for other numbers on the same app. Only the number
    // the environment actually holds gets the fallback.
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    db.tenants = [{ id: 't_only', name: 'The Only Salon', slug: 'only' }];

    await expect(tenantForPhoneNumber('9999')).resolves.toBeNull();
  });

  it('is not attributed when the environment holds no number at all', async () => {
    db.tenants = [{ id: 't_only', name: 'The Only Salon', slug: 'only' }];
    await expect(tenantForPhoneNumber('9999')).resolves.toBeNull();
  });

  it('handles a payload with no phone_number_id without touching the database', async () => {
    await expect(tenantForPhoneNumber(undefined)).resolves.toBeNull();
  });
});

describe('the resolution is memoised', () => {
  it('does not re-derive once resolved, because the environment cannot change', async () => {
    env.WHATSAPP_PHONE_NUMBER_ID = '2222';
    db.tenants = [{ id: 't_only', name: 'The Only Salon', slug: 'only' }];

    await expect(tenantForPhoneNumber('2222')).resolves.toBe('t_only');

    /**
     * A second salon appears. The env number still belongs to whoever it
     * belonged to — re-counting here would turn a working deployment into one
     * that drops its own inbound messages the day it gains a second salon.
     */
    db.tenants.push({ id: 't_new', name: 'New', slug: 'new' });

    await expect(tenantForPhoneNumber('2222')).resolves.toBe('t_only');
  });
});

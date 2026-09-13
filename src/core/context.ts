import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '@prisma/client';
import { Unauthorized } from './errors';

export interface RequestContext {
  requestId: string;
  /** Null only for platform-admin or public/system flows. */
  tenantId: string | null;
  userId: string | null;
  role: UserRole | null;
  /** Branches this actor may touch. `null` means "every branch in the tenant". */
  branchIds: string[] | null;
  /** Branch the client selected for this request (X-Branch-Id), if any. */
  activeBranchId: string | null;
  isPlatformAdmin: boolean;
  /** Set by system jobs / platform routes to disable automatic tenant filtering. */
  bypassTenantScope: boolean;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setContextValue<K extends keyof RequestContext>(key: K, value: RequestContext[K]): void {
  const ctx = storage.getStore();
  if (ctx) ctx[key] = value;
}

export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('No request context available. Did you forget runWithContext()?');
  return ctx;
}

export function requireTenantId(): string {
  const ctx = storage.getStore();
  if (!ctx?.tenantId) throw Unauthorized('Tenant context missing');
  return ctx.tenantId;
}

export function requireUserId(): string {
  const ctx = storage.getStore();
  if (!ctx?.userId) throw Unauthorized('User context missing');
  return ctx.userId;
}

export function currentUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

/** Base context for background jobs and other non-HTTP callers. */
export function systemContext(tenantId: string | null, requestId = 'system'): RequestContext {
  return {
    requestId,
    tenantId,
    userId: null,
    role: null,
    branchIds: null,
    activeBranchId: null,
    isPlatformAdmin: false,
    bypassTenantScope: tenantId === null,
  };
}

/** Run a function with tenant filtering switched off (platform admin / migrations / cron sweeps). */
export function runUnscoped<T>(fn: () => T, requestId = 'system-unscoped'): T {
  const parent = storage.getStore();
  return storage.run(
    {
      ...(parent ?? systemContext(null, requestId)),
      tenantId: null,
      bypassTenantScope: true,
    },
    fn,
  );
}

/** Run a function as a specific tenant (used by the job worker for each tenant's work). */
export function runAsTenant<T>(tenantId: string, fn: () => T, requestId = 'system-tenant'): T {
  return storage.run(systemContext(tenantId, requestId), fn);
}

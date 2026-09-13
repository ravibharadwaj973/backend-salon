import type { UserRole } from '@prisma/client';
import type { RequestContext } from '../core/context';

export interface AuthPayload {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  name: string;
  email: string;
  role: UserRole;
  permissions: Set<string>;
  /** null = every branch in the tenant */
  branchIds: string[] | null;
  staffId: string | null;
}

export interface PlatformAuthPayload {
  platformUserId: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
      auth?: AuthPayload;
      platformAuth?: PlatformAuthPayload;
      /** Branch selected for this request (header X-Branch-Id or ?branchId=). */
      branchId?: string;
      /** Public booking routes resolve the tenant from the URL slug. */
      publicTenantId?: string;
    }
  }
}

export {};

import { Router } from 'express';
import { resolveBranch } from './middleware/branch';
import { apiLimiter } from './middleware/rateLimit';

import authRoutes from './modules/auth/auth.routes';
import tenantRoutes, { platformTenantRouter } from './modules/tenants/tenant.routes';
import branchRoutes from './modules/branches/branch.routes';
import userRoutes from './modules/users/user.routes';
import customerRoutes from './modules/customers/customer.routes';
import layoutRoutes from './modules/layouts/layout.routes';
import catalogRoutes from './modules/catalog/catalog.routes';
import staffRoutes from './modules/staff/staff.routes';
import appointmentRoutes from './modules/appointments/appointment.routes';
import { invoiceRouter, couponRouter, taxSettingsRouter } from './modules/billing/billing.routes';
import packageRoutes from './modules/packages/package.routes';
import membershipRoutes from './modules/memberships/membership.routes';
import loyaltyRoutes from './modules/loyalty/loyalty.routes';
import expenseRoutes from './modules/expenses/expense.routes';
import inventoryRoutes from './modules/inventory/inventory.routes';
import leadRoutes from './modules/leads/lead.routes';
import feedbackRoutes from './modules/feedback/feedback.routes';
import gamificationRoutes from './modules/gamification/gamification.routes';
import analyticsRoutes from './modules/analytics/analytics.routes';
import publicRoutes from './modules/public/public.routes';
import webhookRoutes from './modules/webhooks/webhook.routes';
import { segmentRouter, campaignRouter, journeyRouter, templateRouter, messageRouter } from './modules/marketing/marketing.routes';
import { usageRouter, platformQuotaRouter } from './modules/quotas/quota.routes';
import { auditRouter, platformAuditRouter } from './modules/audit/audit.routes';
import messagingRouter from './modules/messaging/messaging.routes';
import { requireFeature } from './middleware/feature';
import { authenticate } from './middleware/auth';
import { FEATURES } from './core/features';

/**
 * Route map.
 *
 *   OPERATE   appointments, customers, staff, services, branches
 *   MONEY     invoices, payments, packages, memberships, expenses, inventory
 *   GROW      leads, segments, campaigns, journeys, loyalty, feedback
 *   INTEL     analytics, alerts
 */
export function buildRouter(): Router {
  const router = Router();

  // Unauthenticated surfaces first — they have their own rate limits.
  router.use('/public', publicRoutes);
  router.use('/webhooks', webhookRoutes);

  router.use(apiLimiter);
  router.use('/auth', authRoutes);

  // Platform operator console (cross-tenant).
  router.use('/platform', platformTenantRouter);
  router.use('/platform', platformQuotaRouter);
  router.use('/platform', platformAuditRouter);

  // Everything below resolves the active branch from X-Branch-Id / ?branchId.
  router.use(resolveBranch);

  router.use('/tenant', tenantRoutes);
  router.use('/usage', usageRouter);
  router.use('/audit', auditRouter);
  router.use('/messaging', messagingRouter);
  router.use('/branches', branchRoutes);
  router.use('/users', userRoutes);
  router.use('/customers', customerRoutes);
  router.use('/layouts', layoutRoutes);
  router.use('/services', catalogRoutes);
  router.use('/staff', staffRoutes);
  router.use('/appointments', appointmentRoutes);
  router.use('/invoices', invoiceRouter);
  router.use('/coupons', couponRouter);
  router.use('/tax-settings', taxSettingsRouter);
  router.use('/packages', authenticate, requireFeature(FEATURES.PACKAGES), packageRoutes);
  router.use('/memberships', authenticate, requireFeature(FEATURES.MEMBERSHIPS), membershipRoutes);
  router.use('/loyalty', authenticate, requireFeature(FEATURES.LOYALTY), loyaltyRoutes);
  router.use('/expenses', authenticate, requireFeature(FEATURES.EXPENSES), expenseRoutes);
  router.use('/inventory', authenticate, requireFeature(FEATURES.INVENTORY), inventoryRoutes);
  router.use('/leads', authenticate, requireFeature(FEATURES.LEADS), leadRoutes);
  router.use('/segments', authenticate, requireFeature(FEATURES.SEGMENTS), segmentRouter);
  // Campaigns are marketing by definition, so they answer to the master switch
  // as well as their own — a Starter salon is told plainly, rather than being
  // allowed to build a campaign that would then send nothing.
  router.use(
    '/campaigns',
    authenticate,
    requireFeature(FEATURES.MARKETING),
    requireFeature(FEATURES.CAMPAIGNS),
    campaignRouter,
  );
  router.use('/journeys', authenticate, requireFeature(FEATURES.JOURNEYS), journeyRouter);
  router.use('/templates', templateRouter);
  router.use('/messages', messageRouter);
  router.use('/feedback', feedbackRoutes);
  router.use('/engagement', gamificationRoutes);
  router.use('/analytics', analyticsRoutes);

  return router;
}

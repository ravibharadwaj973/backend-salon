import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { publicLimiter } from '../../middleware/rateLimit';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { idSchema, phoneSchema } from '../../core/validators';
import { normalizePhone, sequenceNumber } from '../../core/ids';
import * as availability from '../appointments/availability.service';
import * as appointments from '../appointments/appointment.service';
import * as catalog from '../catalog/catalog.service';
import * as staffService from '../staff/staff.service';
import * as feedback from '../feedback/feedback.service';
import type { Gender } from '@prisma/client';

const router = Router();
router.use(publicLimiter);

/**
 * Public booking pages are unauthenticated, so the tenant comes from the URL
 * slug. Once resolved it is pinned into the request context, which means the
 * Prisma tenant filter protects these routes exactly like the private ones.
 */
const resolveTenantBySlug: RequestHandler = (req, _res, next) => {
  const slug = req.params.slug;
  if (!slug) return next(BadRequest('Salon not specified'));

  runUnscoped(() => prisma.tenant.findUnique({ where: { slug } }))
    .then((tenant) => {
      if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
        throw NotFound('Salon');
      }
      req.publicTenantId = tenant.id;
      req.ctx.tenantId = tenant.id;
      req.ctx.branchIds = null;
      req.ctx.bypassTenantScope = false;
      next();
    })
    .catch(next);
};

// ------------------------------------------------------------ salon info ---

router.get(
  '/:slug',
  resolveTenantBySlug,
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: req.publicTenantId! },
      select: { id: true, name: true, slug: true, logoUrl: true, phone: true, email: true, city: true, currency: true },
    });

    const branches = await prisma.branch.findMany({
      where: { tenantId: tenant.id, isActive: true },
      select: {
        id: true,
        name: true,
        addressLine: true,
        city: true,
        pincode: true,
        phone: true,
        openingHours: true,
        timezone: true,
      },
      orderBy: { name: 'asc' },
    });

    return ok(res, { salon: tenant, branches });
  }),
);

router.get(
  '/:slug/services',
  resolveTenantBySlug,
  validate({ query: z.object({ gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional() }) }),
  asyncHandler(async (req, res) => {
    const { gender } = req.query as { gender?: Gender };
    return ok(res, await catalog.serviceMenu({ gender, onlineOnly: true }));
  }),
);

router.get(
  '/:slug/staff',
  resolveTenantBySlug,
  validate({ query: z.object({ branchId: idSchema, serviceId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => {
    const { branchId, serviceId } = req.query as unknown as { branchId: string; serviceId?: string };
    return ok(res, await staffService.bookableStaff(branchId, serviceId));
  }),
);

router.get(
  '/:slug/slots',
  resolveTenantBySlug,
  validate({
    query: z.object({
      branchId: idSchema,
      date: z.coerce.date(),
      serviceIds: z.union([z.string(), z.array(idSchema)]).transform((v) => (Array.isArray(v) ? v : v.split(','))),
      staffId: idSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { branchId: string; date: Date; serviceIds: string[]; staffId?: string };
    return ok(res, await availability.availableSlots(q));
  }),
);

// --------------------------------------------------------------- booking ---

/**
 * Online booking takes NO payment and asks for no card details. The customer
 * reserves a slot; the salon collects the money at the counter afterwards and
 * records it by hand. There is deliberately no deposit, no prepayment and no
 * gateway redirect in this flow.
 */
router.post(
  '/:slug/book',
  resolveTenantBySlug,
  validate({
    body: z.object({
      branchId: idSchema,
      name: z.string().trim().min(1).max(120),
      phone: phoneSchema,
      email: z.string().email().optional(),
      gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNISEX']).optional(),
      startAt: z.coerce.date(),
      services: z
        .array(z.object({ serviceId: idSchema, staffId: idSchema.optional() }))
        .min(1)
        .max(8),
      notes: z.string().trim().max(500).optional(),
      source: z.enum(['ONLINE', 'QR', 'WHATSAPP', 'INSTAGRAM']).default('ONLINE'),
      marketingConsent: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const tenantId = req.publicTenantId!;
    const body = req.body as {
      branchId: string;
      name: string;
      phone: string;
      email?: string;
      gender?: Gender;
      startAt: Date;
      services: { serviceId: string; staffId?: string }[];
      notes?: string;
      source: 'ONLINE' | 'QR' | 'WHATSAPP' | 'INSTAGRAM';
      marketingConsent: boolean;
    };

    if (body.startAt < new Date()) throw BadRequest('Please choose a future time slot');

    const branch = await prisma.branch.findFirst({ where: { id: body.branchId, tenantId, isActive: true } });
    if (!branch) throw NotFound('Branch');

    const phone = normalizePhone(body.phone);
    let customer = await prisma.customer.findFirst({ where: { tenantId, phone } });

    if (!customer) {
      const count = await prisma.customer.count({ where: { tenantId } });
      const parts = body.name.trim().split(/\s+/);
      customer = await prisma.customer.create({
        data: {
          tenantId,
          branchId: body.branchId,
          code: sequenceNumber('C', count + 1, 5),
          firstName: parts[0] ?? body.name,
          lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
          phone,
          email: body.email ?? null,
          gender: body.gender ?? null,
          source: body.source === 'QR' ? 'WALK_IN' : body.source === 'ONLINE' ? 'WEBSITE' : body.source,
          // Booking is consent for transactional messages; marketing is opt-in.
          whatsappConsent: body.marketingConsent ? 'OPTED_IN' : 'UNKNOWN',
          consentUpdatedAt: new Date(),
        },
      });
    } else if (body.marketingConsent && customer.whatsappConsent !== 'OPTED_IN') {
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: { whatsappConsent: 'OPTED_IN', consentUpdatedAt: new Date() },
      });
    }

    if (customer.isBlacklisted) throw BadRequest('Online booking is not available for this number. Please call the salon.');

    // Public bookings never force past a conflict.
    const appointment = await appointments.createAppointment({
      branchId: body.branchId,
      customerId: customer.id,
      startAt: body.startAt,
      source: body.source,
      notes: body.notes,
      services: body.services,
      force: false,
      sendConfirmation: true,
    });

    return created(res, {
      appointmentId: appointment.id,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      status: appointment.status,
      branch: appointment.branch,
      services: appointment.services.map((s) => ({
        name: s.service.name,
        staff: s.staff?.displayName ?? null,
        startAt: s.startAt,
      })),
      customer: { id: customer.id, firstName: customer.firstName },
    });
  }),
);

router.get(
  '/:slug/appointments/:appointmentId',
  resolveTenantBySlug,
  asyncHandler(async (req, res) => {
    const appointment = await prisma.appointment.findFirst({
      where: { id: req.params.appointmentId!, tenantId: req.publicTenantId! },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        status: true,
        branch: { select: { name: true, addressLine: true, city: true, phone: true } },
        services: {
          select: { service: { select: { name: true } }, staff: { select: { displayName: true } }, startAt: true },
        },
      },
    });
    if (!appointment) throw NotFound('Appointment');
    return ok(res, appointment);
  }),
);

router.post(
  '/:slug/appointments/:appointmentId/cancel',
  resolveTenantBySlug,
  validate({ body: z.object({ phone: phoneSchema, reason: z.string().trim().max(240).optional() }) }),
  asyncHandler(async (req, res) => {
    const { phone, reason } = req.body as { phone: string; reason?: string };
    const appointment = await prisma.appointment.findFirst({
      where: { id: req.params.appointmentId!, tenantId: req.publicTenantId! },
      include: { customer: { select: { phone: true } } },
    });
    if (!appointment) throw NotFound('Appointment');
    // Ownership check: the phone on the booking must match.
    if (appointment.customer?.phone !== normalizePhone(phone)) {
      throw BadRequest('That phone number does not match this booking');
    }

    const updated = await appointments.changeStatus(appointment.id, 'CANCELLED', {
      reason: reason ?? 'Cancelled by customer online',
    });
    return ok(res, { id: updated.id, status: updated.status });
  }),
);

// -------------------------------------------------------------- feedback ---

router.get(
  '/feedback/:appointmentId',
  asyncHandler(async (req, res) => ok(res, await feedback.publicFeedbackContext(req.params.appointmentId!))),
);

router.post(
  '/feedback/:appointmentId',
  validate({
    body: z.object({
      rating: z.coerce.number().int().min(1).max(5),
      serviceRating: z.coerce.number().int().min(1).max(5).optional(),
      ambienceRating: z.coerce.number().int().min(1).max(5).optional(),
      staffRating: z.coerce.number().int().min(1).max(5).optional(),
      waitRating: z.coerce.number().int().min(1).max(5).optional(),
      npsScore: z.coerce.number().int().min(0).max(10).optional(),
      comment: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const context = await feedback.publicFeedbackContext(req.params.appointmentId!);
    if (context.alreadySubmitted) throw BadRequest('Feedback has already been submitted for this visit');

    const body = req.body as { rating: number; comment?: string };
    const result = await feedback.submitFeedback(
      { appointmentId: req.params.appointmentId!, ...body },
      context.tenantId,
    );

    return created(res, {
      thankYou: true,
      nextStep: result.nextStep,
      googleReviewUrl: result.googleReviewUrl,
      message:
        result.nextStep === 'GOOGLE_REVIEW'
          ? 'Thank you! Would you share that on Google too?'
          : 'Thank you for telling us. The salon owner will read this personally.',
    });
  }),
);

/** The customer tapped through to Google — recorded before we send them on. */
router.post(
  '/feedback/:appointmentId/google',
  asyncHandler(async (req, res) => ok(res, await feedback.recordGoogleReviewClick(req.params.appointmentId!))),
);

export default router;

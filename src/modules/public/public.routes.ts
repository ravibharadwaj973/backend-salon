import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok } from '../../core/http';
import { validate } from '../../middleware/validate';
import { publicLimiter, enquiryLimiter } from '../../middleware/rateLimit';
import { prisma } from '../../core/prisma';
import { runUnscoped } from '../../core/context';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { idSchema, phoneSchema } from '../../core/validators';
import { normalizePhone, sequenceNumber } from '../../core/ids';
import * as availability from '../appointments/availability.service';
import * as appointments from '../appointments/appointment.service';
import * as catalog from '../catalog/catalog.service';
import * as staffService from '../staff/staff.service';
import * as feedback from '../feedback/feedback.service';
import * as enquiries from '../tenants/enquiry.service';
import { bookingUrl, refererHost } from '../../core/public-links';
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

// -------------------------------------------------------------- enquiry ---

/**
 * "Please get in touch."
 *
 * The only thing the marketing site sends us. It creates no account, no
 * password and no salon — it records that someone would like a conversation,
 * and alerts the operator. A tenant is provisioned later, by a person, in the
 * console, once they have actually spoken.
 *
 * That ordering is deliberate. A self-serve sign-up would fill the database
 * with half-finished salons nobody ever rang, and a salon owner changing the
 * software their business runs on wants a person on the phone, not a form.
 */
router.post(
  '/enquiry',
  enquiryLimiter,
  validate({
    body: z.object({
      salonName: z.string().trim().min(2).max(120),
      contactName: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email(),
      phone: phoneSchema,
      city: z.string().trim().max(80).optional(),
      size: z.string().trim().max(40).optional(),
      message: z.string().trim().max(1000).optional(),
      source: z.string().trim().max(60).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const enquiry = await enquiries.createEnquiry(req.body as enquiries.EnquiryInput);
    // Nothing about the enquiry is echoed back — the page only needs to know
    // it arrived, and the reply comes by phone.
    return created(res, { received: true, salonName: enquiry.salonName });
  }),
);

// ------------------------------------------------------- website embed ---

/**
 * BOOKING ON THE SALON'S OWN WEBSITE.
 *
 * A salon pastes one line into their site:
 *
 *   <script src=".../public/<slug>/embed.js" defer></script>
 *
 * and every element carrying `data-parlon-book` becomes a button that opens
 * their booking page in an overlay, without leaving their site. A page with a
 * `<div id="parlon-booking">` gets the booking flow rendered inline there
 * instead. Bookings made through it land in that salon's own diary, exactly
 * like one taken at the front desk.
 *
 * It is served from here, not from a CDN, for one reason: the slug is baked in,
 * so the salon copies a line rather than configuring anything. And it is an
 * iframe rather than injected markup, so nothing of ours can collide with their
 * stylesheet and nothing of theirs can read the customer's details.
 */
router.get(
  '/:slug/embed.js',
  resolveTenantBySlug,
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: req.publicTenantId! },
      select: { name: true, slug: true },
    });

    res.type('application/javascript; charset=utf-8');
    // Cached at the edge for an hour: it changes when we ship, not per visitor.
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(embedScript(tenant.slug, tenant.name));
  }),
);

/**
 * The widget, as a string.
 *
 * Only two values are interpolated — the slug, which the router has already
 * matched against a real tenant, and the salon's name, which is JSON-escaped.
 * Everything else is fixed text.
 */
function embedScript(slug: string, salonName: string): string {
  const base = bookingUrl(slug, { embed: true });

  return `/* Parlon booking widget for ${JSON.stringify(salonName)} */
(function () {
  'use strict';
  if (window.__parlonBooking) return;

  var BASE = ${JSON.stringify(base)};
  var ORIGIN = new URL(BASE).origin;

  function url(el) {
    var u = new URL(BASE);
    if (el && el.getAttribute) {
      var branch = el.getAttribute('data-branch');
      var service = el.getAttribute('data-service');
      var ref = el.getAttribute('data-ref');
      if (branch) u.searchParams.set('branch', branch);
      if (service) u.searchParams.set('service', service);
      u.searchParams.set('ref', ref || location.hostname.replace(/^www\\./, ''));
    }
    return u.toString();
  }

  function frame(src) {
    var f = document.createElement('iframe');
    f.src = src;
    f.title = 'Book an appointment';
    f.loading = 'lazy';
    f.setAttribute('allowtransparency', 'true');
    f.style.cssText = 'width:100%;border:0;display:block;background:transparent;';
    return f;
  }

  /* --- inline: <div id="parlon-booking"></div> --- */
  function inline() {
    var host = document.getElementById('parlon-booking');
    if (!host || host.getAttribute('data-ready')) return;
    host.setAttribute('data-ready', '1');
    var f = frame(url(host));
    f.style.height = (host.getAttribute('data-height') || '720') + 'px';
    f.setAttribute('data-parlon-frame', '1');
    host.appendChild(f);
  }

  /* --- overlay: any element with data-parlon-book --- */
  var overlay = null;

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function open(el) {
    close();
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;background:rgba(28,25,23,.55);' +
      'display:flex;align-items:center;justify-content:center;padding:16px;' +
      '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    var panel = document.createElement('div');
    panel.style.cssText =
      'position:relative;width:100%;max-width:560px;height:min(92vh,860px);' +
      'background:#fff;border-radius:16px;overflow:hidden;' +
      'box-shadow:0 24px 64px -12px rgba(28,25,23,.45);';

    var shut = document.createElement('button');
    shut.type = 'button';
    shut.setAttribute('aria-label', 'Close');
    shut.textContent = '\\u00d7';
    shut.style.cssText =
      'position:absolute;top:8px;right:10px;z-index:2;width:32px;height:32px;' +
      'border:0;border-radius:999px;background:rgba(255,255,255,.9);cursor:pointer;' +
      'font:20px/1 system-ui,sans-serif;color:#44403c;';
    shut.addEventListener('click', close);

    var f = frame(url(el));
    f.style.height = '100%';
    f.setAttribute('data-parlon-frame', '1');

    panel.appendChild(shut);
    panel.appendChild(f);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-parlon-book]');
    if (!el) return;
    e.preventDefault();
    open(el);
  });

  /* The booking page tells us how tall it is, and when a booking is made. The
     origin check matters: without it any page could post us a fake message. */
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.source !== 'parlon') return;

    if (e.data.type === 'height') {
      var frames = document.querySelectorAll('iframe[data-parlon-frame]');
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow === e.source && !overlay) {
          frames[i].style.height = Math.max(420, e.data.height) + 'px';
        }
      }
    }

    if (e.data.type === 'booked') {
      /* The salon's own site can react to this — thank-you page, analytics,
         whatever they already use. We deliberately do not navigate for them. */
      window.dispatchEvent(new CustomEvent('parlon:booked', { detail: e.data.appointment || {} }));
      setTimeout(close, 2600);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inline);
  } else {
    inline();
  }

  window.__parlonBooking = { open: open, close: close, url: url };
})();
`;
}

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
      // Where on the internet this booking came from — "our website", "insta-bio",
      // the counter QR. Whoever embeds the widget chooses it, so it is capped,
      // stripped of anything that is not plain text, and only ever displayed as
      // a label the owner can group by.
      ref: z
        .string()
        .trim()
        .max(60)
        .regex(/^[\w .\-/]*$/, 'ref may contain letters, numbers, spaces and - _ . /')
        .optional(),
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
      ref?: string;
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
      // Falls back to the sending page's host, so a salon that pastes the
      // snippet and changes nothing still sees "booked from yoursalon.in"
      // rather than a blank column.
      sourceRef: body.ref ?? refererHost(req.get('referer')),
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

/**
 * A CUSTOMER'S OWN COPY OF THEIR BILL.
 *
 * Reached from a WhatsApp or email link, by somebody who is not signed in and
 * never will be. The token IS the authorisation, which shapes everything here:
 *
 *  - it decides the tenant. Two salons can both have invoice INV-1042, so the
 *    lookup is by token alone and the salon follows from the row — never from
 *    anything the caller sends.
 *  - it is bearer access. Whoever holds the link sees the page, including
 *    whoever the customer forwards it to, so this returns the bill and not the
 *    customer: no phone number, no email, no history, no other visits.
 *  - a wrong token is a plain 404. Saying "that invoice exists but is not
 *    yours" would turn this into an oracle for walking tokens.
 *
 * Draft and voided bills are not served. A draft is not a document anybody
 * should be shown, and a voided one must not keep circulating as though it
 * still stood.
 */
router.get(
  '/invoice/:token',
  validate({ params: z.object({ token: z.string().trim().min(20).max(64) }) }),
  asyncHandler(async (req, res) => {
    const invoice = await runUnscoped(() =>
      prisma.invoice.findUnique({
        where: { publicToken: req.params.token! },
        select: {
          invoiceNumber: true,
          invoiceDate: true,
          status: true,
          isGst: true,
          grossAmount: true,
          itemDiscount: true,
          billDiscount: true,
          taxableAmount: true,
          cgstAmount: true,
          sgstAmount: true,
          igstAmount: true,
          totalTax: true,
          roundOff: true,
          grandTotal: true,
          paidAmount: true,
          dueAmount: true,
          voidedAt: true,
          items: {
            select: {
              name: true,
              hsnSac: true,
              quantity: true,
              unitPrice: true,
              discount: true,
              taxableValue: true,
              taxRatePct: true,
              lineTotal: true,
            },
          },
          // Only the first name. The bill is addressed to somebody; it does not
          // need to identify them to whoever else opens the link.
          customer: { select: { firstName: true } },
          // The salon's own details, which a tax invoice must carry.
          tenant: { select: { name: true, gstin: true, phone: true, email: true } },
          branch: { select: { name: true, addressLine: true, city: true, pincode: true, phone: true } },
        },
      }),
    );

    if (!invoice || invoice.status === 'DRAFT' || invoice.voidedAt) throw NotFound('Invoice');

    return ok(res, {
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      status: invoice.status,
      isGst: invoice.isGst,
      customerName: invoice.customer?.firstName ?? null,
      salon: {
        name: invoice.tenant.name,
        gstin: invoice.tenant.gstin,
        phone: invoice.branch.phone ?? invoice.tenant.phone,
        email: invoice.tenant.email,
        address: [invoice.branch.addressLine, invoice.branch.city, invoice.branch.pincode]
          .filter(Boolean)
          .join(', '),
        branch: invoice.branch.name,
      },
      items: invoice.items,
      totals: {
        grossAmount: invoice.grossAmount,
        itemDiscount: invoice.itemDiscount,
        billDiscount: invoice.billDiscount,
        taxableAmount: invoice.taxableAmount,
        cgstAmount: invoice.cgstAmount,
        sgstAmount: invoice.sgstAmount,
        igstAmount: invoice.igstAmount,
        totalTax: invoice.totalTax,
        roundOff: invoice.roundOff,
        grandTotal: invoice.grandTotal,
        paidAmount: invoice.paidAmount,
        dueAmount: invoice.dueAmount,
      },
    });
  }),
);

export default router;

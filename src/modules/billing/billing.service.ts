import type { InvoiceItemType, PaymentMode, Prisma, RedemptionSource } from '@prisma/client';
import { prisma, type TxClient } from '../../core/prisma';
import { currentUserId, requireTenantId } from '../../core/context';
import { branchFilter, requireBranchId } from '../../core/scope';
import { BadRequest, Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import {
  add,
  clampNonNegative,
  d,
  div,
  gt,
  min as decMin,
  mul,
  pct,
  round2,
  roundOffTotal,
  sub,
} from '../../core/money';
import { endOfDay, startOfDay } from '../../core/dates';
import { sequenceNumber } from '../../core/ids';
import { enqueueSafe } from '../../jobs/queue';
import { apportionDiscount, computeLineTax, financialYear, isInterStateSupply, taxSummary } from './gst';
import * as loyalty from '../loyalty/loyalty.service';
import * as packages from '../packages/package.service';
import * as memberships from '../memberships/membership.service';
import * as stock from '../inventory/stock.service';
import { logger } from '../../core/logger';

export interface InvoiceItemInput {
  itemType: InvoiceItemType;
  refId?: string;
  name?: string;
  staffId?: string;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
  taxRatePct?: number;
  redeemFrom?: RedemptionSource;
  packagePurchaseItemId?: string;
  membershipSubscriptionId?: string;
}

/**
 * PAYMENTS ARE MANUAL — BY DESIGN.
 *
 * There is no payment gateway in this system and no third-party payment
 * integration of any kind. Money changes hands at the counter; the salon then
 * *records* what was taken:
 *
 *   mode      how it was received — CASH, CARD (their own machine),
 *             UPI (their own QR), CHEQUE, BANK_TRANSFER, or non-cash
 *             settlement (WALLET / PACKAGE / MEMBERSHIP / LOYALTY_POINTS)
 *   amount    what was actually collected
 *   reference free text for the UPI ref no., card slip, or cheque number
 *
 * Nothing here calls out to an external service, holds card data, or confirms a
 * payment on its own. An invoice is only ever marked PAID because a human said
 * the money arrived.
 */
export interface PaymentInput {
  mode: PaymentMode;
  amount: number;
  /** UPI reference / card slip / cheque number — typed in by the receptionist. */
  reference?: string;
  isAdvance?: boolean;
  notes?: string;
}

export interface CreateInvoiceInput {
  branchId?: string;
  customerId?: string;
  appointmentId?: string;
  items?: InvoiceItemInput[];
  billDiscountType?: 'PERCENT' | 'FLAT';
  billDiscountValue?: number;
  discountReason?: string;
  couponCode?: string;
  loyaltyPointsToRedeem?: number;
  useWalletAmount?: number;
  payments?: PaymentInput[];
  isGst?: boolean;
  placeOfSupply?: string;
  notes?: string;
  applyMembershipDiscount?: boolean;
  sendInvoice?: boolean;
}

const INVOICE_INCLUDE = {
  customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, tier: true, loyaltyPoints: true } },
  branch: { select: { id: true, name: true, gstin: true, addressLine: true, city: true, stateCode: true, phone: true } },
  items: { include: { staff: { select: { id: true, displayName: true } } } },
  payments: true,
  refunds: true,
  appointment: { select: { id: true, startAt: true } },
  coupon: { select: { id: true, code: true } },
} satisfies Prisma.InvoiceInclude;

interface ResolvedLine {
  input: InvoiceItemInput;
  itemType: InvoiceItemType;
  refId: string | null;
  name: string;
  hsnSac: string | null;
  staffId: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  itemDiscount: Prisma.Decimal;
  taxRatePct: Prisma.Decimal;
  redeemedFrom: RedemptionSource;
  packagePurchaseItemId: string | null;
  membershipSubscriptionId: string | null;
  commissionRatePct: Prisma.Decimal;
  commissionFlat: Prisma.Decimal;
  net: Prisma.Decimal;
}

/** Pull the tenant's billing preferences with sane Indian defaults. */
async function billingSettings(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  return {
    gstEnabled: settings.gstEnabled !== false && Boolean(tenant?.gstin),
    hasGstin: Boolean(tenant?.gstin),
    /**
     * Default off: the menu price is the base, and GST goes on top of it.
     *
     * That is what makes the with/without choice on a bill mean what the
     * counter expects — with GST the total goes up by the rate, without it the
     * total is the menu price. A salon that genuinely quotes tax-inclusive
     * prices can still turn this on in Settings, where the same ₹800 haircut
     * stays ₹800 either way and the tax is shown inside it.
     */
    pricesIncludeTax: settings.pricesIncludeTax === true,
    roundOff: settings.invoiceRoundOff !== false,
    defaultGstRate: Number(settings.defaultGstRate ?? 18),
    stateCode: tenant?.stateCode ?? null,
  };
}

/**
 * What the counter needs to know before the first line goes on a bill: whether
 * GST is on by default, whether a tax invoice is even possible (no GSTIN, no
 * tax invoice), and whether menu prices already include tax.
 */
export async function billingDefaults(tenantId: string) {
  const settings = await billingSettings(tenantId);
  return {
    gstByDefault: settings.gstEnabled,
    hasGstin: settings.hasGstin,
    pricesIncludeTax: settings.pricesIncludeTax,
    defaultGstRate: settings.defaultGstRate,
  };
}

async function resolveLines(
  tenantId: string,
  items: InvoiceItemInput[],
  context: { membership: Awaited<ReturnType<typeof memberships.activeMembership>>; applyMembershipDiscount: boolean; defaultGstRate: number },
): Promise<ResolvedLine[]> {
  const serviceIds = items.filter((i) => i.itemType === 'SERVICE' && i.refId).map((i) => i.refId!);
  const productIds = items.filter((i) => i.itemType === 'PRODUCT' && i.refId).map((i) => i.refId!);
  const packageIds = items.filter((i) => i.itemType === 'PACKAGE' && i.refId).map((i) => i.refId!);
  const planIds = items.filter((i) => i.itemType === 'MEMBERSHIP' && i.refId).map((i) => i.refId!);

  const [services, products, packageTemplates, plans, staffRows] = await Promise.all([
    serviceIds.length ? prisma.service.findMany({ where: { tenantId, id: { in: serviceIds } } }) : [],
    productIds.length ? prisma.product.findMany({ where: { tenantId, id: { in: productIds } } }) : [],
    packageIds.length ? prisma.packageTemplate.findMany({ where: { tenantId, id: { in: packageIds } } }) : [],
    planIds.length ? prisma.membershipPlan.findMany({ where: { tenantId, id: { in: planIds } } }) : [],
    prisma.staff.findMany({
      where: { tenantId, id: { in: items.map((i) => i.staffId).filter((s): s is string => Boolean(s)) } },
    }),
  ]);

  const serviceById = new Map(services.map((s) => [s.id, s]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const packageById = new Map(packageTemplates.map((p) => [p.id, p]));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const staffById = new Map(staffRows.map((s) => [s.id, s]));

  const membershipServiceDiscount = context.membership?.plan.serviceDiscountPct ?? 0;
  const membershipProductDiscount = context.membership?.plan.productDiscountPct ?? 0;

  return items.map((item) => {
    const quantity = d(item.quantity ?? 1);
    let name = item.name ?? '';
    let unitPrice = d(item.unitPrice ?? 0);
    let taxRatePct = d(item.taxRatePct ?? context.defaultGstRate);
    let hsnSac: string | null = null;
    let commissionRatePct = d(0);
    let commissionFlat = d(0);
    let autoDiscount = d(0);

    const staff = item.staffId ? staffById.get(item.staffId) : undefined;

    switch (item.itemType) {
      case 'SERVICE': {
        const service = item.refId ? serviceById.get(item.refId) : undefined;
        if (!service) throw BadRequest(`Service ${item.refId ?? ''} not found`);
        name = item.name ?? service.name;
        hsnSac = service.hsnSac ?? null;
        // The salon's single rate, not one stored per service. A service is a
        // price; GST is a decision made on the bill.
        taxRatePct = d(item.taxRatePct ?? context.defaultGstRate);

        if (item.unitPrice === undefined) {
          // Member price beats the list price; otherwise apply the plan's
          // percentage discount.
          if (context.membership && service.memberPrice !== null) {
            unitPrice = d(service.memberPrice);
          } else {
            unitPrice = d(service.price);
            if (context.applyMembershipDiscount && context.membership && Number(membershipServiceDiscount) > 0) {
              autoDiscount = pct(mul(unitPrice, quantity), membershipServiceDiscount);
            }
          }
        }

        // Service-level commission settings win; otherwise fall back to the
        // stylist's own arrangement.
        if (service.commissionType !== 'NONE') {
          if (service.commissionType === 'FLAT_PER_SERVICE') commissionFlat = d(service.commissionRate);
          else commissionRatePct = d(service.commissionRate);
        } else if (staff && staff.commissionType !== 'NONE') {
          if (staff.commissionType === 'FLAT_PER_SERVICE') commissionFlat = d(staff.commissionRate);
          else commissionRatePct = d(staff.commissionRate);
        }
        break;
      }
      case 'PRODUCT': {
        const product = item.refId ? productById.get(item.refId) : undefined;
        if (!product) throw BadRequest(`Product ${item.refId ?? ''} not found`);
        name = item.name ?? `${product.name}${product.shade ? ` (${product.shade})` : ''}`;
        hsnSac = product.hsnSac ?? null;
        taxRatePct = d(item.taxRatePct ?? product.taxRatePct);
        if (item.unitPrice === undefined) {
          unitPrice = d(product.sellingPrice);
          if (context.applyMembershipDiscount && context.membership && Number(membershipProductDiscount) > 0) {
            autoDiscount = pct(mul(unitPrice, quantity), membershipProductDiscount);
          }
        }
        break;
      }
      case 'PACKAGE': {
        const template = item.refId ? packageById.get(item.refId) : undefined;
        if (!template) throw BadRequest(`Package ${item.refId ?? ''} not found`);
        name = item.name ?? template.name;
        // A package is a bundle of services, so it follows the salon's rate.
        taxRatePct = d(item.taxRatePct ?? context.defaultGstRate);
        if (item.unitPrice === undefined) unitPrice = d(template.price);
        break;
      }
      case 'MEMBERSHIP': {
        const plan = item.refId ? planById.get(item.refId) : undefined;
        if (!plan) throw BadRequest(`Membership plan ${item.refId ?? ''} not found`);
        name = item.name ?? plan.name;
        // Likewise a membership: services, sold up front.
        taxRatePct = d(item.taxRatePct ?? context.defaultGstRate);
        if (item.unitPrice === undefined) unitPrice = d(plan.price);
        break;
      }
      case 'ADJUSTMENT': {
        if (!item.name) throw BadRequest('An adjustment line needs a name');
        name = item.name;
        break;
      }
    }

    // Redeemed lines are free of charge: the customer paid when they bought the
    // package or membership.
    const redeemedFrom = item.redeemFrom ?? 'NONE';
    if (redeemedFrom === 'PACKAGE' || redeemedFrom === 'MEMBERSHIP') {
      unitPrice = d(0);
      autoDiscount = d(0);
    }

    const itemDiscount = round2(add(d(item.discount ?? 0), autoDiscount));
    const gross = round2(mul(unitPrice, quantity));
    const net = clampNonNegative(sub(gross, itemDiscount));

    return {
      input: item,
      itemType: item.itemType,
      refId: item.refId ?? null,
      name,
      hsnSac,
      staffId: item.staffId ?? null,
      quantity,
      unitPrice,
      itemDiscount,
      taxRatePct,
      redeemedFrom,
      packagePurchaseItemId: item.packagePurchaseItemId ?? null,
      membershipSubscriptionId: item.membershipSubscriptionId ?? null,
      commissionRatePct,
      commissionFlat,
      net,
    };
  });
}

async function nextInvoiceNumber(tx: TxClient, branchId: string, invoiceDate: Date): Promise<string> {
  const branch = await tx.branch.update({
    where: { id: branchId },
    data: { invoiceCounter: { increment: 1 } },
    select: { invoicePrefix: true, invoiceCounter: true },
  });
  return `${branch.invoicePrefix}/${financialYear(invoiceDate)}/${String(branch.invoiceCounter).padStart(5, '0')}`;
}

async function validateCoupon(tenantId: string, code: string, customerId: string | undefined, billAmount: Prisma.Decimal) {
  const coupon = await prisma.coupon.findFirst({ where: { tenantId, code: code.toUpperCase() } });
  if (!coupon || !coupon.isActive) throw BadRequest('Invalid coupon code');

  const now = new Date();
  if (coupon.validFrom > now) throw BadRequest('This coupon is not active yet');
  if (coupon.validTo < now) throw BadRequest('This coupon has expired');
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    throw BadRequest('This coupon has reached its usage limit');
  }
  if (billAmount.lessThan(coupon.minBillAmount)) {
    throw BadRequest(`This coupon needs a minimum bill of ${coupon.minBillAmount.toString()}`);
  }
  if (customerId && coupon.perCustomerLimit > 0) {
    const used = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerId } });
    if (used >= coupon.perCustomerLimit) throw BadRequest('This customer has already used this coupon');
  }

  const raw = coupon.discountType === 'PERCENT' ? pct(billAmount, coupon.value) : d(coupon.value);
  const capped = coupon.maxDiscount ? decMin(raw, d(coupon.maxDiscount)) : raw;

  return { coupon, discount: round2(decMin(capped, billAmount)) };
}

/**
 * The heart of the POS. One call takes a basket to a fully settled, GST-compliant
 * invoice — including package and membership redemptions, loyalty, wallet,
 * commissions and stock consumption — inside a single transaction.
 */
export async function createInvoice(input: CreateInvoiceInput) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);
  const userId = currentUserId();
  const settings = await billingSettings(tenantId);

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw NotFound('Branch');

  // 1. Basket ------------------------------------------------------------
  let items = input.items ?? [];
  let appointmentId = input.appointmentId ?? null;

  if (appointmentId) {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { services: true, invoice: { select: { id: true } } },
    });
    if (!appointment) throw NotFound('Appointment');
    if (appointment.invoice) throw Conflict('This appointment has already been billed', { invoiceId: appointment.invoice.id });

    if (!items.length) {
      items = appointment.services
        .filter((s) => s.status !== 'CANCELLED')
        .map((s) => ({
          itemType: 'SERVICE' as const,
          refId: s.serviceId,
          staffId: s.staffId ?? undefined,
          quantity: 1,
          unitPrice: Number(s.price),
          discount: Number(s.discount),
        }));
    }
    input.customerId = input.customerId ?? appointment.customerId ?? undefined;
  }

  if (!items.length) throw BadRequest('An invoice needs at least one line item');

  // 2. Customer context --------------------------------------------------
  const customer = input.customerId
    ? await prisma.customer.findUnique({ where: { id: input.customerId } })
    : null;
  if (input.customerId && !customer) throw NotFound('Customer');

  const membership = customer ? await memberships.activeMembership(customer.id) : null;

  const resolved = await resolveLines(tenantId, items, {
    membership,
    applyMembershipDiscount: input.applyMembershipDiscount !== false,
    defaultGstRate: settings.defaultGstRate,
  });

  // 3. Bill-level discount and coupon ------------------------------------
  const subTotal = resolved.reduce<Prisma.Decimal>((acc, l) => acc.plus(l.net), d(0));

  let billDiscount = d(0);
  if (input.billDiscountValue) {
    billDiscount =
      input.billDiscountType === 'PERCENT' ? pct(subTotal, input.billDiscountValue) : d(input.billDiscountValue);
    billDiscount = round2(decMin(billDiscount, subTotal));
  }

  let couponRecord: { id: string; code: string } | null = null;
  if (input.couponCode) {
    const result = await validateCoupon(tenantId, input.couponCode, input.customerId, sub(subTotal, billDiscount));
    couponRecord = { id: result.coupon.id, code: result.coupon.code };
    billDiscount = round2(add(billDiscount, result.discount));
  }
  billDiscount = round2(decMin(billDiscount, subTotal));

  // 4. Taxes -------------------------------------------------------------
  const isGst = input.isGst ?? settings.gstEnabled;
  if (isGst && !settings.hasGstin) {
    throw BadRequest('A tax invoice needs your GSTIN — add it under Settings → Salon, or make this a bill without GST');
  }
  const placeOfSupply = input.placeOfSupply ?? branch.stateCode ?? settings.stateCode ?? null;
  const interState = isInterStateSupply(branch.stateCode ?? settings.stateCode, placeOfSupply);

  const shares = apportionDiscount(
    resolved.map((l) => l.net),
    billDiscount,
  );

  const priced = resolved.map((line, index) => {
    const netAfterBillDiscount = clampNonNegative(sub(line.net, shares[index] ?? d(0)));
    const tax = computeLineTax(
      { net: netAfterBillDiscount, taxRatePct: line.taxRatePct },
      { inclusive: settings.pricesIncludeTax, interState, gstEnabled: isGst },
    );
    return { line, apportionedDiscount: shares[index] ?? d(0), ...tax };
  });

  const taxableAmount = priced.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.taxableValue), d(0));
  const cgstAmount = priced.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.cgstAmount), d(0));
  const sgstAmount = priced.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.sgstAmount), d(0));
  const igstAmount = priced.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.igstAmount), d(0));
  const totalTax = round2(add(cgstAmount, sgstAmount, igstAmount));
  const beforeRounding = priced.reduce<Prisma.Decimal>((acc, p) => acc.plus(p.lineTotal), d(0));

  const { grandTotal, roundOff } = settings.roundOff
    ? roundOffTotal(beforeRounding)
    : { grandTotal: round2(beforeRounding), roundOff: round2(0) };

  const itemDiscountTotal = resolved.reduce<Prisma.Decimal>((acc, l) => acc.plus(l.itemDiscount), d(0));
  const grossAmount = resolved.reduce<Prisma.Decimal>((acc, l) => acc.plus(round2(mul(l.unitPrice, l.quantity))), d(0));

  // 5. Everything else happens atomically --------------------------------
  const invoiceId = await prisma.$transaction(
    async (tx) => {
      const invoiceDate = new Date();
      const invoiceNumber = await nextInvoiceNumber(tx, branchId, invoiceDate);

      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          branchId,
          invoiceNumber,
          customerId: customer?.id ?? null,
          appointmentId,
          invoiceDate,
          isGst,
          placeOfSupply,
          isInterState: interState,
          grossAmount,
          itemDiscount: itemDiscountTotal,
          billDiscount,
          discountReason: input.discountReason ?? null,
          couponId: couponRecord?.id ?? null,
          taxableAmount,
          cgstAmount,
          sgstAmount,
          igstAmount,
          totalTax,
          roundOff,
          grandTotal,
          dueAmount: grandTotal,
          status: 'ISSUED',
          notes: input.notes ?? null,
          createdById: userId,
        },
      });

      // 5a. Line items, redemptions, commissions and stock ---------------
      for (const entry of priced) {
        const { line } = entry;

        const invoiceItem = await tx.invoiceItem.create({
          data: {
            tenantId,
            branchId,
            invoiceId: invoice.id,
            itemType: line.itemType,
            refId: line.refId,
            name: line.name,
            hsnSac: line.hsnSac,
            staffId: line.staffId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: round2(add(line.itemDiscount, entry.apportionedDiscount)),
            taxableValue: entry.taxableValue,
            taxRatePct: line.taxRatePct,
            cgstAmount: entry.cgstAmount,
            sgstAmount: entry.sgstAmount,
            igstAmount: entry.igstAmount,
            lineTotal: entry.lineTotal,
            redeemedFrom: line.redeemedFrom,
            packagePurchaseItemId: line.packagePurchaseItemId,
            membershipSubscriptionId: line.membershipSubscriptionId,
          },
        });

        // Package session used
        if (line.redeemedFrom === 'PACKAGE' && line.packagePurchaseItemId) {
          await packages.redeemPackageSession(tx, {
            tenantId,
            purchaseItemId: line.packagePurchaseItemId,
            quantity: Number(line.quantity),
            invoiceId: invoice.id,
            appointmentId: appointmentId ?? undefined,
          });
        }

        // Complimentary membership session used
        if (line.redeemedFrom === 'MEMBERSHIP' && line.refId) {
          const subscriptionId = line.membershipSubscriptionId ?? membership?.id;
          if (!subscriptionId) throw BadRequest('No active membership to redeem this service against');
          await memberships.consumeBenefit(tx, {
            subscriptionId,
            serviceId: line.refId,
            quantity: Number(line.quantity),
          });
        }

        // Selling a package or a membership
        if (line.itemType === 'PACKAGE' && line.refId && customer) {
          await packages.purchasePackage(tx, {
            tenantId,
            branchId,
            customerId: customer.id,
            templateId: line.refId,
            invoiceId: invoice.id,
            price: Number(entry.lineTotal),
          });
        }
        if (line.itemType === 'MEMBERSHIP' && line.refId && customer) {
          await memberships.subscribe(tx, {
            tenantId,
            branchId,
            customerId: customer.id,
            planId: line.refId,
            invoiceId: invoice.id,
            price: Number(entry.lineTotal),
          });
        }

        // Commission on services actually charged for
        if (line.itemType === 'SERVICE' && line.staffId) {
          const base = entry.lineTotal;
          const amount = line.commissionFlat.greaterThan(0)
            ? round2(mul(line.commissionFlat, line.quantity))
            : round2(mul(base, div(line.commissionRatePct, 100)));

          if (amount.greaterThan(0)) {
            await tx.commissionEntry.create({
              data: {
                tenantId,
                branchId,
                staffId: line.staffId,
                invoiceId: invoice.id,
                invoiceItemId: invoiceItem.id,
                baseAmount: base,
                ratePct: line.commissionRatePct,
                amount,
                earnedOn: invoiceDate,
              },
            });
          }
        }

        // Stock: consumables used by the service, or the retail item sold
        if (line.itemType === 'SERVICE' && line.refId) {
          await stock.consumeForService(tx, {
            tenantId,
            branchId,
            serviceId: line.refId,
            quantity: Number(line.quantity),
            invoiceId: invoice.id,
            createdById: userId,
          });
        }
        if (line.itemType === 'PRODUCT' && line.refId) {
          await stock.recordSale(tx, {
            tenantId,
            branchId,
            productId: line.refId,
            quantity: Number(line.quantity),
            invoiceId: invoice.id,
            createdById: userId,
          });
        }
      }

      // 5b. Settlement ---------------------------------------------------
      let paid = d(0);

      if (input.loyaltyPointsToRedeem && customer) {
        const redeemed = await loyalty.redeemPoints(tx, {
          tenantId,
          customerId: customer.id,
          points: input.loyaltyPointsToRedeem,
          billAmount: grandTotal,
          invoiceId: invoice.id,
        });
        if (redeemed.value.greaterThan(0)) {
          await tx.payment.create({
            data: {
              tenantId,
              branchId,
              invoiceId: invoice.id,
              customerId: customer.id,
              mode: 'LOYALTY_POINTS',
              amount: redeemed.value,
              reference: `${redeemed.points} points`,
              receivedById: userId,
            },
          });
          paid = add(paid, redeemed.value);
        }
      }

      if (input.useWalletAmount && customer) {
        const available = d(customer.walletBalance);
        const useAmount = round2(decMin(d(input.useWalletAmount), decMin(available, sub(grandTotal, paid))));
        if (useAmount.greaterThan(0)) {
          const updated = await tx.customer.update({
            where: { id: customer.id },
            data: { walletBalance: { decrement: useAmount } },
            select: { walletBalance: true },
          });
          await tx.walletTransaction.create({
            data: {
              tenantId,
              customerId: customer.id,
              direction: 'OUT',
              amount: useAmount,
              balanceAfter: updated.walletBalance,
              reason: 'Applied to invoice',
              refType: 'INVOICE',
              refId: invoice.id,
            },
          });
          await tx.payment.create({
            data: {
              tenantId,
              branchId,
              invoiceId: invoice.id,
              customerId: customer.id,
              mode: 'WALLET',
              amount: useAmount,
              receivedById: userId,
            },
          });
          paid = add(paid, useAmount);
        }
      }

      for (const payment of input.payments ?? []) {
        if (payment.amount <= 0) continue;
        await tx.payment.create({
          data: {
            tenantId,
            branchId,
            invoiceId: invoice.id,
            customerId: customer?.id ?? null,
            mode: payment.mode,
            amount: payment.amount,
            reference: payment.reference ?? null,
            isAdvance: payment.isAdvance ?? false,
            notes: payment.notes ?? null,
            receivedById: userId,
          },
        });
        paid = add(paid, payment.amount);
      }

      const due = clampNonNegative(sub(grandTotal, paid));
      const status = due.isZero() ? 'PAID' : paid.greaterThan(0) ? 'PARTIALLY_PAID' : 'ISSUED';

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: decMin(paid, grandTotal), dueAmount: due, status },
      });

      // 5c. Loyalty earned on the amount actually charged ----------------
      if (customer) {
        await loyalty.earnPoints(tx, {
          tenantId,
          customerId: customer.id,
          amount: grandTotal,
          invoiceId: invoice.id,
          multiplier: membership ? Number(membership.plan.loyaltyMultiplier) : 1,
        });

        // 5d. Customer rollups -----------------------------------------
        const totalSpent = add(customer.totalSpent, grandTotal);
        const totalVisits = customer.totalVisits + 1;
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            totalVisits,
            totalSpent,
            avgBill: round2(div(totalSpent, totalVisits)),
            lastVisitAt: invoiceDate,
            firstVisitAt: customer.firstVisitAt ?? invoiceDate,
            outstanding: { increment: due },
            branchId: customer.branchId ?? branchId,
          },
        });
      }

      if (couponRecord) {
        await tx.coupon.update({ where: { id: couponRecord.id }, data: { usedCount: { increment: 1 } } });
        await tx.couponRedemption.create({
          data: {
            tenantId,
            couponId: couponRecord.id,
            customerId: customer?.id ?? null,
            invoiceId: invoice.id,
            amount: billDiscount,
          },
        });
      }

      if (appointmentId) {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        await tx.appointmentService.updateMany({
          where: { appointmentId, status: { not: 'CANCELLED' } },
          data: { status: 'COMPLETED' },
        });
      }

      return invoice.id;
    },
    { timeout: 20_000 },
  );

  // 6. Follow-ups (messaging, journeys) ----------------------------------
  if (customer) {
    const isFirstVisit = customer.totalVisits === 0;
    enqueueSafe('journey.trigger', {
      trigger: isFirstVisit ? 'FIRST_VISIT' : 'INVOICE_PAID',
      customerId: customer.id,
      invoiceId,
    });
    if (appointmentId) {
      enqueueSafe('journey.trigger', { trigger: 'APPOINTMENT_COMPLETED', customerId: customer.id, appointmentId });
    }
    enqueueSafe('challenge.progress', { customerId: customer.id, invoiceId });
  }
  if (input.sendInvoice !== false && customer) {
    enqueueSafe('invoice.post_process', { invoiceId, sendInvoice: true });
  }

  logger.info({ invoiceId, branchId, grandTotal: grandTotal.toString() }, 'invoice created');
  return getInvoice(invoiceId);
}

export async function getInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
  if (!invoice) throw NotFound('Invoice');
  return { ...invoice, taxBreakup: taxSummary(invoice.items) };
}

export async function listInvoices(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  branchId?: string;
  customerId?: string;
  staffId?: string;
  status?: string;
  from?: Date;
  to?: Date;
  unpaidOnly?: boolean;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.InvoiceWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.staffId ? { items: { some: { staffId: input.staffId } } } : {}),
    ...(input.status ? { status: input.status as Prisma.EnumInvoiceStatusFilter['equals'] } : {}),
    ...(input.unpaidOnly ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueAmount: { gt: 0 } } : {}),
    ...(input.from || input.to
      ? { invoiceDate: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
    ...(input.q
      ? {
          OR: [
            { invoiceNumber: { contains: input.q, mode: 'insensitive' as const } },
            { customer: { firstName: { contains: input.q, mode: 'insensitive' as const } } },
            { customer: { phone: { contains: input.q } } },
          ],
        }
      : {}),
  };

  const [items, total, totals] = await Promise.all([
    prisma.invoice.findMany({
      where,
      skip,
      take,
      orderBy: { invoiceDate: 'desc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        branch: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({ where, _sum: { grandTotal: true, paidAmount: true, dueAmount: true } }),
  ]);

  return {
    items,
    total,
    page,
    pageSize,
    totals: {
      billed: totals._sum.grandTotal ?? 0,
      collected: totals._sum.paidAmount ?? 0,
      outstanding: totals._sum.dueAmount ?? 0,
    },
  };
}

/** Settle an outstanding bill later (credit customers, advance adjustments). */
export async function addPayment(invoiceId: string, payment: PaymentInput) {
  const tenantId = requireTenantId();
  const userId = currentUserId();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') throw Conflict('This invoice has been voided');

  const amount = round2(payment.amount);
  if (amount.lessThanOrEqualTo(0)) throw BadRequest('Payment amount must be positive');
  if (gt(amount, invoice.dueAmount)) {
    throw BadRequest(`Only ${invoice.dueAmount.toString()} is outstanding on this invoice`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        tenantId,
        branchId: invoice.branchId,
        invoiceId,
        customerId: invoice.customerId,
        mode: payment.mode,
        amount,
        reference: payment.reference ?? null,
        notes: payment.notes ?? null,
        receivedById: userId,
      },
    });

    const paidAmount = add(invoice.paidAmount, amount);
    const dueAmount = clampNonNegative(sub(invoice.grandTotal, paidAmount));

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount,
        dueAmount,
        status: dueAmount.isZero() ? 'PAID' : 'PARTIALLY_PAID',
      },
    });

    if (invoice.customerId) {
      await tx.customer.update({
        where: { id: invoice.customerId },
        data: { outstanding: { decrement: amount } },
      });
    }

    return updated;
  });
}

/**
 * Take back a payment that was recorded by mistake — the "marked paid, wasn't"
 * case. The bill's status falls back to whatever the remaining payments say:
 * PAID, PARTIALLY_PAID, or ISSUED with the full amount due again.
 */
export async function removePayment(invoiceId: string, paymentId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') throw Conflict('This invoice has been voided');
  if (invoice.status === 'REFUNDED') throw Conflict('This invoice has been refunded — reverse the refund first');

  const payment = invoice.payments.find((p) => p.id === paymentId);
  if (!payment) throw NotFound('Payment');
  if (payment.isAdvance) throw Conflict('Advance payments are taken back from the wallet, not from the bill');

  return prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: paymentId } });

    const paidAmount = clampNonNegative(sub(invoice.paidAmount, payment.amount));
    const dueAmount = clampNonNegative(sub(invoice.grandTotal, paidAmount));

    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paidAmount,
        dueAmount,
        status: dueAmount.isZero() ? 'PAID' : paidAmount.isZero() ? 'ISSUED' : 'PARTIALLY_PAID',
      },
    });

    if (invoice.customerId) {
      await tx.customer.update({
        where: { id: invoice.customerId },
        data: { outstanding: { increment: payment.amount } },
      });
    }

    return { invoice: updated, removed: payment };
  });
}

/**
 * Remove a bill from the books entirely. Only a voided bill can go: voiding is
 * what gives back the stock, points, sessions and commission, so a delete never
 * has to unwind anything — it just removes a record that already counts for
 * nothing. Everyone with the permission is told, in the UI and here, that a
 * gap in the invoice sequence is what an auditor notices first.
 */
export async function deleteInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { items: true, payments: true } });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status !== 'VOID' && invoice.status !== 'DRAFT') {
    throw Conflict('Void the bill first — deleting only removes a bill that already counts for nothing');
  }
  if (invoice.payments.some((p) => !p.isAdvance)) {
    throw Conflict('This bill still has payments recorded against it — refund or remove them first');
  }

  await prisma.invoice.delete({ where: { id } });
  return invoice;
}

/** Advance payment taken before any bill exists — lands in the customer wallet. */
export async function addAdvance(input: { customerId: string; amount: number; mode: PaymentMode; reference?: string; branchId?: string }) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);
  const userId = currentUserId();

  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw NotFound('Customer');

  const amount = round2(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw BadRequest('Advance must be positive');

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customer.update({
      where: { id: input.customerId },
      data: { walletBalance: { increment: amount } },
      select: { walletBalance: true },
    });

    await tx.walletTransaction.create({
      data: {
        tenantId,
        customerId: input.customerId,
        direction: 'IN',
        amount,
        balanceAfter: updated.walletBalance,
        reason: 'Advance payment',
      },
    });

    const payment = await tx.payment.create({
      data: {
        tenantId,
        branchId,
        customerId: input.customerId,
        mode: input.mode,
        amount,
        isAdvance: true,
        reference: input.reference ?? null,
        receivedById: userId,
      },
    });

    return { payment, walletBalance: updated.walletBalance };
  });
}

export async function refundInvoice(input: { invoiceId: string; amount: number; mode: PaymentMode; reason?: string; toWallet?: boolean }) {
  const tenantId = requireTenantId();
  const userId = currentUserId();

  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') throw Conflict('This invoice has been voided');

  const amount = round2(input.amount);
  const refundable = sub(invoice.paidAmount, invoice.refundedAmount);
  if (amount.lessThanOrEqualTo(0)) throw BadRequest('Refund amount must be positive');
  if (gt(amount, refundable)) throw BadRequest(`At most ${refundable.toString()} can be refunded`);

  return prisma.$transaction(async (tx) => {
    const refund = await tx.refund.create({
      data: {
        tenantId,
        branchId: invoice.branchId,
        invoiceId: invoice.id,
        amount,
        mode: input.toWallet ? 'WALLET' : input.mode,
        reason: input.reason ?? null,
        refundedById: userId,
      },
    });

    const refundedAmount = add(invoice.refundedAmount, amount);
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        refundedAmount,
        status: refundedAmount.greaterThanOrEqualTo(invoice.grandTotal) ? 'REFUNDED' : invoice.status,
      },
    });

    if (input.toWallet && invoice.customerId) {
      const updated = await tx.customer.update({
        where: { id: invoice.customerId },
        data: { walletBalance: { increment: amount } },
        select: { walletBalance: true },
      });
      await tx.walletTransaction.create({
        data: {
          tenantId,
          customerId: invoice.customerId,
          direction: 'IN',
          amount,
          balanceAfter: updated.walletBalance,
          reason: `Refund for invoice ${invoice.invoiceNumber}`,
          refType: 'REFUND',
          refId: refund.id,
        },
      });
    }

    return refund;
  });
}

/**
 * Voiding reverses the ledger: stock returns, commissions are dropped, loyalty
 * points are clawed back and the customer's rollups are corrected. The invoice
 * itself is kept for the audit trail.
 */
export async function voidInvoice(id: string, reason: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { items: true, payments: true, loyaltyTxns: true },
  });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status === 'VOID') throw Conflict('This invoice is already void');

  await prisma.$transaction(async (tx) => {
    await stock.reverseInvoiceMovements(tx, id);
    await tx.commissionEntry.deleteMany({ where: { invoiceId: id, isPaid: false } });

    if (invoice.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: invoice.customerId } });
      if (customer) {
        const earned = invoice.loyaltyTxns
          .filter((t) => t.type === 'EARN')
          .reduce((acc, t) => acc + t.points, 0);
        const redeemed = invoice.loyaltyTxns
          .filter((t) => t.type === 'REDEEM')
          .reduce((acc, t) => acc + Math.abs(t.points), 0);

        const pointsDelta = redeemed - earned;
        const totalVisits = Math.max(0, customer.totalVisits - 1);
        const totalSpent = clampNonNegative(sub(customer.totalSpent, invoice.grandTotal));

        await tx.customer.update({
          where: { id: customer.id },
          data: {
            loyaltyPoints: Math.max(0, customer.loyaltyPoints + pointsDelta),
            totalVisits,
            totalSpent,
            avgBill: totalVisits > 0 ? round2(div(totalSpent, totalVisits)) : 0,
            outstanding: { decrement: invoice.dueAmount },
          },
        });

        if (pointsDelta !== 0) {
          await tx.loyaltyTransaction.create({
            data: {
              tenantId: invoice.tenantId,
              customerId: customer.id,
              type: 'ADJUST',
              points: pointsDelta,
              balanceAfter: Math.max(0, customer.loyaltyPoints + pointsDelta),
              reason: `Invoice ${invoice.invoiceNumber} voided`,
              invoiceId: id,
            },
          });
        }
      }
    }

    // Give back any package sessions and membership benefits that were used.
    for (const item of invoice.items) {
      if (item.redeemedFrom === 'PACKAGE' && item.packagePurchaseItemId) {
        await tx.packagePurchaseItem.update({
          where: { id: item.packagePurchaseItemId },
          data: { usedQty: { decrement: Number(item.quantity) } },
        });
      }
      if (item.redeemedFrom === 'MEMBERSHIP' && item.membershipSubscriptionId && item.refId) {
        const usage = await tx.membershipBenefitUsage.findFirst({
          where: { subscriptionId: item.membershipSubscriptionId, serviceId: item.refId },
        });
        if (usage) {
          await tx.membershipBenefitUsage.update({
            where: { id: usage.id },
            data: { usedQty: { decrement: Number(item.quantity) } },
          });
        }
      }
    }

    await tx.packageRedemption.deleteMany({ where: { invoiceId: id } });

    if (invoice.appointmentId) {
      await tx.appointment.update({ where: { id: invoice.appointmentId }, data: { status: 'CHECKED_IN' } });
    }

    await tx.invoice.update({
      where: { id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: reason, dueAmount: 0 },
    });
  });

  logger.warn({ invoiceId: id, reason }, 'invoice voided');
  return getInvoice(id);
}

/** Day-end cash-up: collections by payment mode. */
export async function collectionSummary(input: { date?: Date; from?: Date; to?: Date; branchId?: string }) {
  const tenantId = requireTenantId();
  const from = input.from ?? startOfDay(input.date ?? new Date());
  const to = input.to ?? endOfDay(input.date ?? new Date());

  const [byMode, invoiceAgg, refundAgg] = await Promise.all([
    prisma.payment.groupBy({
      by: ['mode'],
      where: { tenantId, ...branchFilter(input.branchId), receivedAt: { gte: from, lte: to } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.invoice.aggregate({
      where: {
        tenantId,
        ...branchFilter(input.branchId),
        invoiceDate: { gte: from, lte: to },
        status: { not: 'VOID' },
      },
      _sum: { grandTotal: true, totalTax: true, billDiscount: true, itemDiscount: true, dueAmount: true },
      _count: { _all: true },
    }),
    prisma.refund.aggregate({
      where: { tenantId, ...branchFilter(input.branchId), refundedAt: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
  ]);

  const collected = byMode.reduce<Prisma.Decimal>((acc, m) => acc.plus(m._sum.amount ?? 0), d(0));

  return {
    period: { from, to },
    invoices: invoiceAgg._count._all,
    billed: invoiceAgg._sum.grandTotal ?? 0,
    tax: invoiceAgg._sum.totalTax ?? 0,
    discount: add(invoiceAgg._sum.billDiscount ?? 0, invoiceAgg._sum.itemDiscount ?? 0),
    outstanding: invoiceAgg._sum.dueAmount ?? 0,
    refunds: refundAgg._sum.amount ?? 0,
    collected,
    netCollected: sub(collected, refundAgg._sum.amount ?? 0),
    byMode: byMode.map((m) => ({ mode: m.mode, amount: m._sum.amount ?? 0, count: m._count._all })),
  };
}

export async function outstandingInvoices(input: { branchId?: string; page?: number; pageSize?: number }) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.InvoiceWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
    dueAmount: { gt: 0 },
  };

  const [items, total, agg] = await Promise.all([
    prisma.invoice.findMany({
      where,
      skip,
      take,
      orderBy: { invoiceDate: 'asc' },
      include: { customer: { select: { id: true, firstName: true, lastName: true, phone: true } } },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({ where, _sum: { dueAmount: true } }),
  ]);

  return { items, total, page, pageSize, totalOutstanding: agg._sum.dueAmount ?? 0 };
}

/** GST summary for a period, ready for filing. */
export async function gstReport(input: { from: Date; to: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const items = await prisma.invoiceItem.findMany({
    where: {
      tenantId,
      ...branchFilter(input.branchId),
      invoice: { invoiceDate: { gte: input.from, lte: input.to }, status: { not: 'VOID' }, isGst: true },
    },
    select: {
      hsnSac: true,
      taxRatePct: true,
      taxableValue: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      itemType: true,
    },
  });

  const summary = taxSummary(items);
  const totals = summary.reduce(
    (acc, row) => ({
      taxableValue: add(acc.taxableValue, row.taxableValue),
      cgst: add(acc.cgst, row.cgst),
      sgst: add(acc.sgst, row.sgst),
      igst: add(acc.igst, row.igst),
    }),
    { taxableValue: d(0), cgst: d(0), sgst: d(0), igst: d(0) },
  );

  return {
    period: { from: input.from, to: input.to },
    byHsn: summary,
    totals: { ...totals, totalTax: add(totals.cgst, totals.sgst, totals.igst) },
  };
}

/** Everything the POS needs to price a basket for one customer. */
export async function posContext(customerId: string) {
  const [customer, membership, redeemablePackages, program] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, firstName: true, lastName: true, phone: true, loyaltyPoints: true, walletBalance: true, outstanding: true, tier: true },
    }),
    memberships.membershipBenefitsForCustomer(customerId),
    packages.redeemableForCustomer(customerId),
    loyalty.getProgram(),
  ]);
  if (!customer) throw NotFound('Customer');

  const pointsValue = round2(mul(customer.loyaltyPoints, program.pointValue));

  return {
    customer,
    membership,
    packages: redeemablePackages,
    loyalty: {
      points: customer.loyaltyPoints,
      value: pointsValue,
      minRedeemPoints: program.minRedeemPoints,
      maxRedeemPctOfBill: program.maxRedeemPctOfBill,
      pointValue: program.pointValue,
    },
    wallet: customer.walletBalance,
    outstanding: customer.outstanding,
  };
}

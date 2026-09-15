/* eslint-disable no-console */
import bcrypt from 'bcryptjs';
import { PrismaClient, type Prisma } from '@prisma/client';
import { DEFAULT_JOURNEYS, DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';
import { deleteTenantCompletely } from '../src/core/tenant-delete';
import {
  FAIR_USE_UNLIMITED,
  GROWTH_FEATURES,
  PILOT_FEATURES,
  PRO_FEATURES,
  STARTER_FEATURES,
  featureMap,
} from '../src/core/features';

const prisma = new PrismaClient();

const PASSWORD = process.env.SEED_PASSWORD ?? 'Salon@12345';
const TENANT_SLUG = process.env.SEED_TENANT_SLUG ?? 'parlon';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function daysAhead(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function at(date: Date, hour: number, minute = 0): Date {
  const copy = new Date(date);
  copy.setHours(hour, minute, 0, 0);
  return copy;
}

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length]!;
}

/**
 * Refuse to start if the database is behind the schema file.
 *
 * This project syncs with `prisma db push` rather than migrations, so it is
 * easy to pull new code and seed against yesterday's database. The failure
 * that causes is the bad kind: the seed deletes the existing tenant first and
 * only then hits an enum value Postgres has never heard of, leaving the salon
 * gone and the reseed half done. So the check runs before anything is deleted,
 * and names the command rather than the error.
 */
async function assertSchemaIsCurrent() {
  const needed = [...new Set(DEFAULT_JOURNEYS.map((journey) => journey.trigger as string))];

  const rows = await prisma.$queryRaw<{ value: string }[]>`
    SELECT e.enumlabel AS value
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'JourneyTrigger'
  `;
  const known = new Set(rows.map((row) => row.value));
  const missing = needed.filter((value) => !known.has(value));

  if (missing.length > 0) {
    console.error(
      `\nThe database is behind prisma/schema.prisma.\n` +
        `Missing JourneyTrigger values: ${missing.join(', ')}\n\n` +
        `Nothing has been changed. Run this first, then seed again:\n\n` +
        `  npx prisma db push\n  npm run seed\n`,
    );
    process.exit(1);
  }
}

async function main() {
  console.log('Seeding Parlon…');
  await assertSchemaIsCurrent();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // ----------------------------------------------------------- platform ----
  await prisma.platformUser.upsert({
    where: { email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@parlon.in' },
    update: {},
    create: {
      name: 'Platform Admin',
      email: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@parlon.in',
      passwordHash: await bcrypt.hash(process.env.PLATFORM_ADMIN_PASSWORD ?? 'Admin@12345', 10),
    },
  });

  // The plans as sold. Quotas come straight from the published pricing table;
  // "unlimited" is the FAIR_USE_UNLIMITED ceiling, not the absence of a limit.
  const plans = [
    {
      code: 'PILOT',
      name: '14-Day Pilot',
      pricePerMonth: 0,
      maxBranches: 1,
      maxStaff: 5,
      maxCustomers: 500,
      waUtilityQuota: 100,
      waMarketingQuota: 50,
      waAuthQuota: 0,
      smsQuota: 200,
      emailQuota: 500,
      // A pilot is 100 utility messages; an overdraft bigger than that would be a second plan.
      overdraftLimit: 50,
      maxCampaignsPerMonth: 3,
      extraBranchPrice: null,
      features: featureMap(PILOT_FEATURES),
    },
    {
      code: 'STARTER',
      name: 'Starter',
      pricePerMonth: 999,
      maxBranches: 1,
      maxStaff: 5,
      maxCustomers: 1000,
      waUtilityQuota: 500,
      waMarketingQuota: 0,
      waAuthQuota: 0,
      smsQuota: 1000,
      emailQuota: 1000,
      // Enough to finish a day of reminders if the allowance runs out mid-morning.
      overdraftLimit: 100,
      // No marketing on this plan, so no campaigns either. The number is here
      // rather than left at a default so nothing reads as "a few are fine".
      maxCampaignsPerMonth: 0,
      extraBranchPrice: null,
      features: featureMap(STARTER_FEATURES),
    },
    {
      code: 'GROWTH',
      name: 'Growth',
      pricePerMonth: 2499,
      maxBranches: 1,
      maxStaff: 20,
      maxCustomers: 5000,
      waUtilityQuota: 1000,
      waMarketingQuota: 500,
      waAuthQuota: 0,
      smsQuota: 3000,
      emailQuota: 3000,
      overdraftLimit: 200,
      maxCampaignsPerMonth: FAIR_USE_UNLIMITED,
      extraBranchPrice: null,
      features: featureMap(GROWTH_FEATURES),
    },
    {
      code: 'PRO',
      name: 'Pro',
      pricePerMonth: 4999,
      maxBranches: 3,
      maxStaff: 200,
      maxCustomers: FAIR_USE_UNLIMITED,
      waUtilityQuota: 2000,
      waMarketingQuota: 1000,
      waAuthQuota: 500,
      smsQuota: 5000,
      emailQuota: 5000,
      overdraftLimit: 300,
      maxCampaignsPerMonth: FAIR_USE_UNLIMITED,
      extraBranchPrice: 999,
      features: featureMap(PRO_FEATURES),
    },
  ];

  for (const plan of plans) {
    const { features, ...rest } = plan;
    await prisma.plan.upsert({
      where: { code: plan.code },
      // Re-running the seed should correct a plan that has drifted, not skip it.
      update: { ...rest, features },
      create: { ...rest, pricePerYear: plan.pricePerMonth * 10, features },
    });
  }

  // Add-on packs. These top up a balance that carries over; the monthly plan
  // allowance is what resets. Prices are what the salon pays after WhatsApp's
  // own per-message cost, which is why marketing packs cost more per message.
  const packs = [
    { code: 'WA_UTIL_1K', name: '1,000 WhatsApp utility', meter: 'WA_UTILITY' as const, quantity: 1000, price: 300, sortOrder: 1 },
    { code: 'WA_UTIL_5K', name: '5,000 WhatsApp utility', meter: 'WA_UTILITY' as const, quantity: 5000, price: 1250, sortOrder: 2 },
    { code: 'WA_MKTG_500', name: '500 WhatsApp marketing', meter: 'WA_MARKETING' as const, quantity: 500, price: 500, sortOrder: 1 },
    { code: 'WA_MKTG_2K', name: '2,000 WhatsApp marketing', meter: 'WA_MARKETING' as const, quantity: 2000, price: 1800, sortOrder: 2 },
    { code: 'SMS_1K', name: '1,000 SMS', meter: 'SMS' as const, quantity: 1000, price: 300, sortOrder: 1 },
    { code: 'SMS_5K', name: '5,000 SMS', meter: 'SMS' as const, quantity: 5000, price: 1250, sortOrder: 2 },
  ];

  for (const pack of packs) {
    await prisma.creditPack.upsert({
      where: { code: pack.code },
      update: { ...pack },
      create: { ...pack },
    });
  }

  // The demo salon has two branches, so it has to be on the plan that allows
  // them — otherwise the seeded data contradicts the limits the app enforces.
  const demoPlan = await prisma.plan.findUniqueOrThrow({ where: { code: 'PRO' } });

  // ------------------------------------------------------------- tenant ----
  const existing = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (existing) {
    console.log(`Tenant "${TENANT_SLUG}" already exists — deleting and reseeding.`);
    await deleteTenantCompletely(prisma, existing.id);
  }

  const tenant = await prisma.tenant.create({
    data: {
      name: 'Parlon Salon & Spa',
      slug: TENANT_SLUG,
      legalName: 'Parlon Wellness Pvt Ltd',
      gstin: '09AABCG1234M1Z5',
      phone: '9876543210',
      email: 'hello@parlon.in',
      addressLine: '12 Hazratganj Main Road',
      city: 'Lucknow',
      state: 'Uttar Pradesh',
      stateCode: '09',
      pincode: '226001',
      status: 'ACTIVE',
      planId: demoPlan.id,
      settings: {
        gstEnabled: true,
        pricesIncludeTax: true,
        defaultGstRate: 18,
        invoiceRoundOff: true,
        allowOnlineBooking: true,
        appointmentSlotMinutes: 15,
        cancellationWindowHours: 4,
      } as Prisma.InputJsonValue,
    },
  });
  const tenantId = tenant.id;

  const openingHours = {
    '0': [{ open: '10:00', close: '20:00' }],
    '1': [{ open: '10:00', close: '20:00' }],
    '2': [{ open: '10:00', close: '20:00' }],
    '3': [{ open: '10:00', close: '20:00' }],
    '4': [{ open: '10:00', close: '20:00' }],
    '5': [{ open: '10:00', close: '21:00' }],
    '6': [{ open: '09:00', close: '21:00' }],
  } as Prisma.InputJsonValue;

  const hazratganj = await prisma.branch.create({
    data: {
      tenantId,
      name: 'Hazratganj',
      code: 'HZG',
      phone: '9876543210',
      addressLine: '12 Hazratganj Main Road',
      city: 'Lucknow',
      state: 'Uttar Pradesh',
      stateCode: '09',
      pincode: '226001',
      gstin: '09AABCG1234M1Z5',
      region: 'Lucknow',
      openingHours,
      invoicePrefix: 'HZG',
    },
  });

  const gomtiNagar = await prisma.branch.create({
    data: {
      tenantId,
      name: 'Gomti Nagar',
      code: 'GMT',
      phone: '9876543211',
      addressLine: 'Vibhuti Khand, Gomti Nagar',
      city: 'Lucknow',
      state: 'Uttar Pradesh',
      stateCode: '09',
      pincode: '226010',
      region: 'Lucknow',
      openingHours,
      invoicePrefix: 'GMT',
    },
  });

  await prisma.resource.createMany({
    data: [
      { tenantId, branchId: hazratganj.id, name: 'Chair 1', type: 'CHAIR' },
      { tenantId, branchId: hazratganj.id, name: 'Chair 2', type: 'CHAIR' },
      { tenantId, branchId: hazratganj.id, name: 'Chair 3', type: 'CHAIR' },
      { tenantId, branchId: hazratganj.id, name: 'Spa Room 1', type: 'ROOM' },
      { tenantId, branchId: gomtiNagar.id, name: 'Chair 1', type: 'CHAIR' },
      { tenantId, branchId: gomtiNagar.id, name: 'Chair 2', type: 'CHAIR' },
    ],
  });

  // -------------------------------------------------------------- users ----
  const users = [
    { name: 'Ravi Jha', email: 'owner@parlon.in', role: 'OWNER' as const },
    { name: 'Meera Kapoor', email: 'manager@parlon.in', role: 'MANAGER' as const },
    { name: 'Sunita Verma', email: 'reception@parlon.in', role: 'RECEPTIONIST' as const },
    { name: 'Arun Gupta', email: 'accounts@parlon.in', role: 'ACCOUNTANT' as const },
  ];

  const createdUsers: { id: string }[] = [];
  for (const user of users) {
    const record = await prisma.user.create({
      data: { tenantId, ...user, passwordHash, phone: '98765432' + String(10 + createdUsers.length) },
    });
    await prisma.userBranch.create({ data: { tenantId, userId: record.id, branchId: hazratganj.id } });
    if (user.role === 'OWNER') {
      await prisma.userBranch.create({ data: { tenantId, userId: record.id, branchId: gomtiNagar.id } });
    }
    createdUsers.push(record);
  }

  // ----------------------------------------------------------- catalogue ---
  const categoryNames = ['Hair', 'Skin', 'Nails', 'Spa & Massage', 'Makeup', 'Grooming'];
  const categories: Record<string, string> = {};
  for (const [index, name] of categoryNames.entries()) {
    const category = await prisma.serviceCategory.create({ data: { tenantId, name, sortOrder: index } });
    categories[name] = category.id;
  }

  const serviceSeed = [
    { name: 'Haircut (Women)', category: 'Hair', price: 700, durationMin: 45, gender: 'FEMALE' as const, commissionRate: 10 },
    { name: 'Haircut (Men)', category: 'Hair', price: 350, durationMin: 30, gender: 'MALE' as const, commissionRate: 10 },
    { name: 'Hair Colour - Global', category: 'Hair', price: 3500, durationMin: 120, gender: 'UNISEX' as const, commissionRate: 12 },
    { name: 'Hair Colour - Root Touch Up', category: 'Hair', price: 1500, durationMin: 60, gender: 'UNISEX' as const, commissionRate: 12 },
    { name: 'Hair Spa', category: 'Hair', price: 1200, durationMin: 60, gender: 'UNISEX' as const, commissionRate: 10 },
    { name: 'Keratin Treatment', category: 'Hair', price: 6500, durationMin: 180, gender: 'UNISEX' as const, commissionRate: 15 },
    { name: 'Classic Facial', category: 'Skin', price: 1500, durationMin: 60, gender: 'UNISEX' as const, commissionRate: 10 },
    { name: 'Gold Facial', category: 'Skin', price: 2500, durationMin: 75, gender: 'UNISEX' as const, commissionRate: 12 },
    { name: 'Clean Up', category: 'Skin', price: 800, durationMin: 40, gender: 'UNISEX' as const, commissionRate: 8 },
    { name: 'Manicure', category: 'Nails', price: 600, durationMin: 40, gender: 'UNISEX' as const, commissionRate: 8 },
    { name: 'Pedicure', category: 'Nails', price: 800, durationMin: 50, gender: 'UNISEX' as const, commissionRate: 8 },
    { name: 'Gel Nail Extensions', category: 'Nails', price: 2200, durationMin: 90, gender: 'FEMALE' as const, commissionRate: 12 },
    { name: 'Head Massage', category: 'Spa & Massage', price: 700, durationMin: 30, gender: 'UNISEX' as const, commissionRate: 10 },
    { name: 'Full Body Massage', category: 'Spa & Massage', price: 2800, durationMin: 90, gender: 'UNISEX' as const, commissionRate: 12 },
    { name: 'Party Makeup', category: 'Makeup', price: 3500, durationMin: 90, gender: 'FEMALE' as const, commissionRate: 15 },
    { name: 'Bridal Makeup', category: 'Makeup', price: 15000, durationMin: 180, gender: 'FEMALE' as const, commissionRate: 15 },
    { name: 'Beard Trim & Shape', category: 'Grooming', price: 300, durationMin: 25, gender: 'MALE' as const, commissionRate: 10 },
    { name: 'Threading (Eyebrows)', category: 'Grooming', price: 100, durationMin: 15, gender: 'FEMALE' as const, commissionRate: 5 },
  ];

  const services = [];
  for (const item of serviceSeed) {
    const service = await prisma.service.create({
      data: {
        tenantId,
        categoryId: categories[item.category]!,
        name: item.name,
        price: item.price,
        memberPrice: Math.round(item.price * 0.9),
        durationMin: item.durationMin,
        bufferMin: item.durationMin >= 90 ? 15 : 5,
        gender: item.gender,
        taxRatePct: 18,
        hsnSac: '999721',
        commissionType: 'PERCENT_OF_SERVICE',
        commissionRate: item.commissionRate,
      },
    });
    services.push(service);
  }

  // -------------------------------------------------------------- staff ----
  const staffSeed = [
    { displayName: 'Riya Sharma', designation: 'Senior Hair Stylist', branchId: hazratganj.id, baseSalary: 28000, commissionRate: 10, colorHex: '#E91E63' },
    { displayName: 'Kavya Nair', designation: 'Beautician', branchId: hazratganj.id, baseSalary: 22000, commissionRate: 8, colorHex: '#9C27B0' },
    { displayName: 'Aman Singh', designation: 'Hair Stylist', branchId: hazratganj.id, baseSalary: 24000, commissionRate: 10, colorHex: '#3F51B5' },
    { displayName: 'Neha Joshi', designation: 'Nail Artist', branchId: hazratganj.id, baseSalary: 20000, commissionRate: 12, colorHex: '#009688' },
    { displayName: 'Pooja Rani', designation: 'Senior Beautician', branchId: gomtiNagar.id, baseSalary: 26000, commissionRate: 10, colorHex: '#FF5722' },
    { displayName: 'Vikas Yadav', designation: 'Hair Stylist', branchId: gomtiNagar.id, baseSalary: 23000, commissionRate: 10, colorHex: '#795548' },
  ];

  const staff = [];
  for (const [index, member] of staffSeed.entries()) {
    const record = await prisma.staff.create({
      data: {
        tenantId,
        ...member,
        code: `S${String(index + 1).padStart(3, '0')}`,
        phone: `98765000${index + 10}`,
        commissionType: 'PERCENT_OF_SERVICE',
        joinedAt: daysAgo(400 - index * 30),
        specialities: index % 2 === 0 ? ['Hair', 'Colour'] : ['Skin', 'Nails'],
      },
    });

    await prisma.staffService.createMany({
      data: services.map((service) => ({ tenantId, staffId: record.id, serviceId: service.id })),
      skipDuplicates: true,
    });

    await prisma.staffAvailability.createMany({
      data: [0, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        tenantId,
        staffId: record.id,
        dayOfWeek,
        startTime: '10:00',
        endTime: '20:00',
      })),
      skipDuplicates: true,
    });

    await prisma.staffTarget.create({
      data: {
        tenantId,
        staffId: record.id,
        periodMonth: new Date().getMonth() + 1,
        periodYear: new Date().getFullYear(),
        revenueTarget: 200000,
        serviceCountTarget: 120,
      },
    });

    staff.push(record);
  }

  // ---------------------------------------------------------- inventory ----
  const brand = await prisma.brand.create({ data: { tenantId, name: 'L\'Oréal Professionnel' } });
  const brand2 = await prisma.brand.create({ data: { tenantId, name: 'Wella' } });
  const productCategory = await prisma.productCategory.create({ data: { tenantId, name: 'Hair Colour' } });
  const retailCategory = await prisma.productCategory.create({ data: { tenantId, name: 'Retail' } });

  const supplier = await prisma.supplier.create({
    data: {
      tenantId,
      name: 'Lucknow Beauty Distributors',
      contactName: 'Mr. Khan',
      phone: '9812345678',
      gstin: '09AAACL1234K1Z9',
      paymentTerms: 'Net 30',
    },
  });

  const productSeed = [
    { name: 'Majirel Colour', shade: '5.0', unit: 'ml', costPrice: 480, sellingPrice: 0, reorderLevel: 200, isConsumable: true },
    { name: 'Majirel Colour', shade: '6.3', unit: 'ml', costPrice: 480, sellingPrice: 0, reorderLevel: 200, isConsumable: true },
    { name: 'Developer 20 Vol', shade: null, unit: 'ml', costPrice: 220, sellingPrice: 0, reorderLevel: 500, isConsumable: true },
    { name: 'Hair Spa Cream', shade: null, unit: 'g', costPrice: 900, sellingPrice: 0, reorderLevel: 300, isConsumable: true },
    { name: 'Serum 50ml', shade: null, unit: 'pcs', costPrice: 450, sellingPrice: 850, reorderLevel: 5, isConsumable: false, isRetail: true },
    { name: 'Shampoo 300ml', shade: null, unit: 'pcs', costPrice: 520, sellingPrice: 950, reorderLevel: 6, isConsumable: false, isRetail: true },
  ];

  const products = [];
  for (const item of productSeed) {
    const product = await prisma.product.create({
      data: {
        tenantId,
        brandId: item.isRetail ? brand2.id : brand.id,
        categoryId: item.isRetail ? retailCategory.id : productCategory.id,
        name: item.name,
        shade: item.shade,
        unit: item.unit,
        costPrice: item.costPrice,
        sellingPrice: item.sellingPrice,
        reorderLevel: item.reorderLevel,
        isConsumable: item.isConsumable,
        isRetail: item.isRetail ?? false,
        hsnSac: '3305',
      },
    });

    const opening = item.isRetail ? 10 : 1000;
    await prisma.stock.create({ data: { tenantId, branchId: hazratganj.id, productId: product.id, quantity: opening } });
    await prisma.stockMovement.create({
      data: {
        tenantId,
        branchId: hazratganj.id,
        productId: product.id,
        type: 'OPENING',
        quantity: opening,
        unitCost: item.costPrice,
        balanceAfter: opening,
        notes: 'Opening stock',
      },
    });
    products.push(product);
  }

  // Hair colour service consumes colour + developer.
  const colourService = services.find((s) => s.name === 'Hair Colour - Global')!;
  await prisma.serviceConsumption.createMany({
    data: [
      { tenantId, serviceId: colourService.id, productId: products[0]!.id, quantity: 50 },
      { tenantId, serviceId: colourService.id, productId: products[2]!.id, quantity: 75 },
    ],
  });

  const spaService = services.find((s) => s.name === 'Hair Spa')!;
  await prisma.serviceConsumption.create({
    data: { tenantId, serviceId: spaService.id, productId: products[3]!.id, quantity: 30 },
  });

  // ---------------------------------------------- packages & memberships ---
  const hairPackage = await prisma.packageTemplate.create({
    data: {
      tenantId,
      name: 'Hair Care Package',
      description: '5 haircuts, 2 hair spas and 1 global colour',
      price: 5000,
      validityDays: 90,
      items: {
        create: [
          { tenantId, serviceId: services.find((s) => s.name === 'Haircut (Women)')!.id, quantity: 5 },
          { tenantId, serviceId: spaService.id, quantity: 2 },
          { tenantId, serviceId: colourService.id, quantity: 1 },
        ],
      },
    },
  });

  await prisma.packageTemplate.create({
    data: {
      tenantId,
      name: 'Radiance Skin Package',
      description: '4 clean-ups and 2 gold facials',
      price: 5500,
      validityDays: 120,
      items: {
        create: [
          { tenantId, serviceId: services.find((s) => s.name === 'Clean Up')!.id, quantity: 4 },
          { tenantId, serviceId: services.find((s) => s.name === 'Gold Facial')!.id, quantity: 2 },
        ],
      },
    },
  });

  const goldPlan = await prisma.membershipPlan.create({
    data: {
      tenantId,
      name: 'Gold Membership',
      description: '10% off all services, 5 free haircuts and priority booking',
      price: 9999,
      durationDays: 365,
      serviceDiscountPct: 10,
      productDiscountPct: 5,
      priorityBooking: true,
      birthdayBenefit: 'Complimentary clean-up',
      loyaltyMultiplier: 1.5,
      benefits: {
        create: [{ tenantId, serviceId: services.find((s) => s.name === 'Haircut (Women)')!.id, quantity: 5 }],
      },
    },
  });

  await prisma.membershipPlan.create({
    data: {
      tenantId,
      name: 'Silver Membership',
      price: 4999,
      durationDays: 180,
      serviceDiscountPct: 7,
      loyaltyMultiplier: 1.25,
    },
  });

  // ------------------------------------------------------------ loyalty ----
  await prisma.loyaltyProgram.create({
    data: {
      tenantId,
      amountPerPoint: 100,
      pointValue: 0.5,
      referralPoints: 100,
      birthdayPoints: 50,
      reviewPoints: 25,
      minRedeemPoints: 100,
      maxRedeemPctOfBill: 20,
      expiryMonths: 12,
    },
  });

  await prisma.reward.createMany({
    data: [
      { tenantId, name: '₹250 off', pointsCost: 500, rewardType: 'DISCOUNT', value: 250 },
      { tenantId, name: 'Free Hair Spa', pointsCost: 1000, rewardType: 'FREE_SERVICE', value: 1200, serviceId: spaService.id },
    ],
  });

  // ---------------------------------------------------------- messaging ----
  await prisma.messageTemplate.createMany({
    data: DEFAULT_TEMPLATES.map((t) => ({ tenantId, ...t })),
  });

  for (const journey of DEFAULT_JOURNEYS) {
    await prisma.journey.create({
      data: {
        tenantId,
        name: journey.name,
        description: journey.description,
        trigger: journey.trigger,
        triggerConfig: journey.triggerConfig as Prisma.InputJsonValue,
        isActive: journey.isActive,
        steps: {
          create: await Promise.all(
            journey.steps.map(async (step, index) => {
              const template = step.templateName
                ? await prisma.messageTemplate.findFirst({ where: { tenantId, name: step.templateName } })
                : null;
              return {
                tenantId,
                sortOrder: index,
                actionType: step.actionType,
                delayMinutes: step.delayMinutes,
                channel: step.channel ?? null,
                templateId: template?.id ?? null,
                config: (step.config ?? {}) as Prisma.InputJsonValue,
              };
            }),
          ),
        },
      },
    });
  }

  await prisma.segment.createMany({
    data: [
      {
        tenantId,
        name: 'Lapsed 45+ days',
        description: 'Customers with 2+ visits who have not been in for 45 days',
        rules: { match: 'all', conditions: [{ field: 'noVisitDays', op: 'gte', value: 45 }, { field: 'totalVisits', op: 'gte', value: 2 }] } as Prisma.InputJsonValue,
      },
      {
        tenantId,
        name: 'High value customers',
        description: 'Lifetime spend over ₹25,000',
        rules: { match: 'all', conditions: [{ field: 'totalSpent', op: 'gte', value: 25000 }] } as Prisma.InputJsonValue,
      },
      {
        tenantId,
        name: 'Members expiring in 30 days',
        rules: { match: 'all', conditions: [{ field: 'membershipExpiringInDays', op: 'lte', value: 30 }] } as Prisma.InputJsonValue,
      },
    ],
  });

  // ---------------------------------------------------------- expenses -----
  const expenseCategories = [
    { name: 'Rent', isFixed: true },
    { name: 'Salaries', isFixed: true },
    { name: 'Electricity & Water', isFixed: false },
    { name: 'Product Purchase', isFixed: false },
    { name: 'Marketing', isFixed: false },
    { name: 'Maintenance', isFixed: false },
  ];

  const expenseCategoryIds: Record<string, string> = {};
  for (const category of expenseCategories) {
    const record = await prisma.expenseCategory.create({ data: { tenantId, ...category } });
    expenseCategoryIds[category.name] = record.id;
  }

  for (let month = 0; month < 3; month += 1) {
    const date = new Date();
    date.setMonth(date.getMonth() - month, 5);
    await prisma.expense.createMany({
      data: [
        { tenantId, branchId: hazratganj.id, categoryId: expenseCategoryIds.Rent!, expenseDate: date, amount: 90000, paymentMode: 'BANK_TRANSFER' },
        { tenantId, branchId: hazratganj.id, categoryId: expenseCategoryIds['Electricity & Water']!, expenseDate: date, amount: 18500, paymentMode: 'UPI' },
        { tenantId, branchId: hazratganj.id, categoryId: expenseCategoryIds.Marketing!, expenseDate: date, amount: 30000, paymentMode: 'UPI', vendor: 'Instagram Ads' },
        { tenantId, branchId: hazratganj.id, categoryId: expenseCategoryIds.Maintenance!, expenseDate: date, amount: 7500, paymentMode: 'CASH' },
      ],
    });
  }

  // ---------------------------------------------------------- customers ----
  const firstNames = ['Priya', 'Anjali', 'Neha', 'Rahul', 'Sneha', 'Kritika', 'Aditya', 'Shruti', 'Mohit', 'Divya', 'Rohit', 'Isha', 'Sanya', 'Karan', 'Tanya', 'Nikhil', 'Payal', 'Sahil', 'Megha', 'Varun'];
  const lastNames = ['Sharma', 'Verma', 'Singh', 'Gupta', 'Agarwal', 'Mishra', 'Yadav', 'Srivastava'];

  const customers = [];
  for (let i = 0; i < 40; i += 1) {
    const firstName = pick(firstNames, i);
    const lastName = pick(lastNames, i * 3);
    const created = daysAgo(300 - i * 5);

    const customer = await prisma.customer.create({
      data: {
        tenantId,
        branchId: i % 4 === 0 ? gomtiNagar.id : hazratganj.id,
        code: `C${String(i + 1).padStart(5, '0')}`,
        firstName,
        lastName,
        phone: `9${String(700000000 + i * 137)}`.slice(0, 10),
        email: i % 3 === 0 ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com` : null,
        gender: ['Rahul', 'Aditya', 'Mohit', 'Rohit', 'Karan', 'Nikhil', 'Sahil', 'Varun'].includes(firstName) ? 'MALE' : 'FEMALE',
        dob: new Date(Date.UTC(1990 + (i % 15), i % 12, ((i * 3) % 27) + 1)),
        source: pick(['WALK_IN', 'INSTAGRAM', 'REFERRAL', 'GOOGLE', 'WHATSAPP', 'WEBSITE'] as const, i),
        whatsappConsent: i % 5 === 0 ? 'UNKNOWN' : 'OPTED_IN',
        consentUpdatedAt: created,
        createdAt: created,
        tags: i % 7 === 0 ? ['bridal-enquiry'] : [],
      },
    });
    customers.push(customer);
  }

  // A few sold packages and memberships.
  for (let i = 0; i < 5; i += 1) {
    const customer = customers[i]!;
    const purchase = await prisma.packagePurchase.create({
      data: {
        tenantId,
        branchId: hazratganj.id,
        customerId: customer.id,
        templateId: hairPackage.id,
        price: 5000,
        purchasedAt: daysAgo(30 + i),
        expiresAt: daysAhead(60 - i * 5),
        items: {
          create: [
            { tenantId, serviceId: services.find((s) => s.name === 'Haircut (Women)')!.id, totalQty: 5, usedQty: i % 4 },
            { tenantId, serviceId: spaService.id, totalQty: 2, usedQty: i % 2 },
            { tenantId, serviceId: colourService.id, totalQty: 1, usedQty: 0 },
          ],
        },
      },
    });
    void purchase;
  }

  for (let i = 5; i < 10; i += 1) {
    const customer = customers[i]!;
    await prisma.membershipSubscription.create({
      data: {
        tenantId,
        branchId: hazratganj.id,
        customerId: customer.id,
        planId: goldPlan.id,
        price: 9999,
        startAt: daysAgo(340 + i),
        endAt: daysAhead(i === 5 ? 5 : 25 - i),
        benefitUsage: {
          create: [{ tenantId, serviceId: services.find((s) => s.name === 'Haircut (Women)')!.id, totalQty: 5, usedQty: i % 3 }],
        },
      },
    });
  }

  // -------------------------------------------- appointments & invoices ----
  let invoiceCounter = 0;
  const financialYear = (() => {
    const now = new Date();
    const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
  })();

  for (let day = 90; day >= 0; day -= 1) {
    const date = daysAgo(day);
    const appointmentsToday = 3 + (day % 4);

    for (let n = 0; n < appointmentsToday; n += 1) {
      const customer = pick(customers, day * 3 + n);
      const member = pick(staff.slice(0, 4), day + n);
      const service = pick(services, day * 2 + n);
      const startAt = at(date, 10 + ((day + n) % 8), (n % 2) * 30);
      const endAt = new Date(startAt.getTime() + service.durationMin * 60_000);
      const isFuture = day === 0 && n > 1;

      const appointment = await prisma.appointment.create({
        data: {
          tenantId,
          branchId: hazratganj.id,
          customerId: customer.id,
          startAt,
          endAt,
          status: isFuture ? 'CONFIRMED' : day % 17 === 0 && n === 0 ? 'NO_SHOW' : 'COMPLETED',
          source: pick(['RECEPTION', 'WALK_IN', 'PHONE', 'ONLINE', 'WHATSAPP'] as const, n + day),
          totalDurationMin: service.durationMin,
          estimatedAmount: service.price,
          completedAt: isFuture ? null : endAt,
          createdAt: startAt,
          services: {
            create: [
              {
                tenantId,
                branchId: hazratganj.id,
                serviceId: service.id,
                staffId: member.id,
                startAt,
                endAt,
                durationMin: service.durationMin,
                price: service.price,
                status: isFuture ? 'PENDING' : 'COMPLETED',
              },
            ],
          },
        },
      });

      if (isFuture || (day % 17 === 0 && n === 0)) continue;

      // Bill it: inclusive GST, single service line.
      invoiceCounter += 1;
      const gross = Number(service.price);
      const taxable = Math.round((gross * 100) / 118);
      const tax = gross - taxable;
      const cgst = Math.round((tax / 2) * 100) / 100;
      const sgst = Math.round((tax - cgst) * 100) / 100;

      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          branchId: hazratganj.id,
          invoiceNumber: `HZG/${financialYear}/${String(invoiceCounter).padStart(5, '0')}`,
          customerId: customer.id,
          appointmentId: appointment.id,
          invoiceDate: endAt,
          isGst: true,
          placeOfSupply: '09',
          grossAmount: gross,
          taxableAmount: taxable,
          cgstAmount: cgst,
          sgstAmount: sgst,
          totalTax: tax,
          grandTotal: gross,
          paidAmount: gross,
          dueAmount: 0,
          status: 'PAID',
          createdAt: endAt,
          items: {
            create: [
              {
                tenantId,
                branchId: hazratganj.id,
                itemType: 'SERVICE',
                refId: service.id,
                name: service.name,
                hsnSac: '999721',
                staffId: member.id,
                quantity: 1,
                unitPrice: service.price,
                taxableValue: taxable,
                taxRatePct: 18,
                cgstAmount: cgst,
                sgstAmount: sgst,
                lineTotal: gross,
              },
            ],
          },
          payments: {
            create: [
              {
                tenantId,
                branchId: hazratganj.id,
                customerId: customer.id,
                mode: pick(['UPI', 'CASH', 'CARD'] as const, day + n),
                amount: gross,
                receivedAt: endAt,
              },
            ],
          },
        },
      });

      await prisma.commissionEntry.create({
        data: {
          tenantId,
          branchId: hazratganj.id,
          staffId: member.id,
          invoiceId: invoice.id,
          baseAmount: gross,
          ratePct: Number(service.commissionRate),
          amount: Math.round(gross * (Number(service.commissionRate) / 100) * 100) / 100,
          earnedOn: endAt,
        },
      });

      const points = Math.floor(gross / 100);
      await prisma.loyaltyTransaction.create({
        data: {
          tenantId,
          customerId: customer.id,
          type: 'EARN',
          points,
          balanceAfter: points,
          reason: 'Earned on invoice',
          invoiceId: invoice.id,
          createdAt: endAt,
        },
      });

      if (day % 6 === 0) {
        await prisma.feedback.create({
          data: {
            tenantId,
            branchId: hazratganj.id,
            appointmentId: appointment.id,
            customerId: customer.id,
            staffId: member.id,
            rating: day % 30 === 0 ? 3 : 5,
            npsScore: day % 30 === 0 ? 6 : 10,
            comment: day % 30 === 0 ? 'Had to wait 20 minutes past my slot.' : 'Loved the finish!',
            isComplaint: day % 30 === 0,
            createdAt: endAt,
          },
        });
      }
    }
  }

  await prisma.branch.update({ where: { id: hazratganj.id }, data: { invoiceCounter } });

  // Refresh customer rollups from the invoices just created.
  for (const customer of customers) {
    const agg = await prisma.invoice.aggregate({
      where: { customerId: customer.id, status: { not: 'VOID' } },
      _sum: { grandTotal: true },
      _count: { _all: true },
    });
    const first = await prisma.invoice.findFirst({ where: { customerId: customer.id }, orderBy: { invoiceDate: 'asc' } });
    const last = await prisma.invoice.findFirst({ where: { customerId: customer.id }, orderBy: { invoiceDate: 'desc' } });
    const loyaltyAgg = await prisma.loyaltyTransaction.aggregate({
      where: { customerId: customer.id },
      _sum: { points: true },
    });

    const visits = agg._count._all;
    const spent = Number(agg._sum.grandTotal ?? 0);

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        totalVisits: visits,
        totalSpent: spent,
        avgBill: visits ? Math.round((spent / visits) * 100) / 100 : 0,
        firstVisitAt: first?.invoiceDate ?? null,
        lastVisitAt: last?.invoiceDate ?? null,
        loyaltyPoints: loyaltyAgg._sum.points ?? 0,
        tier: spent >= 50000 ? 'VIP' : spent >= 25000 ? 'GOLD' : spent >= 10000 ? 'SILVER' : 'BRONZE',
      },
    });
  }

  // ---------------------------------------------------------------- leads --
  const leadSources = ['INSTAGRAM', 'WHATSAPP', 'GOOGLE', 'WEBSITE', 'REFERRAL', 'FACEBOOK'] as const;
  for (let i = 0; i < 25; i += 1) {
    await prisma.lead.create({
      data: {
        tenantId,
        branchId: hazratganj.id,
        name: `${pick(firstNames, i + 5)} ${pick(lastNames, i)}`,
        phone: `9${String(600000000 + i * 271)}`.slice(0, 10),
        source: pick(leadSources, i),
        status: pick(['NEW', 'CONTACTED', 'INTERESTED', 'APPOINTMENT_BOOKED', 'LOST'] as const, i),
        notes: i % 3 === 0 ? 'Asked about bridal packages' : null,
        followUpAt: i % 4 === 0 ? daysAhead(1) : null,
        createdAt: daysAgo(60 - i * 2),
      },
    });
  }

  // ------------------------------------------------------------ challenge --
  await prisma.challenge.create({
    data: {
      tenantId,
      name: '5-Visit Beauty Challenge',
      description: 'Visit 5 times in 90 days and earn 500 bonus points',
      type: 'VISIT_COUNT',
      targetValue: 5,
      durationDays: 90,
      rewardPoints: 500,
      startAt: daysAgo(10),
      endAt: daysAhead(80),
    },
  });

  console.log(`
Seed complete.

  Tenant       : ${tenant.name} (slug: ${tenant.slug})
  Branches     : ${hazratganj.name}, ${gomtiNagar.name}
  Services     : ${services.length}
  Staff        : ${staff.length}
  Customers    : ${customers.length}
  Invoices     : ${invoiceCounter}

  Owner login       : owner@parlon.in / ${PASSWORD}
  Manager login     : manager@parlon.in / ${PASSWORD}
  Receptionist      : reception@parlon.in / ${PASSWORD}
  Accountant        : accounts@parlon.in / ${PASSWORD}
  Platform admin    : ${process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@parlon.in'} / ${process.env.PLATFORM_ADMIN_PASSWORD ?? 'Admin@12345'}

  Public booking    : GET /api/v1/public/${tenant.slug}
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());

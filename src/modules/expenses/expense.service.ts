import type { PaymentMode, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { currentUserId, requireTenantId } from '../../core/context';
import { branchFilter, requireBranchId } from '../../core/scope';
import { Conflict, NotFound } from '../../core/errors';
import { pageParams } from '../../core/http';
import { add, d } from '../../core/money';
import { dateOnly } from '../../core/dates';

export async function listCategories() {
  const tenantId = requireTenantId();
  return prisma.expenseCategory.findMany({
    where: { tenantId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { expenses: true } } },
  });
}

export async function createCategory(input: { name: string; isFixed?: boolean }) {
  const tenantId = requireTenantId();
  const clash = await prisma.expenseCategory.findFirst({ where: { tenantId, name: input.name } });
  if (clash) throw Conflict('An expense category with this name already exists');
  return prisma.expenseCategory.create({ data: { tenantId, ...input } });
}

export async function updateCategory(id: string, input: { name?: string; isFixed?: boolean; isActive?: boolean }) {
  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) throw NotFound('Expense category');
  return prisma.expenseCategory.update({ where: { id }, data: input });
}

export interface ExpenseInput {
  branchId?: string;
  categoryId: string;
  expenseDate: Date;
  amount: number;
  paymentMode?: PaymentMode;
  vendor?: string;
  reference?: string;
  notes?: string;
  isRecurring?: boolean;
  attachmentUrl?: string;
}

export async function createExpense(input: ExpenseInput) {
  const tenantId = requireTenantId();
  const branchId = requireBranchId(input.branchId);

  const category = await prisma.expenseCategory.findUnique({ where: { id: input.categoryId } });
  if (!category) throw NotFound('Expense category');

  return prisma.expense.create({
    data: {
      tenantId,
      branchId,
      categoryId: input.categoryId,
      expenseDate: dateOnly(input.expenseDate),
      amount: input.amount,
      paymentMode: input.paymentMode ?? 'CASH',
      vendor: input.vendor ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      isRecurring: input.isRecurring ?? false,
      attachmentUrl: input.attachmentUrl ?? null,
      createdById: currentUserId(),
    },
    include: { category: { select: { id: true, name: true } } },
  });
}

export async function updateExpense(id: string, input: Partial<ExpenseInput>) {
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense) throw NotFound('Expense');

  return prisma.expense.update({
    where: { id },
    data: {
      ...(input.categoryId ? { categoryId: input.categoryId } : {}),
      ...(input.expenseDate ? { expenseDate: dateOnly(input.expenseDate) } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.paymentMode ? { paymentMode: input.paymentMode } : {}),
      ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.attachmentUrl !== undefined ? { attachmentUrl: input.attachmentUrl } : {}),
    },
    include: { category: { select: { id: true, name: true } } },
  });
}

export async function deleteExpense(id: string) {
  const expense = await prisma.expense.findUnique({ where: { id } });
  if (!expense) throw NotFound('Expense');
  return prisma.expense.delete({ where: { id } });
}

export async function listExpenses(input: {
  page?: number;
  pageSize?: number;
  branchId?: string;
  categoryId?: string;
  from?: Date;
  to?: Date;
  q?: string;
}) {
  const tenantId = requireTenantId();
  const { skip, take, page, pageSize } = pageParams(input);

  const where: Prisma.ExpenseWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.from || input.to
      ? {
          expenseDate: {
            ...(input.from ? { gte: dateOnly(input.from) } : {}),
            ...(input.to ? { lte: dateOnly(input.to) } : {}),
          },
        }
      : {}),
    ...(input.q ? { OR: [{ vendor: { contains: input.q, mode: 'insensitive' as const } }, { notes: { contains: input.q, mode: 'insensitive' as const } }] } : {}),
  };

  const [items, total, agg] = await Promise.all([
    prisma.expense.findMany({
      where,
      skip,
      take,
      orderBy: { expenseDate: 'desc' },
      include: { category: { select: { id: true, name: true, isFixed: true } }, branch: { select: { id: true, name: true } } },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);

  return { items, total, page, pageSize, totalAmount: agg._sum.amount ?? 0 };
}

/** Expense breakdown by category for a period — feeds the P&L. */
export async function expenseSummary(input: { from: Date; to: Date; branchId?: string }) {
  const tenantId = requireTenantId();

  const where: Prisma.ExpenseWhereInput = {
    tenantId,
    ...branchFilter(input.branchId),
    expenseDate: { gte: dateOnly(input.from), lte: dateOnly(input.to) },
  };

  const [grouped, categories] = await Promise.all([
    prisma.expense.groupBy({ by: ['categoryId'], where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.expenseCategory.findMany({ where: { tenantId }, select: { id: true, name: true, isFixed: true } }),
  ]);

  const byId = new Map(categories.map((c) => [c.id, c]));
  const rows = grouped.map((g) => ({
    categoryId: g.categoryId,
    name: byId.get(g.categoryId)?.name ?? 'Uncategorised',
    isFixed: byId.get(g.categoryId)?.isFixed ?? false,
    amount: g._sum.amount ?? 0,
    count: g._count._all,
  }));

  const total = rows.reduce((acc, r) => add(acc, r.amount), d(0));

  return {
    period: { from: input.from, to: input.to },
    total,
    fixed: rows.filter((r) => r.isFixed).reduce((acc, r) => add(acc, r.amount), d(0)),
    variable: rows.filter((r) => !r.isFixed).reduce((acc, r) => add(acc, r.amount), d(0)),
    byCategory: rows.sort((a, b) => Number(b.amount) - Number(a.amount)),
  };
}

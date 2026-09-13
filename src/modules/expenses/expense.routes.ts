import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paginated } from '../../core/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { PERMISSIONS } from '../../core/permissions';
import { audit } from '../../middleware/audit';
import { idParam, idSchema, moneySchema, paginationQuery } from '../../core/validators';
import * as service from './expense.service';
import type { ExpenseInput } from './expense.service';
import { paymentModeSchema } from '../billing/billing.schema';

const router = Router();
router.use(authenticate);

const expenseBody = z.object({
  branchId: idSchema.optional(),
  categoryId: idSchema,
  expenseDate: z.coerce.date(),
  amount: moneySchema,
  paymentMode: paymentModeSchema.default('CASH'),
  vendor: z.string().trim().max(120).optional(),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  isRecurring: z.boolean().default(false),
  attachmentUrl: z.string().url().max(600).optional(),
});

router.get(
  '/categories',
  requirePermission(PERMISSIONS.EXPENSE_VIEW),
  asyncHandler(async (_req, res) => ok(res, await service.listCategories())),
);

router.post(
  '/categories',
  requirePermission(PERMISSIONS.EXPENSE_MANAGE),
  validate({ body: z.object({ name: z.string().trim().min(1).max(80), isFixed: z.boolean().default(false) }) }),
  asyncHandler(async (req, res) => created(res, await service.createCategory(req.body as never))),
);

router.patch(
  '/categories/:id',
  requirePermission(PERMISSIONS.EXPENSE_MANAGE),
  validate({
    params: idParam,
    body: z.object({ name: z.string().trim().max(80).optional(), isFixed: z.boolean().optional(), isActive: z.boolean().optional() }),
  }),
  asyncHandler(async (req, res) => ok(res, await service.updateCategory(req.params.id!, req.body as never))),
);

router.get(
  '/summary',
  requirePermission(PERMISSIONS.EXPENSE_VIEW),
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: idSchema.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await service.expenseSummary(req.query as never))),
);

router.get(
  '/',
  requirePermission(PERMISSIONS.EXPENSE_VIEW),
  validate({
    query: paginationQuery.extend({
      branchId: idSchema.optional(),
      categoryId: idSchema.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      q: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await service.listExpenses(req.query as never);
    return paginated(res, result.items, result.total, result.page, result.pageSize);
  }),
);

router.post(
  '/',
  requirePermission(PERMISSIONS.EXPENSE_MANAGE),
  validate({ body: expenseBody }),
  asyncHandler(async (req, res) => {
    const expense = await service.createExpense(req.body as ExpenseInput);
    audit({ action: 'expense.created', entity: 'Expense', entityId: expense.id, after: expense });
    return created(res, expense);
  }),
);

router.patch(
  '/:id',
  requirePermission(PERMISSIONS.EXPENSE_MANAGE),
  validate({ params: idParam, body: expenseBody.partial() }),
  asyncHandler(async (req, res) => ok(res, await service.updateExpense(req.params.id!, req.body as Partial<ExpenseInput>))),
);

router.delete(
  '/:id',
  requirePermission(PERMISSIONS.EXPENSE_MANAGE),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteExpense(req.params.id!);
    audit({ action: 'expense.deleted', entity: 'Expense', entityId: req.params.id! });
    return noContent(res);
  }),
);

export default router;

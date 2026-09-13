import type { PrismaClient } from '@prisma/client';

/**
 * Remove a tenant and everything under it.
 *
 * Most of the schema cascades from `Tenant`, so this could in principle be a
 * single `tenant.delete()`. It cannot, because a handful of relations are
 * deliberately `onDelete: Restrict` — you must not be able to delete a service,
 * product, supplier, package template, membership plan or expense category that
 * history still points at. Those rules are right, and they are exactly what
 * fires when a cascade reaches a `Service` row while its appointment lines are
 * still there: Postgres does not promise to delete the children first.
 *
 * So the restricted children are cleared explicitly, innermost first, and the
 * cascade handles the rest. The list below is derived from every
 * `onDelete: Restrict` in schema.prisma — if you add another one, add it here
 * too, or tenant deletion will start failing with P2003.
 *
 * Everything runs in one transaction: a half-deleted salon is worse than one
 * that is still there.
 */
export async function deleteTenantCompletely(
  client: PrismaClient,
  tenantId: string,
): Promise<void> {
  await client.$transaction(async (tx) => {
    // Blocks Service.
    await tx.appointmentService.deleteMany({ where: { tenantId } });
    await tx.packagePurchaseItem.deleteMany({ where: { tenantId } });

    // Blocks PackageTemplate.
    await tx.packagePurchase.deleteMany({ where: { tenantId } });

    // Blocks MembershipPlan.
    await tx.membershipSubscription.deleteMany({ where: { tenantId } });

    // Blocks Product, then Supplier — order matters between these two.
    await tx.purchaseOrderItem.deleteMany({ where: { tenantId } });
    await tx.purchaseOrder.deleteMany({ where: { tenantId } });

    // Blocks ExpenseCategory.
    await tx.expense.deleteMany({ where: { tenantId } });

    await tx.tenant.delete({ where: { id: tenantId } });
  });
}

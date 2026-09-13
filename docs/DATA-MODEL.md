# Salon OS — data model notes

76 models in `prisma/schema.prisma`. This file explains the decisions behind the
shape rather than repeating the schema.

## Tenancy

Every tenant-owned table carries a **required** `tenantId`. That is not
decoration: the Prisma extension in `src/core/prisma.ts` reads the DMMF at boot,
collects every model with a required `tenantId`, and injects the filter into all
top-level reads and writes.

Three tables deliberately have an **optional** `tenantId` and are therefore not
auto-filtered, because they are used before or across tenant context:

| Table | Why |
| --- | --- |
| `jobs` | Sweeps run for all tenants; per-tenant jobs still carry the id |
| `refresh_tokens` | Issued before the tenant is known, and also to platform admins |
| `password_reset_tokens` | Same |

`platform_users`, `plans` and `webhook_events` have no `tenantId` at all —
they belong to the platform, not to a salon.

## Money

Every monetary column is `Decimal(12,2)` (14,2 for lifetime totals) and every
calculation goes through `src/core/money.ts`, which wraps `Prisma.Decimal`.
Floats are never used for money. Quantities that can be fractional (50 ml of
colour) are `Decimal(12,3)`.

## Invoices

`invoices` stores both the arithmetic and the audit trail:

- `grossAmount` → `itemDiscount` → `billDiscount` → `taxableAmount` → tax
  columns → `roundOff` → `grandTotal` → `paidAmount` / `dueAmount`.
- CGST/SGST **and** IGST columns exist; `isInterState` decides which is filled.
- `invoice_items.redeemedFrom` records whether a line was paid for in cash, drawn
  from a package, or given free under a membership — which is what keeps
  "revenue" and "sessions consumed" from being confused with each other.
- Voiding never deletes: `status = VOID` plus reversal rows in the stock ledger,
  loyalty ledger and customer rollups.

Invoice numbers come from a per-branch counter and include the Indian financial
year: `HZG/26-27/00042`.

## Denormalised rollups

`customers` carries `totalVisits`, `totalSpent`, `avgBill`, `lastVisitAt`,
`loyaltyPoints`, `walletBalance`, `outstanding`, `currentStreak`. These are
maintained incrementally by billing (inside the invoice transaction) because the
dashboard, segments and alerts all read them constantly. `recalculateCustomerRollups()`
rebuilds them from invoices if they ever drift.

## Stock

`stocks` holds the current balance per branch/product; `stock_movements` is the
append-only ledger with a signed `quantity` and `balanceAfter`. Every change goes
through `recordMovement()` so the two can never disagree. Service consumption is
driven by `service_consumption` (the recipe: 50 ml of shade 5.0 per colour
service), which is what makes "opening + purchases − consumption − wastage =
closing" reconcile.

## Messaging and consent

`message_logs` is the single record of everything sent, with provider ids,
delivery timestamps and — importantly — `attributedInvoiceId` /
`attributedRevenue`, which is how a campaign reports revenue rather than clicks.

`customers` holds per-channel consent (`whatsappConsent`, `smsConsent`,
`emailConsent`) with a timestamp. `message_templates.category` distinguishes
UTILITY from MARKETING, and the dispatcher applies the rule in one place:
marketing needs an opt-in, utility only needs the absence of an opt-out.

## Journeys

`journeys` (trigger + audience) → `journey_steps` (ordered actions with delays)
→ `journey_runs` (one per customer per trigger, with `nextRunAt`). The worker
advances runs; `EXIT_IF_BOOKED` is what stops a win-back sequence the moment the
customer books.

## Indexes worth knowing

- `customers(tenantId, phone)` unique — phone is the identity of a salon customer.
- `appointments(tenantId, branchId, startAt)` — the calendar query.
- `appointment_services(tenantId, staffId, startAt)` — the conflict check.
- `invoices(tenantId, branchId, invoiceDate)` — every revenue report.
- `jobs(status, runAt)` — the worker's claim query.

## Enum choices

`AppointmentStatus` is a state machine, enforced in code by `ALLOWED_TRANSITIONS`
(`appointment.service.ts`) rather than only by the database, so an invalid move
returns a 409 with a readable message instead of a constraint error.

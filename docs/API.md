# Salon OS — API reference

Base path: `/api/v1`. All routes require `Authorization: Bearer <accessToken>` unless marked *(no auth)*.
Select a branch with `X-Branch-Id: <branchId>` (or `?branchId=`).

Permission names come from `src/core/permissions.ts`; a role holds a set of them and
individual users can be granted or denied single permissions on top of their role.

```
{ "success": true,  "data": …, "meta": { page, pageSize, total, totalPages, hasMore } }
{ "success": false, "error": { code, message, details }, "requestId": "…" }
```

**259 endpoints across 27 groups.**

## Authentication — `/auth`

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/auth/login` | — |
| POST | `/auth/refresh` | — |
| POST | `/auth/logout` | — |
| POST | `/auth/logout-all` | — |
| GET | `/auth/me` | — |
| POST | `/auth/change-password` | — |
| POST | `/auth/forgot-password` | — |
| POST | `/auth/reset-password` | — |
| POST | `/auth/platform/login` | — |

## Platform operator (cross-tenant) — `/platform`

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/platform/tenants` | platform token |
| GET | `/platform/tenants` | platform token |
| GET | `/platform/tenants/:id` | platform token |
| PATCH | `/platform/tenants/:id` | platform token |
| PATCH | `/platform/tenants/:id/status` | platform token |
| POST | `/platform/tenants/:id/plan` | platform token |
| GET | `/platform/stats` | platform token |
| GET | `/platform/plans` | platform token |
| POST | `/platform/plans` | platform token |
| PATCH | `/platform/plans/:id` | platform token |
| GET | `/platform/packs` | platform token |
| POST | `/platform/packs` | platform token |
| PATCH | `/platform/packs/:id` | platform token |
| GET | `/platform/tenants/:id/usage` | platform token |
| POST | `/platform/tenants/:id/credits` | platform token |
| POST | `/platform/tenants/:id/messaging/unblock` | platform token |
| GET | `/platform/messaging/blocked` | platform token |

## Messaging setup, library & automations — `/messaging`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/messaging/library` | `campaign.view` |
| POST | `/messaging/share/preview` | `message.send` |
| POST | `/messaging/library/:key/install` | `template.manage` |
| POST | `/messaging/library/occasions/:occasion/install` | `template.manage` |
| GET | `/messaging/automations` | `campaign.view` |
| PATCH | `/messaging/automations/:id` | `campaign.manage` |
| GET | `/messaging/setup` | `settings.manage` |
| PUT | `/messaging/setup` | `settings.manage` |
| POST | `/messaging/setup/test` | `settings.manage` |

## Activity trail — `/audit`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/audit` | `audit.view` |
| GET | `/audit/summary` | `audit.view` |
| GET | `/audit/facets` | `audit.view` |
| GET | `/audit/:entity/:entityId` | `audit.view` |
| GET | `/platform/tenants/:id/audit` | platform token |

## Usage & allowances — `/usage`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/usage` | authenticated |
| GET | `/usage/limits` | authenticated |
| GET | `/usage/plan` | authenticated |
| GET | `/usage/packs` | authenticated |
| GET | `/usage/credits` | `settings.manage` |

## Tenant settings — `/tenant`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/tenant` | authenticated |
| PATCH | `/tenant` | `tenant.manage` |
| GET | `/tenant/settings` | authenticated |
| PUT | `/tenant/settings` | `settings.manage` |

## Branches, chairs & holidays — `/branches`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/branches` | `branch.view` |
| POST | `/branches` | `branch.manage` |
| GET | `/branches/resources` | `branch.view` |
| POST | `/branches/resources` | `branch.manage` |
| PATCH | `/branches/resources/:id` | `branch.manage` |
| DELETE | `/branches/resources/:id` | `branch.manage` |
| GET | `/branches/holidays` | `branch.view` |
| POST | `/branches/holidays` | `branch.manage` |
| DELETE | `/branches/holidays/:id` | `branch.manage` |
| GET | `/branches/:id` | `branch.view` |
| PATCH | `/branches/:id` | `branch.manage` |
| DELETE | `/branches/:id` | `branch.manage` |

## Users & RBAC — `/users`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/users/roles` | `user.view` |
| GET | `/users` | `user.view` |
| POST | `/users` | `user.manage` |
| GET | `/users/:id` | `user.view` |
| PATCH | `/users/:id` | `user.manage` |
| DELETE | `/users/:id` | `user.manage` |
| POST | `/users/:id/reset-password` | `user.manage` |
| POST | `/users/:id/permissions` | `user.manage` |
| DELETE | `/users/:id/permissions/:permission` | `user.manage` |

## Customer CRM — `/customers`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/customers` | `customer.view` |
| POST | `/customers` | `customer.manage` |
| GET | `/customers/lookup` | `customer.view` |
| GET | `/customers/export` | `customer.export` |
| POST | `/customers/import` | `customer.import` |
| GET | `/customers/birthdays` | `customer.view` |
| GET | `/customers/inactive` | `customer.view` |
| POST | `/customers/merge` | `customer.manage` |
| GET | `/customers/:id` | `customer.view` |
| PATCH | `/customers/:id` | `customer.manage` |
| GET | `/customers/:id/history` | `customer.view` |
| GET | `/customers/:id/invoices` | `invoice.view` |
| GET | `/customers/:id/notes` | `customer.view` |
| POST | `/customers/:id/notes` | `customer.manage` |
| GET | `/customers/:id/photos` | `customer.view` |
| POST | `/customers/:id/photos` | `customer.manage` |
| PUT | `/customers/:id/hair-profile` | `customer.manage` |
| PUT | `/customers/:id/consent` | `customer.manage` |
| POST | `/customers/:id/recalculate` | `customer.manage` |

`GET /customers/lookup?q=` is the "have they been here before?" check behind the new-customer
form and the walk-in box. `q` is a phone number in any format (`98765 43210`, `+91-98765-43210`),
an email, or a name; four digits of a phone or three characters of anything else is enough. Up to
`limit` (default 6, max 10) compact rows come back, most recent visit first, each with
`exact: true` when the full phone number or email matched — the UI treats that as "this *is* them".

**Customer page sections.** `GET /customers/:id` carries a `sections` array naming which parts of
the profile this person may see, and the fields behind a hidden section come back `null` or empty
rather than merely un-rendered. See *Page layouts* below.

## Page layouts — `/layouts`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/layouts` | any signed-in user |
| GET | `/layouts/:page` | any signed-in user |
| PUT | `/layouts/:page` | `settings.manage` |

Sectioned pages — `customer` and `staff` — are shown according to two rules stacked: the viewer's
role permissions (what the API will serve at all) and the owner's layout (what the salon wants shown),
stored as `{ section: [roles] }` under `customerProfile.sections` / `staffProfile.sections`. The
layout can narrow what a permission allows, never widen it; the owner always sees everything; and a
person always sees their own staff page within what `staff.self` allows. Each section reports its
`roles`, `eligibleRoles` (roles whose permissions include the data at all) and whether it is `visible`
to the caller. `GET /staff/:id` carries `sections` and `isSelf`, and nulls `baseSalary` /
`commissionRate` when those sections are hidden.

## Service catalogue — `/services`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/services/categories` | `service.view` |
| POST | `/services/categories` | `service.manage` |
| PATCH | `/services/categories/:id` | `service.manage` |
| DELETE | `/services/categories/:id` | `service.manage` |
| GET | `/services/menu` | `service.view` |
| GET | `/services` | `service.view` |
| POST | `/services` | `service.manage` |
| GET | `/services/:id` | `service.view` |
| PATCH | `/services/:id` | `service.manage` |
| DELETE | `/services/:id` | `service.manage` |
| PUT | `/services/:id/consumption` | `service.manage` |

## Staff, attendance, commission & payroll — `/staff`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/staff` | `staff.view` or `staff.self` |
| POST | `/staff` | `staff.manage` |
| GET | `/staff/bookable` | `appointment.view` or `appointment.manage` or `staff.view` |
| GET | `/staff/leaderboard` | `report.view` |
| GET | `/staff/attendance` | `attendance.view` |
| POST | `/staff/attendance` | `attendance.manage` |
| GET | `/staff/attendance/summary` | `attendance.view` |
| POST | `/staff/attendance/punch` | authenticated |
| GET | `/staff/leave` | `attendance.view` |
| POST | `/staff/leave` | `attendance.manage` |
| PATCH | `/staff/leave/:id` | `attendance.manage` |
| GET | `/staff/commissions` | `commission.view` |
| GET | `/staff/commissions/summary` | `commission.view` |
| POST | `/staff/commissions/pay` | `commission.manage` |
| GET | `/staff/payroll` | `payroll.view` |
| POST | `/staff/payroll/generate` | `payroll.manage` |
| GET | `/staff/payroll/:id` | `payroll.view` |
| POST | `/staff/payroll/:id/approve` | `payroll.manage` |
| POST | `/staff/targets` | `staff.manage` |
| GET | `/staff/:id` | `staff.view` or `staff.self` or `staff.view` |
| PATCH | `/staff/:id` | `staff.manage` |
| DELETE | `/staff/:id` | `staff.manage` |
| PUT | `/staff/:id/services` | `staff.manage` |
| PUT | `/staff/:id/availability` | `staff.manage` |
| POST | `/staff/:id/time-off` | `staff.manage` |
| DELETE | `/staff/time-off/:id` | `staff.manage` |
| GET | `/staff/:id/attendance` | `attendance.view`, or `staff.self` for your own |
| GET | `/staff/:id/commissions` | `commission.view`, or `staff.self` for your own |
| GET | `/staff/:id/payslips` | `payroll.view`, or `staff.self` for your own |
| GET | `/staff/:id/leave` | `attendance.view`, or `staff.self` for your own |
| GET | `/staff/:id/performance` | `report.view` or `staff.self` or `report.view` |

## Appointments & calendar — `/appointments`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/appointments` | `appointment.view` |
| POST | `/appointments` | `appointment.manage` |
| GET | `/appointments/calendar` | `appointment.view` |
| GET | `/appointments/slots` | authenticated |
| GET | `/appointments/utilisation` | `report.view` |
| GET | `/appointments/today` | authenticated |
| POST | `/appointments/walk-in` | `appointment.manage` |
| POST | `/appointments/recurring` | `appointment.manage` |
| GET | `/appointments/waitlist` | authenticated |
| POST | `/appointments/waitlist` | `appointment.manage` |
| PATCH | `/appointments/waitlist/:id` | `appointment.manage` |
| GET | `/appointments/:id` | authenticated |
| PATCH | `/appointments/:id` | `appointment.manage` |
| POST | `/appointments/:id/reschedule` | `appointment.manage` |
| POST | `/appointments/:id/status` | `appointment.manage` |
| POST | `/appointments/:id/cancel` | `appointment.cancel` |

## Billing / POS — `/invoices`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/invoices` | `invoice.view` |
| GET | `/invoices/billing-defaults` | `invoice.create` — GST on by default? GSTIN present? prices inclusive? may this user choose per bill? |
| POST | `/invoices` | `invoice.create`, `invoice.discount` |
| GET | `/invoices/outstanding` | `invoice.view` |
| GET | `/invoices/collections` | `report.view` |
| GET | `/invoices/gst-report` | `report.financial` |
| GET | `/invoices/pos-context/:customerId` | `invoice.create` |
| POST | `/invoices/advance` | `payment.manage` |
| GET | `/invoices/:id` | `invoice.view` |
| POST | `/invoices/:id/payments` | `payment.manage` |
| POST | `/invoices/:id/refund` | `refund.manage` |
| DELETE | `/invoices/:id/payments/:paymentId` | `payment.manage` — take back a payment recorded by mistake; status follows the payments left |
| DELETE | `/invoices/:id` | `invoice.delete` — only a VOID or DRAFT bill with no payments; owner only until granted |
| POST | `/invoices/:id/void` | `invoice.void` |

## Coupons — `/coupons`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/coupons` | `invoice.view` |
| POST | `/coupons` | `coupon.manage` |
| PATCH | `/coupons/:id` | `coupon.manage` |
| GET | `/coupons/:id/performance` | `report.view` |

## Packages — `/packages`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/packages` | `package.view` |
| POST | `/packages` | `package.manage` |
| GET | `/packages/purchases` | `package.view` |
| POST | `/packages/purchases` | `package.manage` |
| GET | `/packages/customer/:customerId` | `package.view` |
| POST | `/packages/purchases/:id/cancel` | `package.manage` |
| GET | `/packages/:id` | `package.view` |
| PATCH | `/packages/:id` | `package.manage` |

## Memberships — `/memberships`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/memberships/plans` | `membership.view` |
| POST | `/memberships/plans` | `membership.manage` |
| GET | `/memberships/plans/:id` | `membership.view` |
| PATCH | `/memberships/plans/:id` | `membership.manage` |
| GET | `/memberships/subscriptions` | `membership.view` |
| POST | `/memberships/subscriptions` | `membership.manage` |
| GET | `/memberships/customer/:customerId` | `membership.view` |
| POST | `/memberships/subscriptions/:id/cancel` | `membership.manage` |

## Loyalty & rewards — `/loyalty`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/loyalty/program` | `loyalty.view` |
| PUT | `/loyalty/program` | `loyalty.manage` |
| GET | `/loyalty/rewards` | `loyalty.view` |
| POST | `/loyalty/rewards` | `loyalty.manage` |
| PATCH | `/loyalty/rewards/:id` | `loyalty.manage` |
| POST | `/loyalty/rewards/redeem` | `loyalty.view` |
| GET | `/loyalty/customers/:customerId/transactions` | `loyalty.view` |
| POST | `/loyalty/customers/:customerId/adjust` | `loyalty.manage` |

## Expenses — `/expenses`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/expenses/categories` | `expense.view` |
| POST | `/expenses/categories` | `expense.manage` |
| PATCH | `/expenses/categories/:id` | `expense.manage` |
| GET | `/expenses/summary` | `expense.view` |
| GET | `/expenses` | `expense.view` |
| POST | `/expenses` | `expense.manage` |
| PATCH | `/expenses/:id` | `expense.manage` |
| DELETE | `/expenses/:id` | `expense.manage` |

## Inventory & purchasing — `/inventory`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/inventory/brands` | `inventory.view` |
| POST | `/inventory/brands` | `inventory.manage` |
| GET | `/inventory/categories` | `inventory.view` |
| POST | `/inventory/categories` | `inventory.manage` |
| GET | `/inventory/suppliers` | `inventory.view` |
| POST | `/inventory/suppliers` | `supplier.manage` |
| PATCH | `/inventory/suppliers/:id` | `supplier.manage` |
| GET | `/inventory/stock` | `inventory.view` |
| GET | `/inventory/stock/low` | `inventory.view` |
| GET | `/inventory/stock/valuation` | `inventory.view` |
| GET | `/inventory/stock/expiring` | `inventory.view` |
| POST | `/inventory/stock/adjust` | `inventory.manage` |
| POST | `/inventory/stock/wastage` | `inventory.manage` |
| GET | `/inventory/movements` | `inventory.view` |
| GET | `/inventory/consumption-report` | `inventory.view` |
| GET | `/inventory/purchase-orders` | `inventory.view` |
| POST | `/inventory/purchase-orders` | `purchase.manage` |
| GET | `/inventory/purchase-orders/:id` | `inventory.view` |
| POST | `/inventory/purchase-orders/:id/receive` | `purchase.manage` |
| POST | `/inventory/purchase-orders/:id/cancel` | `purchase.manage` |
| GET | `/inventory/products` | `inventory.view` |
| POST | `/inventory/products` | `inventory.manage` |
| GET | `/inventory/products/:id` | `inventory.view` |
| PATCH | `/inventory/products/:id` | `inventory.manage` |

## Leads — `/leads`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/leads` | `lead.view` |
| POST | `/leads` | `lead.manage` |
| GET | `/leads/funnel` | `report.view` |
| POST | `/leads/import` | `lead.manage` |
| GET | `/leads/:id` | `lead.view` |
| PATCH | `/leads/:id` | `lead.manage` |
| POST | `/leads/:id/activities` | `lead.manage` |
| POST | `/leads/:id/convert` | `lead.manage` |
| POST | `/leads/:id/lost` | `lead.manage` |

## Segments — `/segments`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/segments` | `campaign.view` |
| POST | `/segments` | `segment.manage` |
| POST | `/segments/preview` | `campaign.view` |
| PATCH | `/segments/:id` | `segment.manage` |
| DELETE | `/segments/:id` | `segment.manage` |
| POST | `/segments/:id/snapshot` | `segment.manage` |

## Campaigns — `/campaigns`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/campaigns` | `campaign.view` |
| POST | `/campaigns` | `campaign.manage` |
| GET | `/campaigns/roi` | `report.view` |
| GET | `/campaigns/:id` | `campaign.view` |
| PATCH | `/campaigns/:id` | `campaign.manage` |
| POST | `/campaigns/:id/launch` | `campaign.manage`, `message.send` |
| POST | `/campaigns/:id/pause` | `campaign.manage` |
| GET | `/campaigns/:id/messages` | `campaign.view` |

## Automated journeys — `/journeys`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/journeys` | `campaign.view` |
| POST | `/journeys` | `journey.manage` |
| GET | `/journeys/:id` | `campaign.view` |
| PATCH | `/journeys/:id` | `journey.manage` |
| POST | `/journeys/:id/activate` | `journey.manage` |
| GET | `/journeys/:id/runs` | `campaign.view` |
| POST | `/journeys/runs/:id/cancel` | `journey.manage` |

## Message templates — `/templates`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/templates` | `campaign.view` |
| POST | `/templates` | `template.manage` |
| GET | `/templates/:id` | `campaign.view` |
| PATCH | `/templates/:id` | `template.manage` |
| DELETE | `/templates/:id` | `template.manage` |
| POST | `/templates/:id/preview` | `campaign.view` |

## Messages — `/messages`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/messages` | `campaign.view` |
| POST | `/messages/send` | `message.send` |

## Feedback & reputation — `/feedback`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/feedback` | `feedback.view` |
| POST | `/feedback` | `feedback.view` |
| GET | `/feedback/summary` | `feedback.view` |
| POST | `/feedback/:id/resolve` | `feedback.manage` |

## Challenges, streaks & referrals — `/engagement`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/engagement/challenges` | `loyalty.view` |
| POST | `/engagement/challenges` | `gamification.manage` |
| PATCH | `/engagement/challenges/:id` | `gamification.manage` |
| POST | `/engagement/challenges/:id/enroll` | `gamification.manage` |
| GET | `/engagement/customers/:customerId/challenges` | `loyalty.view` |
| POST | `/engagement/customers/:customerId/refresh` | `gamification.manage` |
| GET | `/engagement/referrals/leaderboard` | `loyalty.view` |
| GET | `/engagement/engagement` | `dashboard.view` |

## Analytics & business alerts — `/analytics`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/analytics/dashboard` | `dashboard.view` |
| GET | `/analytics/snapshot` | `dashboard.view` |
| GET | `/analytics/growth` | `report.view` |
| GET | `/analytics/revenue-trend` | `report.view` |
| GET | `/analytics/services` | `report.view` |
| GET | `/analytics/unit-economics` | `report.financial` |
| GET | `/analytics/branch-pnl` | `report.financial` |
| GET | `/analytics/retention` | `report.view` |
| GET | `/analytics/insights` | `dashboard.view` |
| GET | `/analytics/monthly-report` | `report.view` |
| GET | `/analytics/alerts` | `dashboard.view` |
| POST | `/analytics/alerts/generate` | `dashboard.view` |
| POST | `/analytics/alerts/:id/read` | `dashboard.view` |
| POST | `/analytics/alerts/:id/dismiss` | `dashboard.view` |

## Public booking & feedback (no auth) — `/public`

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/public/:slug` | — |
| GET | `/public/:slug/services` | — |
| GET | `/public/:slug/staff` | — |
| GET | `/public/:slug/slots` | — |
| POST | `/public/:slug/book` | — |
| GET | `/public/:slug/appointments/:appointmentId` | — |
| POST | `/public/:slug/appointments/:appointmentId/cancel` | — |
| GET | `/public/feedback/:appointmentId` | — |
| POST | `/public/feedback/:appointmentId` | — |

## Provider webhooks (no auth) — `/webhooks`

`POST /webhooks/email` takes Resend's `email.*` events: delivered, opened and clicked update the
message log and the campaign counters; bounced and complained mark the send failed and switch that
customer's email consent OFF, because a domain that keeps mailing dead addresses lands in junk for
every salon sharing it. Point Resend's webhook at it and subscribe to the `email.*` events.


| Method | Path | Permission |
| --- | --- | --- |
| GET | `/webhooks/whatsapp` | — |
| POST | `/webhooks/whatsapp` | — |

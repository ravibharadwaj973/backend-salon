# Salon Grow — Backend

A multi-tenant SaaS backend for salon chains. One codebase serves every salon
(tenant), each with its own branches, staff, customers and configuration.

```
Platform
├── Tenant: Glow Studio        ├── Branch: Hazratganj
│                              └── Branch: Gomti Nagar
├── Tenant: Salon B            └── Branch: Main
└── Tenant: Salon C            └── Branch: Main
```

Node 20+ · TypeScript (strict) · Express · Prisma · PostgreSQL

---

## Quick start

**1. PostgreSQL.** One container, dedicated to this app:

```bash
docker run --name salon-crm-postgres \
  -e POSTGRES_DB=salon_crm_db -e POSTGRES_USER=salon_app -e POSTGRES_PASSWORD=salon_password123 \
  -p 5432:5432 -v salon_postgres_data:/var/lib/postgresql/data -d postgres:16
```

It creates `salon_crm_db` on first start, so there is nothing to create by hand. After a
reboot, `docker start salon-crm-postgres` brings it back with its data intact — the data
lives in the `salon_postgres_data` volume, not in the container.

**2. The app.**

```bash
cp .env.example .env          # already points at localhost:5432/salon_crm_db
npm install
npx prisma migrate dev --name init
npm run seed                  # demo salon with 90 days of history
npm run dev                   # http://localhost:4000/api/v1
```

If `prisma migrate` cannot reach the database, check the container is actually up with
`docker ps` — a container that exited still shows in `docker ps -a`, which is easy to
misread as running.

---

## Logs: what you see when it runs

Starting the API should print a handful of lines, not a wall of JSON. Three knobs:

| Variable | Default | What it does |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug` adds per-job and internal detail. Noisy — use it when hunting something. |
| `HTTP_LOG` | `summary` | `summary` = one line per request. `off` = errors only. `full` = the complete request/response objects. |
| `SLOW_QUERY_MS` | `250` | Queries slower than this are logged as warnings. Nothing else about queries is logged. |

What was actually flooding the terminal, and what changed:

- **`.env.example` shipped `LOG_LEVEL=debug`.** Now `info`.
- **pino-http serialised the whole request and response on every call** — every header, every time. One page load cost a screen. In `summary` mode a request is now `GET /api/v1/appointments → 200`.
- **pid, hostname and the service name were on every line in development.** They matter on a fleet of containers, not on one laptop, so they're production-only now.
- Health probes (`/health`, `/ready`) and CORS preflights are ignored — every-few-seconds noise that says nothing.

Phone numbers (`toAddress`) are now redacted alongside passwords and tokens: a message payload in a log is still personal data.

---

## Messaging: who sends, what they send, and when

### Each salon sends as itself

WhatsApp credentials used to live in `.env`, which meant every salon's messages
would have gone out from *one* number — ours. A customer receiving "your
appointment is confirmed" from a business they have never heard of blocks the
sender, and one salon's complaint then poisons delivery for every other salon on
that number.

`TenantMessagingConfig` holds each salon's own WhatsApp Business Account, SMS
sender ID and email domain. `resolveProvider(channel, tenantId)` reads it, and
falls back to the environment only for the demo tenant and local development.
Anything unconfigured degrades to the console provider — **logged, not sent** —
because a journey that throws halfway leaves customers half-messaged.

Secrets are write-only over the API: saving returns only a status and the last
four characters, and an empty field means "keep what is stored" rather than
"erase it".

| Channel | Provider | Notes |
| --- | --- | --- |
| WhatsApp | Meta Cloud API | Templates need Meta's approval before sending |
| SMS | MSG91 | India needs DLT registration for the header *and* each template |
| Email | Resend | From-address must be on a domain the salon has verified |

The SMS provider counts segments before reporting cost: 160 characters on GSM-7,
but **70 once there is a single emoji or Devanagari character** — which is the
usual reason an SMS bill is three times what a salon expected.

### The template library

41 ready-written messages in `src/modules/messaging/library.ts`, grouped by
occasion: appointments, billing, reviews, win-back, birthdays, festivals
(Diwali, Holi, Eid, Karwa Chauth, New Year, plus a blank for regional ones),
offers, memberships, packages, loyalty, referrals, enquiries, OTP and
announcements.

Installing one **copies it into the salon's own templates** and it is theirs from
then on — renamed, rewritten, re-priced. Nothing is ever sent from the library
directly; a hundred salons sending the same words verbatim would make all of
them sound identical.

Two rules run through the list:

- **Category is not decoration.** An offer is always MARKETING even where UTILITY
  would be 7.5× cheaper. Mislabelling promotional messages is how a salon gets
  its number blocked.
- **No invented urgency.** These go to real neighbours of a small business.
  "Only 2 slots left" when there are twelve costs a salon a regular.

No festival dates are hardcoded — they move every year and vary by region. The
library groups them by occasion and the salon picks the send date.

### Automation timing belongs to the owner

`GET /messaging/automations` returns every journey with its trigger described in
an owner's words, and `PATCH` lets them change it: how many days of silence
counts as lapsed, how long before a membership expires to ask, how many hours
after a visit to request a review, and the delay between each step.

There is also a quiet-hours window. A reminder that arrives at 6am annoys the
customer and gets the salon's number blocked.

| Route | Permission |
| --- | --- |
| `GET /messaging/library` | `campaign.view` |
| `POST /messaging/library/:key/install` | `template.manage` |
| `POST /messaging/library/occasions/:occasion/install` | `template.manage` |
| `GET /messaging/automations` | `campaign.view` |
| `PATCH /messaging/automations/:id` | `campaign.manage` |
| `GET /messaging/setup` | `settings.manage` |
| `PUT /messaging/setup` | `settings.manage` |
| `POST /messaging/setup/test` | `settings.manage` |

### Migration

```bash
npx prisma migrate dev --name messaging_config_and_library
```

Adds `tenant_messaging_config` and a nullable `libraryKey` on `message_templates`.
No data changes.

---

## Activity trail

The `audit()` helper has always written to `audit_logs` from 59 places — bookings,
bills, voids, refunds, permission changes, imports. Until now nothing could read it.

| Route | Who |
| --- | --- |
| `GET /audit` | `audit.view` — filters by person, module, record, date, free text |
| `GET /audit/summary` | `audit.view` — counts for today and the last N days |
| `GET /audit/facets` | `audit.view` — the filter options, built from what this salon has actually done |
| `GET /audit/:entity/:entityId` | `audit.view` — one record's full history, oldest first |
| `GET /platform/tenants/:id/audit` | platform token — for answering "who deleted it" on a support call |

**`audit.view` is held only by OWNER and ADMIN.** That is the point: the trail records
who discounted a bill and who voided an invoice, so it must not be readable by the
people it is watching. The salon app's **Activity** page is gated on the same permission.

The summary counts voids, refunds, loyalty adjustments and permission changes
separately from everything else — those are where money leaves a salon quietly, and
burying them in a list of three hundred bookings is how they go unnoticed.

**Retention:** `audit.prune` runs Sundays at 02:00 and deletes rows older than a year.
An audit table grows forever and nobody notices until a backup takes an hour.

---

## Plans, allowances and add-ons

A 14-day pilot and three paid plans. Every limit here is enforced by the API, not
merely printed on a pricing page.

| | Pilot | Starter | Growth | Pro |
| --- | ---: | ---: | ---: | ---: |
| Per month | free, 14 days | ₹999 | ₹2,499 | ₹4,999 |
| Customers | 500 | 1,000 | 5,000 | Unlimited\* |
| Staff | 5 | 5 | 20 | 200 |
| Branches | 1 | 1 | 1 | 3, then ₹999 each |
| Campaigns / month | 3 | 3 | Unlimited | Unlimited |
| WhatsApp utility | 100 | 500 | 1,000 | 2,000 |
| WhatsApp marketing | 50 | — | 500 | 1,000 |
| SMS | 200 | 1,000 | 3,000 | 5,000 |
| Email | 500 | 1,000 | 3,000 | 5,000 |
| Segmentation | Basic | Basic | Advanced | Advanced |
| Automation | ✓ | Basic | ✓ | ✓ |
| Campaign analytics | ✓ | Basic | ✓ | Advanced |
| Multiple branches | — | — | — | ✓ |

\* "Unlimited" is `FAIR_USE_UNLIMITED` (1,000,000) in `src/core/features.ts` — a
ceiling that is shown as unlimited, not the absence of one. Say so in your terms;
an unbounded promise on shared infrastructure is one you cannot keep.

**The pilot is a real plan row, not a flag.** A salon is provisioned onto `PILOT`
and its allowances are metered exactly like any other plan's, so a two-week trial
cannot quietly send two thousand marketing messages at your expense.

It is also deliberately generous on *capability* and thin on *volume*: the pilot
salon gets campaigns, automation and analytics, and runs out of messages rather
than out of features. That way the upgrade conversation is about their own usage —
"you sent 100 reminders in nine days" — rather than about a feature they were
never allowed to try.

**Graded features.** Some things are not on/off but Basic → Advanced, so they are
two switches: `segments` and `segmentsAdvanced`, `automation` and
`automationAdvanced`, `campaignAnalytics` and `campaignAnalyticsAdvanced`. A test
asserts no tier ever loses a feature the tier below it has.

**Campaign caps reset on the 1st**, counted rather than stored — deleting a draft
frees the slot back up, because a salon on three a month should not lose one to a
mistake.

**WhatsApp is metered as two separate things.** Meta charges roughly ₹0.115 for a
utility template and ₹0.8631 for a marketing one — about 7.5× more. A single
"messages" allowance would let a salon spend a marketing budget out of its reminders
allowance, and the heaviest senders would cost the most to serve. `MeterKey` keeps
them apart, and `meterFor()` in `src/modules/quotas/quota.service.ts` is the only
place that decides which meter a send is charged to.

### Running out: overdraft, then a stop

**Spend order:** monthly allowance → purchased credits → *overdraft, but only to
finish* → refuse.

The overdraft is the subtle part. A campaign that is part-way through its
recipients may go below zero to finish, because half-sending is worse for the
salon's customers than either outcome. Only sends carrying a `campaignId` or
`journeyRunId` qualify — a manual send from the counter never overdraws.

**Crossing into overdraft stops everything new, immediately.** The running
campaign completes; the next one does not start, automations pause, and the
counter cannot send by hand. `Plan.overdraftLimit` (200 by default) bounds how
far this goes, so it can finish a run but never fund one.

**Only a platform operator can switch sending back on**, from the salon's page in
the console (`POST /platform/tenants/:id/messaging/unblock`). That is deliberate:
an automatic monthly reset would mean a salon that overdraws every month never
has a reason to pay. `GET /platform/messaging/blocked` lists everyone currently
stopped, so nobody sits blocked and unnoticed.

**A campaign is checked before it launches.** The audience is counted against
what is left, and a campaign that cannot fit is refused with the shortfall named —
the overdraft is deliberately *not* counted as available here, so a
5,000-recipient blast on a 500-message plan is stopped at the door rather than
half-delivered.

What keeps working while sending is paused: appointments, billing, customers,
reports — everything. Only outgoing messages stop.

Allowances reset on the 1st of each month in the salon's own timezone; credits
carry over until spent. A refused send is written to `MessageLog` as `SKIPPED`
with `QUOTA_EXCEEDED`, so it is visible rather than silently lost.

Metering happens inside `queueMessage()`, beside the consent gate — the one place
every send passes through, so no campaign, journey or cron job can bypass it. The
charge is applied *before* the message is queued: a queued message has already been
paid for. Both steps are single conditional `updateMany` statements, so two sends
racing for the last message in an allowance cannot both win.

### Add-on packs

| Pack | Messages | Price | Per message |
| --- | ---: | ---: | ---: |
| `WA_UTIL_1K` | 1,000 | ₹300 | ₹0.30 |
| `WA_UTIL_5K` | 5,000 | ₹1,250 | ₹0.25 |
| `WA_MKTG_500` | 500 | ₹500 | ₹1.00 |
| `WA_MKTG_2K` | 2,000 | ₹1,800 | ₹0.90 |
| `SMS_1K` | 1,000 | ₹300 | ₹0.30 |
| `SMS_5K` | 5,000 | ₹1,250 | ₹0.25 |

Top-ups are **not self-serve**, because there is no payment gateway anywhere in this
system. The salon pays by UPI or bank transfer; an operator records it in the console
(`POST /platform/tenants/:id/credits`), which writes a `CreditLedger` row with the
amount, mode and reference. Same discipline as the salon's own POS: money is recorded
by a human, never confirmed by the software.

### Features

`Plan.features` is a JSON map of the switches in `src/core/features.ts`. Starter has
none; Growth adds CRM, campaigns, journeys, segments, loyalty, packages and
memberships; Business adds inventory, expenses, commissions, multi-branch and unit
economics.

Features and permissions answer different questions and both are checked:
`requirePermission` asks whether *this user* may do it, `requireFeature` asks whether
*this salon* bought it. An owner has every permission and still cannot open campaigns
on Starter. Order matters in `routes.ts` — permission first, so a receptionist gets
403 rather than a 402 that would leak what the plan above includes.

### Migration

The `Plan.monthlyMessages` column is replaced by five per-meter columns, and four
tables are new (`credit_packs`, `message_usage`, `credit_balances`, `credit_ledger`).

```bash
npx prisma migrate dev --name plan_quotas_and_credits
npm run seed     # upserts the three plans and six packs, correcting drift
```

The seed now *updates* plans rather than skipping existing ones, so re-running it
brings a drifted plan back to the published numbers.

Seed logins (password `Salon@12345`):

| Role          | Email                      |
| ------------- | -------------------------- |
| Owner         | owner@glowstudio.in        |
| Manager       | manager@glowstudio.in      |
| Receptionist  | reception@glowstudio.in    |
| Accountant    | accounts@glowstudio.in     |
| Platform admin| admin@salongrow.in (`Admin@12345`) |

```bash
curl -X POST localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@glowstudio.in","password":"Salon@12345"}'
```

---

## How tenancy actually works

Three layers, in this order:

1. **Request context** (`src/core/context.ts`) — an `AsyncLocalStorage` store
   holding `tenantId`, `userId`, `role` and the branches the actor may touch. It
   is established once per request and read everywhere else.
2. **Automatic query filtering** (`src/core/prisma.ts`) — a Prisma extension
   injects `tenantId` into every top-level query for any model that has a
   required `tenantId` column. Forgetting a `where` clause cannot leak another
   salon's data. Nested writes still pass `tenantId` explicitly, which the
   generated types enforce at compile time.
3. **Branch scoping** (`src/core/scope.ts`) — a business rule, so it is applied
   deliberately by each service: `branchFilter()` for reads,
   `requireBranchId()` for writes, `assertBranchAccess()` for direct ids.

Background jobs use `runAsTenant(tenantId, fn)`; platform-operator routes use
`runUnscoped(fn)` to deliberately step outside tenant filtering.

Clients select a branch with the `X-Branch-Id` header (or `?branchId=`).

### Roles

`OWNER · ADMIN · REGIONAL_MANAGER · MANAGER · RECEPTIONIST · STYLIST · ACCOUNTANT`

Roles map to permission strings (`invoice.create`, `report.financial`, …) in
`src/core/permissions.ts`; individual users can be granted or denied single
permissions on top of their role. Identity is re-read from the database on each
request (20 s cache), so deactivating a user takes effect immediately.

---

## Modules

| Area | Path | What it covers |
| --- | --- | --- |
| Auth | `modules/auth` | Login (email is unique per tenant), refresh-token rotation, password reset, platform login |
| Tenants | `modules/tenants` | Provisioning a salon end to end, plans, subscriptions, per-tenant/per-branch settings |
| Branches | `modules/branches` | Branches, chairs/rooms, opening hours, holidays |
| Users | `modules/users` | Staff logins, RBAC, branch assignment, permission overrides |
| Customers | `modules/customers` | CRM, 360 profile, hair/colour profile, before-after photos, CSV import/export, merge, consent |
| Catalog | `modules/catalog` | Service categories, services, member pricing, product consumption recipes |
| Staff | `modules/staff` | Profiles, skills, weekly availability, time off, attendance, leave, targets, commissions, payroll |
| Appointments | `modules/appointments` | Calendar, slot engine, double-booking prevention, walk-ins, waitlist, recurring bookings |
| Billing | `modules/billing` | POS, GST (CGST/SGST/IGST), split payments, coupons, refunds, advances, wallet, void |
| Packages | `modules/packages` | Prepaid session packages and redemption tracking |
| Memberships | `modules/memberships` | Plans, subscriptions, member pricing, complimentary services |
| Loyalty | `modules/loyalty` | Points earn/redeem/expiry, rewards catalogue |
| Inventory | `modules/inventory` | Products, brands, suppliers, purchase orders, stock ledger, wastage, expiry |
| Expenses | `modules/expenses` | Categories, entries, fixed vs variable summary |
| Leads | `modules/leads` | Enquiry pipeline, activities, conversion, source → revenue funnel |
| Marketing | `modules/marketing` | Segments, campaigns, WhatsApp templates, automated journeys, attribution |
| Feedback | `modules/feedback` | Ratings, the 4–5★ / 1–3★ split, complaints, reputation summary |
| Gamification | `modules/gamification` | Challenges, streaks, tiers, referral leaderboard |
| Analytics | `modules/analytics` | Dashboard, growth, unit economics, LTV, cohorts, branch P&L, business alerts |
| Public | `modules/public` | Unauthenticated booking page and feedback form |
| Webhooks | `modules/webhooks` | WhatsApp delivery receipts and STOP handling |

---

## Billing, in one pass

`POST /invoices` takes a basket to a settled, GST-compliant invoice inside a
single transaction:

```
basket → member pricing → package/membership redemption → item discounts
       → bill discount + coupon (apportioned across lines, so tax stays correct)
       → GST split (inclusive by default; CGST/SGST or IGST by place of supply)
       → round off → loyalty redemption → wallet → split payments
       → commissions → stock consumption → customer rollups → journeys
```

Prices are treated as tax-inclusive by default (`pricesIncludeTax`), which is how
Indian salon menus are quoted. Money is `Decimal` end to end — never floats.

**With or without GST, bill by bill.** The salon sets the default under Settings →
Salon → Billing defaults (charge GST by default; prices inclusive or on top; round
off; default rate). At the counter, anyone holding `invoice.gst_choice` — the
front desk has it by default, the owner can take it away by name — flips a single
bill between *Tax invoice* and *Bill without GST*. A no-GST bill charges no tax,
shows none, and stays out of the GST report. A tax invoice is impossible without a
GSTIN on file: the API refuses rather than inventing one.

---

## How a message gets sent

```
appointment / billing / membership / campaign service
      ↓   notify('appointmentReminder', { appointmentId })
src/messaging/notifications.ts   named operations · picks the channel · builds variables
      ↓   queueMessage(...)
src/messaging/dispatcher.ts      consent gate · metering · logging · retries
      ↓   resolveProvider(channel, tenantId)
src/messaging/providers/         Resend · WhatsApp Cloud · MSG91
      ↓
the customer
```

A calling module names the **event** — "this appointment was confirmed" — and knows nothing about
templates, channels, consent or providers. Swapping Resend for SES, or moving reminders from
WhatsApp to SMS, changes one layer and nothing above it.

It is deliberately a notification layer, not an `EmailService`: the same event goes out on whichever
of the three channels reaches that customer, so `pickChannel()` decides — first channel they
consented to, have an address for, and that the salon has connected. Credentials are resolved **per
tenant** in `providers/index.ts`, so a salon's mail leaves as the salon; the platform's own Resend
key is the fallback, and then the salon's name is on the sender line with their address as reply-to.

`MessageLog` is the record of every send — provider, provider message id, status, delivered/read/
clicked timestamps, campaign, customer, cost and attributed revenue — which is what lets a campaign
report *delivered, opened, clicked, booked, earned* rather than just *sent*. Resend's delivery events
arrive at `POST /webhooks/email`.

---

## Payments are manual — there is no gateway

This is a deliberate constraint, not an omission. **No payment gateway, no
third-party payment integration, no card data.** The only outbound HTTP call in
the entire codebase is the WhatsApp provider.

Money changes hands at the counter. The salon then *records* it:

```
POST /invoices/:id/payments
{ "mode": "UPI", "amount": 1650, "reference": "UPI ref 4471 8829 0012" }
```

`mode` is a label for how the cash was taken — `CASH`, `CARD` (their own
machine), `UPI` (their own QR), `CHEQUE`, `BANK_TRANSFER` — plus the in-system
settlements (`WALLET`, `PACKAGE`, `MEMBERSHIP`, `LOYALTY_POINTS`, `ADVANCE`) and
`CREDIT` for "pay next time", which leaves an outstanding balance. `reference`
is free text for the UPI reference, card slip or cheque number.

What follows from that:

- An invoice is `PAID` only because a person said the money arrived.
- **Split payments** are just several manual lines: ₹1,000 cash + ₹650 UPI.
- **Online booking takes no payment** and asks for no card details — the customer
  reserves a slot, and pays at the salon.
- **Outstanding balances** are first-class: `GET /invoices/outstanding`, a
  per-customer `outstanding` figure, and a `payment_reminder` WhatsApp template
  that carries no pay-online link.
- Even the platform's own subscription billing (`POST /platform/tenants/:id/plan`)
  just records what you collected off-platform.

If you ever do want a gateway, the seam is `addPayment()` in
`billing.service.ts` — one function, one place.

## The retention engine

Journeys are per-tenant automations that owners can edit. Every business event
enqueues a trigger; the worker walks the steps:

```
APPOINTMENT_BOOKED   → confirmation
APPOINTMENT_COMPLETED→ thank you (30 min) → review request (2 h)
FIRST_VISIT          → thank you → feedback (7 d) → exit-if-booked (30 d) → rebooking nudge
NO_VISIT_DAYS (60)   → reminder → exit-if-booked (5 d) → 15% offer → exit-if-booked (10 d) → 20% offer
MEMBERSHIP_EXPIRING  → 30 days → 7 days → 1 day
BIRTHDAY             → offer + bonus points
LEAD_CREATED         → welcome → follow-up (2 d)
```

**Consent is enforced in one place** (`messaging/dispatcher.ts`): WhatsApp
marketing templates require `OPTED_IN`; utility (transactional) templates only
require that the customer has not opted out. Replies of `STOP`/`UNSUBSCRIBE`
flip consent off via the webhook. Templates carry the provider-approved name and
category, because WhatsApp Business does not allow free-form business-initiated
marketing.

---

## Background jobs

Jobs live in Postgres (`jobs` table) rather than Redis: one less service to run,
and the queue is transactionally consistent with the data it refers to. The
worker claims a row by flipping `PENDING → RUNNING`, so several workers can share
the queue safely. Failures retry with backoff (30 s → 2 h) and land in `DEAD`.

Scheduled sweeps:

| When | Job |
| --- | --- |
| every 15 min | no-show sweep |
| 06:30 | build the day's business alerts |
| 09:00 | birthdays |
| 10:00 | win-back (customers who just crossed the inactivity threshold) |
| 11:00 / 11:15 | membership and package expiry |
| 01:00 / 01:20 / 01:40 | loyalty expiry, segment recompute, challenge progress |

The worker runs in-process by default. Once volume justifies it, set
`JOB_WORKER_ENABLED=false` on the API and run `npm run start:worker` separately.

---

## API shape

Base path `/api/v1`. Success:

```json
{ "success": true, "data": { }, "meta": { "page": 1, "pageSize": 25, "total": 0 } }
```

Failure:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] }, "requestId": "…" }
```

Full endpoint list: [`docs/API.md`](docs/API.md).
Data model notes: [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md).

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API with hot reload |
| `npm run dev:worker` | Job worker only |
| `npm run build` | `prisma generate` + `tsc` |
| `npm start` | Run the compiled API |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Vitest unit tests |
| `npm run prisma:migrate` | Create/apply a migration |
| `npm run seed` | Demo tenant with 90 days of history |
| `npm run prisma:studio` | Browse the database |

---

## Deployment notes

- Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to long random values.
- Run `npx prisma migrate deploy` on release.
- `/health` is a liveness probe; `/ready` also checks the database.
- The API trusts one proxy hop (`trust proxy = 1`) for correct client IPs in
  rate limiting and audit logs.
- Set `MESSAGING_DRIVER=whatsapp_cloud` plus the WhatsApp credentials to send for
  real; the default `console` driver logs messages instead, so the whole journey
  engine can be exercised without a provider.

## What is deliberately not here

Frontend and admin UI — this repository is backend only, as briefed. The public
booking page, owner dashboard and admin console consume the API above.

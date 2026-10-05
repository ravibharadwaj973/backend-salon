# Bringing up an empty server database

Three steps, in order. Only the first one is unavoidable.

---

## 1. The schema — use `prisma db push`, pointed at the server

```bash
DATABASE_URL="postgresql://user:pass@your-server:5432/parlon" npx prisma db push
```

**This does not need a local database.** `db push` reads `prisma/schema.prisma` and
writes to whatever `DATABASE_URL` points at, so running it from your laptop, from
CI, or from the server box all do the same thing to the same server. Where the
command runs is irrelevant; the target is what matters.

### Why there is no hand-written schema.sql here

There was going to be one. It would have been wrong.

`prisma/migrations/` has drifted a long way behind `schema.prisma`, because this
project is developed with `db push` and migrations have been written by hand
afterwards. Applying every migration in order to an empty Postgres 16 and then
comparing the result against `schema.prisma` gives:

- **4 tables missing**: `TrackedLink`, `enquiries`, `invoice_series`, `tenant_assets`
- **42 columns missing** across 9 tables, including:
  - `appointments.sourceRef` — the whole ad-attribution loop reads this
  - 15 columns on `customers` — reachability, the visit clock, lifecycle stage
  - 8 on `campaigns`, 6 on `message_templates`, 5 on `message_logs`
- **2 migrations cannot apply to an empty database at all** — `site_visits` and
  `engagement_tracking` both reference `TrackedLink`, which only `db push` creates

A database built from that folder would start, serve most screens, and then
throw `column does not exist` the first time somebody opened Reports or booked
through a tracked link. `db push` is the only thing that reproduces
`schema.prisma`, so it is the only thing worth trusting for this.

Worth fixing one day: either regenerate the migrations folder from the schema
(`prisma migrate diff --from-empty --to-schema-datamodel`) or drop it and commit
to `db push`. Half a migration history is worse than either.

---

## 2. The first login — `make-admin.js`

On an empty database **there is no way into the product**. Every salon is created
by the platform admin console, every platform admin is created by `prisma/seed.ts`,
and the seed deletes and rebuilds a tenant — which is the wrong tool for a server.

```bash
node prisma/server-bootstrap/make-admin.js "you@yourdomain.com" "a long password"
```

It prints one `INSERT`. Read it, then run it against the server. The password is
hashed locally and never leaves your machine; the output contains a hash, so do
not commit it.

Then sign in to the admin console and create the salon there. Provisioning does
a great deal more than a row — service categories, expense categories, opening
hours, the default journeys and message templates, the owner's user account —
and none of that happens if you insert a tenant by hand.

---

## 3. The hairstyle catalogue — optional

```bash
psql "$DATABASE_URL" -f prisma/server-bootstrap/hairstyle-catalogue.sql
```

33 cuts for every salon on the server, linked to each one's own
`Haircut (Women)` / `Haircut (Men)` service where it has one. Safe to run
repeatedly: `(tenantId, kind, name)` is unique, so a second run inserts nothing
and a style a salon has renamed keeps its name.

**You probably do not need this.** The Hairstyles screen has an "Add the standard
menu" button that does the same job through the API, which is easier for one
salon and does the same validation. This file is for doing it to all of them at
once.

Generated from `src/modules/hair-studio/hairstyle-kinds.ts` — the list of cuts
the 3D studio can actually draw. Do not invent a `kind`: one the studio has no
generator for renders a bald head and reports no error.

---

## What NOT to run on a server

```
npm run seed          # deletes the tenant and rebuilds it
```

`prisma/seed.ts` is a development fixture. It drops the salon and recreates it
with 40 invented customers and 90 days of invented bookings. It is the right
tool for a laptop and a loaded gun anywhere else.

---

## Verified

- Every migration in `prisma/migrations/` applied to a real Postgres 16, twice.
  All nine of the guarded ones re-ran cleanly; twelve older ones fail on a
  second pass. The drift above was measured the same way, not guessed.
- `hairstyle-catalogue.sql` run against a real database: 33 rows, correct
  service links by gender, second run a clean no-op.
- `make-admin.js` generated, applied, and rotated: one row, new password
  verifies, old one rejected.

Not verified: `prisma/seed.ts` has never been executed, here or anywhere in this
session. It typechecks against the generated client, which pins every field name
and enum value, and that is all that can be said for it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE ONE QUERY IN THIS CODEBASE THE COMPILER CANNOT CHECK.
 *
 * The trend chart groups by a truncated date, which no ORM can express, so it
 * is raw SQL. Raw SQL is a string: renaming a Prisma field leaves it compiling
 * cleanly and failing at runtime, in a report, in front of an owner.
 *
 * Two things go wrong and neither announces itself:
 *
 *   1. The schema declares no @map, so Postgres holds these columns in camel
 *      case. An unquoted identifier is folded to lower case by Postgres and
 *      the query dies on a column that "does not exist" but plainly does.
 *   2. A field renamed in the schema leaves the SQL pointing at nothing.
 *
 * So this reads the actual schema and checks the actual query text. It needs
 * no database, which is the point — it runs on every commit.
 */

const ROOT = join(__dirname, '..');
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const SERVICE = readFileSync(join(ROOT, 'src/modules/analytics/messaging-analytics.service.ts'), 'utf8');

/**
 * The SQL text only — every `${...}` is a bound parameter, and whatever
 * JavaScript name sits inside it never reaches Postgres. Checking those as if
 * they were identifiers flags `${tenantId}` as an unquoted column, which is
 * both wrong and exactly the sort of false alarm that gets a guard deleted.
 */
function sqlTextOf(source: string): string[] {
  return [...source.matchAll(/Prisma\.sql`([\s\S]*?)`/g)].map((m) =>
    m[1]!.replace(/\$\{[^}]*\}/g, ' ? '),
  );
}

/** The scalar field names Prisma declares on a model. */
function fieldsOf(model: string): Set<string> {
  const start = SCHEMA.indexOf(`model ${model} {`);
  expect(start, `model ${model} not found in schema`).toBeGreaterThan(-1);
  const end = SCHEMA.indexOf('\n}', start);
  const body = SCHEMA.slice(start, end);

  const names = new Set<string>();
  for (const line of body.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@') || trimmed.startsWith('///')) continue;
    const name = trimmed.split(/\s+/)[0];
    if (name) names.add(name);
  }
  return names;
}

describe('the raw trend query', () => {
  const fields = fieldsOf('MessageLog');

  it('reads a model whose fields this test can actually see', () => {
    // Guards the guard: if the parser above silently returns nothing, every
    // assertion below passes vacuously and the test is worse than useless.
    expect(fields.size).toBeGreaterThan(15);
    expect(fields.has('queuedAt')).toBe(true);
    expect(fields.has('attributedRevenue')).toBe(true);
    expect(fields.has('purpose')).toBe(true);
  });

  it('names only columns that exist on MessageLog', () => {
    const sqlBlocks = sqlTextOf(SERVICE);
    expect(sqlBlocks.length).toBeGreaterThan(0);

    const identifiers = new Set<string>();
    for (const block of sqlBlocks) {
      for (const m of block.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) identifiers.add(m[1]!);
    }

    // Table name, not a column.
    identifiers.delete('message_logs');

    expect(identifiers.size).toBeGreaterThan(0);
    for (const id of identifiers) {
      expect(fields.has(id), `SQL references "${id}", which is not a field on MessageLog`).toBe(true);
    }
  });

  it('quotes every column it names, because Postgres would lower-case them', () => {
    const sqlBlocks = sqlTextOf(SERVICE);
    const camelFields = [...fields].filter((f) => /[A-Z]/.test(f));

    for (const block of sqlBlocks) {
      for (const field of camelFields) {
        // Every appearance of a camelCase field name must be inside quotes.
        const bare = new RegExp(`(?<!")\\b${field}\\b(?!")`, 'g');
        const hits = block.match(bare) ?? [];
        expect(hits, `unquoted "${field}" in raw SQL — Postgres will fold it to lower case`).toHaveLength(0);
      }
    }
  });

  it('compares enums as text rather than casting to a Prisma type name', () => {
    // A cast like ::"MessagePurpose" ties the query to an enum's Prisma name,
    // so renaming the enum breaks the report silently. ::text does not.
    expect(SERVICE).not.toMatch(/::"[A-Z]/);
  });

  it('is scoped to one tenant', () => {
    // Raw SQL bypasses the client's tenant scoping entirely. This is the one
    // place in the codebase where forgetting that leaks another salon's data.
    const blocks = sqlTextOf(SERVICE);
    expect(blocks.some((b) => b.includes('"tenantId"'))).toBe(true);
  });

  it('would catch an unquoted column, so this guard is not vacuous', () => {
    // A test that can never fail is worse than no test. This proves the
    // check fires on the mistake it exists to catch.
    const bad = 'Prisma.sql`SELECT queuedAt FROM "message_logs`';
    const [block] = sqlTextOf(bad + '`');
    const hits = block?.match(/(?<!")\bqueuedAt\b(?!")/g) ?? [];
    expect(hits).toHaveLength(1);
  });
});

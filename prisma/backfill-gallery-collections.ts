/**
 * BACKFILL: MOVE GALLERY PHOTOGRAPHS ONTO THE SALON'S OWN CATEGORIES.
 *
 * The gallery's collections were a fixed list in the code — colour, cuts,
 * treatments, skin, bridal, studio — and are now the salon's own service
 * categories. So `collection` holds a ServiceCategory id where it used to hold
 * one of those words.
 *
 * Any photograph still carrying an old word belongs to no collection the app
 * knows about, which means it silently stops appearing anywhere. A photograph
 * that vanishes without a message is worse than one in the wrong place, so
 * every row is moved somewhere and every move is printed.
 *
 * ── The mapping, and what it refuses to guess ────────────────────────────
 *
 * The old words map onto category NAMES where the correspondence is obvious
 * and the salon actually has that category. "colour", "cuts" and "treatments"
 * were all hair; "skin" was skin; "bridal" was makeup. Where the salon has no
 * such category the photograph goes to `studio` rather than to a category
 * picked because it was nearest — a colour photograph filed under Nails is a
 * worse outcome than one the owner has to re-file, and the log says which.
 *
 * Safe to run more than once: it only touches rows whose collection is not a
 * real category id and not 'studio'.
 *
 *   docker run --rm --network salon --env-file .env api:migrate \
 *     npx tsx prisma/backfill-gallery-collections.ts
 */
import { PrismaClient } from '@prisma/client';
import { STUDIO_KEY } from '../src/modules/gallery/collections';

const prisma = new PrismaClient();

/** Old fixed key → the category NAME it meant, lowercased for matching. */
const MEANT: Record<string, string[]> = {
  colour: ['hair'],
  cuts: ['hair'],
  treatments: ['hair'],
  skin: ['skin'],
  bridal: ['makeup', 'bridal'],
};

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  let moved = 0;
  let toStudio = 0;

  for (const tenant of tenants) {
    const categories = await prisma.serviceCategory.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true },
    });

    const validKeys = new Set([...categories.map((category) => category.id), STUDIO_KEY]);
    const byName = new Map(categories.map((category) => [category.name.toLowerCase(), category.id]));

    const photos = await prisma.galleryPhoto.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, collection: true, alt: true },
    });

    for (const photo of photos) {
      if (validKeys.has(photo.collection)) continue;

      const candidates = MEANT[photo.collection.toLowerCase()] ?? [];
      const target = candidates.map((name) => byName.get(name)).find(Boolean) ?? STUDIO_KEY;

      await prisma.galleryPhoto.update({ where: { id: photo.id }, data: { collection: target } });

      const label = target === STUDIO_KEY ? 'the studio' : (categories.find((c) => c.id === target)?.name ?? target);
      // eslint-disable-next-line no-console
      console.log(`${tenant.slug}: "${photo.collection}" → ${label}  (${photo.alt.slice(0, 50)})`);

      moved += 1;
      if (target === STUDIO_KEY) toStudio += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\ngallery collections: moved ${moved}` +
      (toStudio > 0
        ? `, of which ${toStudio} had no matching category and went to the studio — re-file those in the app.`
        : '.'),
  );
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

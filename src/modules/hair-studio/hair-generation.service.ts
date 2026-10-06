import type { FaceShape, HairGenerationKind, HairGeneration, HairLength, HairTexture, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, currentUserId, runAsTenant, runUnscoped } from '../../core/context';
import { optionalBranchFilter } from '../../core/scope';
import { BadRequest, NotFound, TooManyRequests } from '../../core/errors';
import { logger } from '../../core/logger';
import { dayjs, startOfDay } from '../../core/dates';
import { env, fluxReady } from '../../config/env';
import { enqueue } from '../../jobs/queue';
import { decodeDataUrl, readImageBytes, uploadBytes } from '../gallery/cloudinary';
import { designConfigSchema, type DesignConfig } from './design-rules';
import { buildPrompt, buildRecolourPrompt, buildReferencePrompt, NEGATIVE, type PromptInput } from './hair-prompt';
import * as flux from './flux';

/**
 * PHOTOGRAPHIC PREVIEWS, END TO END.
 *
 * ── Why this is a queue and not a request ─────────────────────────────────
 *
 * A generation takes somewhere between ten seconds and a minute. Holding the
 * HTTP request open for that would tie up a connection, time out behind nginx,
 * and lose the picture entirely if the salon's phone went to sleep — and the
 * picture is the part that cost money. So the request returns a row, the row
 * says PENDING, and the screen asks again in a moment.
 *
 * ── Why the job re-schedules itself instead of looping ────────────────────
 *
 * This codebase's worker is one pass over a batch of due jobs, awaited in
 * order, on a five-second interval. A handler that polled a provider in a loop
 * for forty seconds would hold up every appointment reminder behind it in that
 * batch. So waiting is expressed as a *job that runs again later*: each poll is
 * one HTTP call, and either it finishes or it enqueues its own successor with a
 * runAt a few seconds out. The queue becomes the timer, which is the only way to
 * wait patiently in a worker that other features share.
 */

// ------------------------------------------------------------- requesting ---

export interface GenerationInput {
  kind: HairGenerationKind;
  /**
   * Which saved design to draw. Required for a portrait and a style preview:
   * the whole point is that the picture matches a design the salon can actually
   * cut, and a prompt typed by hand is a picture of nothing in the catalogue.
   */
  designId: string;
  customerId?: string | null;
  branchId?: string | null;
  /**
   * For an edit: the picture to work from. A url we already host — a previous
   * generation, or the salon's own gallery — never something arbitrary from the
   * internet.
   */
  sourceGenerationId?: string | null;
  /**
   * For CUSTOMER_PREVIEW: the reading that holds the customer's own photograph.
   *
   * The photo is referenced through the reading rather than passed as a url,
   * which is the whole safety property — the only faces this endpoint can draw
   * on are ones already stored against a recorded consent in this salon.
   */
  sourceAnalysisId?: string | null;
  /** Same seed, same face. Omitted means a new person. */
  seed?: number | null;
}

/**
 * THE CAP, AND WHY IT IS COUNTED HERE.
 *
 * Every other third party in this app is billed to the salon per message. This
 * one is billed to us per picture, and the button that spends it sits on a
 * tablet in a salon on a slow afternoon. The realistic failure is not an outage;
 * it is somebody pressing generate forty times to see which face they like.
 *
 * Counted over the salon's own rows for the day, including the ones that failed
 * after being submitted — because those were charged too.
 */
async function assertUnderDailyCap(tenantId: string): Promise<void> {
  const limit = env.BFL_DAILY_LIMIT_PER_TENANT;
  if (limit === 0) return;

  const since = startOfDay(new Date());
  const used = await prisma.hairGeneration.count({
    where: { tenantId, createdAt: { gte: since }, status: { not: 'PENDING' } },
  });

  if (used >= limit) {
    throw TooManyRequests(
      `That is ${limit} generated previews today, which is this salon's daily limit. ` +
        'The 3D studio still works as normal — it draws in the browser and costs nothing.',
    );
  }
}

/**
 * Accept the work and return immediately.
 *
 * Everything that can be refused is refused here, synchronously, while somebody
 * is looking at the screen: no key, no design, a cap reached, a source image
 * that is not ready. A row only exists once the request is known to be worth
 * making, so a PENDING row means "this is going to happen", not "this might".
 */
export async function requestGeneration(input: GenerationInput): Promise<HairGeneration> {
  const tenantId = requireTenantId();

  if (!fluxReady) {
    throw BadRequest(
      'Photographic previews are not set up on this server. The 3D studio works without them — it draws the hair itself.',
    );
  }

  const design = await prisma.hairDesign.findFirst({
    where: { id: input.designId, tenantId },
    include: { catalog: { select: { name: true, gender: true } } },
  });
  if (!design) throw NotFound('Design not found');

  /**
   * An edit needs something finished to edit.
   *
   * Checked now rather than in the job: "the picture you are recolouring has not
   * finished yet" is a sentence somebody can act on, and the same discovery made
   * inside a worker is a FAILED row nobody is watching.
   */
  let source: HairGeneration | null = null;
  let analysisId: string | null = null;
  let inputImageUrl: string | null = null;
  let analysisCustomerId: string | null = null;

  if (input.kind === 'CUSTOMER_PREVIEW') {
    /**
     * PREVIEW ON THE CUSTOMER'S OWN FACE.
     *
     * Reached only through a stored reading, which is the gate: a reading exists
     * only if somebody agreed to their photograph being kept, and it belongs to
     * this salon. There is deliberately no way to pass a url here — that would be
     * an endpoint that renders any face on the internet wearing a haircut.
     */
    if (!input.sourceAnalysisId) {
      throw BadRequest("Previewing on the customer needs their photo — add a reading with a photo first.");
    }
    const analysis = await prisma.hairAnalysis.findFirst({
      where: { id: input.sourceAnalysisId, tenantId },
      select: { id: true, imageUrl: true, consentAt: true, customerId: true },
    });
    if (!analysis) throw NotFound('The reading to start from');
    if (!analysis.imageUrl) throw BadRequest('That reading has no photo to work from.');
    // Belt and braces: the service that writes these refuses to store a photo
    // without consent, and this refuses to USE one. Two independent checks,
    // because the cost of being wrong once is a customer's face in a prompt.
    if (!analysis.consentAt) throw BadRequest('That photo has no recorded consent, so it cannot be used.');

    analysisId = analysis.id;
    inputImageUrl = analysis.imageUrl;
    analysisCustomerId = analysis.customerId;
  } else if (input.kind !== 'MODEL_PORTRAIT') {
    if (!input.sourceGenerationId) {
      throw BadRequest('Changing a look needs a finished picture to start from.');
    }
    source = await prisma.hairGeneration.findFirst({
      where: { id: input.sourceGenerationId, tenantId },
    });
    if (!source) throw NotFound('The picture to start from');
    if (source.status !== 'READY' || !source.imageUrl) {
      throw BadRequest('That picture has not finished generating yet.');
    }
    inputImageUrl = source.imageUrl;
  }

  await assertUnderDailyCap(tenantId);

  const promptInput = promptInputFor(design, design.catalog?.name ?? null, design.catalog?.gender ?? null);
  const prompt =
    input.kind === 'RECOLOUR'
      ? buildRecolourPrompt({ ...promptInput, editing: true })
      : buildPrompt({ ...promptInput, editing: input.kind !== 'MODEL_PORTRAIT' });

  const generation = await prisma.hairGeneration.create({
    data: {
      tenantId,
      branchId: input.branchId ?? design.branchId ?? null,
      /*
       * The reading's own customer wins. A picture of somebody's face filed
       * under nobody — or under whoever the design happened to be saved for — is
       * precisely the row that survives a deletion request.
       */
      customerId: analysisCustomerId ?? input.customerId ?? design.customerId ?? null,
      designId: design.id,
      kind: input.kind,
      status: 'PENDING',
      prompt,
      model: env.BFL_MODEL,
      /**
       * A SEED IS WHAT MAKES A VIRTUAL MODEL ONE PERSON.
       *
       * Inherited from the source picture for an edit, so a recolour returns the
       * same woman in a different colour rather than her sister. Chosen at random
       * for a new portrait, and stored, because "generate that one again" is the
       * first thing anybody asks for.
       */
      seed: input.seed ?? source?.seed ?? Math.floor(Math.random() * 2_147_483_647),
      inputImageUrl,
      analysisId,
      /*
       * A preview of a real person is attached to that person, whatever the
       * caller passed: the reading knows whose face it is, and a picture of
       * somebody's face filed under nobody is exactly the row that survives a
       * deletion request.
       */
      createdById: currentUserId(),
    },
  });

  await enqueue(
    'hair.generate.submit',
    { generationId: generation.id },
    { tenantId, uniqueKey: `hair.generate:${generation.id}` },
  );

  return generation;
}

/** The design, read out as the prompt builder wants it. */
function promptInputFor(
  design: {
    hairstyleKey: string;
    texture: PromptInput['texture'];
    length: PromptInput['length'];
    density: PromptInput['density'];
    volume: number;
    baseColor: string;
    config: Prisma.JsonValue;
  },
  styleName: string | null,
  gender?: PromptInput['gender'],
): PromptInput {
  return {
    hairstyleKey: design.hairstyleKey,
    styleName,
    gender: gender ?? null,
    texture: design.texture,
    length: design.length,
    density: design.density,
    volume: design.volume,
    baseColor: design.baseColor,
    config: readConfig(design.config),
  };
}

/**
 * A stored config, read back defensively.
 *
 * The column is Json and the rows predate this file, so parsing can fail — and a
 * failure here must cost the colour effects, never the whole picture. A plain cut
 * in the right colour is a useful preview; a FAILED row because a nine-month-old
 * design has a field this schema does not know is not.
 */
function readConfig(value: Prisma.JsonValue): DesignConfig | null {
  const parsed = designConfigSchema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  logger.warn({ issues: parsed.error.issues.length }, 'hair design config did not parse; generating without its colour options');
  return null;
}

// ------------------------------------------------------------- submitting ---

/**
 * Hand one row to the provider. Called by the job, never by a request.
 *
 * Returns a word rather than throwing on a refusal, because the job handler's
 * only job is to decide whether to retry — and a thrown error means "retry" to
 * the worker whether or not retrying could ever work.
 */
export async function submitGeneration(generationId: string): Promise<'submitted' | 'skipped' | 'failed'> {
  const generation = await runUnscoped(() => prisma.hairGeneration.findUnique({ where: { id: generationId } }));
  if (!generation) return 'skipped';
  // Already on its way, or already finished. A duplicate job must not pay twice.
  if (generation.status !== 'PENDING') return 'skipped';

  return runAsTenant(generation.tenantId, async () => {
    let inputImage: Buffer | undefined;
    if (generation.inputImageUrl) {
      try {
        inputImage = await flux.download(generation.inputImageUrl);
      } catch (err) {
        await fail(generation.id, 'The picture this was based on could not be read.', err);
        return 'failed';
      }
    }

    try {
      const result = await flux.submit({
        prompt: generation.prompt,
        seed: generation.seed ?? undefined,
        negativePrompt: generation.kind === 'MODEL_PORTRAIT' ? NEGATIVE : undefined,
        inputImage,
      });

      await prisma.hairGeneration.update({
        where: { id: generation.id },
        data: {
          status: 'SUBMITTED',
          providerId: result.providerId,
          pollingUrl: result.pollingUrl,
          submittedAt: new Date(),
        },
      });

      await schedulePoll(generation.id, generation.tenantId, 0);
      return 'submitted';
    } catch (err) {
      /**
       * A broken setting is not a bad minute.
       *
       * Retrying a wrong key or a model this account cannot use burns five
       * attempts and five backoffs to arrive at the same answer, and leaves the
       * row saying RUNNING for two hours. Those fail the row once, with the
       * provider's own words, so whoever set the key up can read what is wrong.
       */
      if (err instanceof flux.FluxError && err.reason !== 'transient') {
        await fail(generation.id, err.message, err);
        return 'failed';
      }
      throw err;
    }
  });
}

/** One status check. Either it finishes, or it books its own next check. */
export async function pollGeneration(generationId: string, attempt: number): Promise<string> {
  const generation = await runUnscoped(() => prisma.hairGeneration.findUnique({ where: { id: generationId } }));
  if (!generation) return 'gone';
  if (generation.status !== 'SUBMITTED' || !generation.pollingUrl) return generation.status.toLowerCase();

  return runAsTenant(generation.tenantId, async () => {
    const result = await flux.poll(generation.pollingUrl!);

    await prisma.hairGeneration.update({ where: { id: generation.id }, data: { polls: attempt + 1 } });

    if (result.status === 'pending') {
      /**
       * GIVING UP IS A FEATURE.
       *
       * A provider that never answers would otherwise be polled until the end of
       * time, one job every four seconds, for every row that ever got stuck. The
       * ceiling is a couple of orders of magnitude above a normal generation, so
       * reaching it means something is actually wrong.
       */
      if (attempt + 1 >= env.BFL_MAX_POLLS) {
        await fail(
          generation.id,
          'The image provider did not finish this in time. Nothing was lost — try again.',
          null,
        );
        return 'timed out';
      }
      await schedulePoll(generation.id, generation.tenantId, attempt + 1);
      return 'pending';
    }

    if (result.status === 'refused') {
      /**
       * REFUSED, NOT FAILED, AND NOT RETRIED.
       *
       * The provider's own safety filter declined either the prompt or what it
       * drew. Retrying produces the same refusal and another charge, and the
       * salon needs to change the design rather than press the button again.
       */
      await prisma.hairGeneration.update({
        where: { id: generation.id },
        data: {
          status: 'REFUSED',
          error:
            'The image provider would not produce this picture. Try a different colour or a less extreme description.',
        },
      });
      return 'refused';
    }

    if (result.status !== 'ready' || !result.sampleUrl) {
      await fail(generation.id, result.detail ?? 'The image provider could not produce this picture.', null);
      return 'failed';
    }

    return store(generation.id, generation.tenantId, result.sampleUrl);
  });
}

/**
 * Download the finished picture and re-host it.
 *
 * The provider's url expires within the hour, so this is the step that decides
 * whether the salon still has a picture tomorrow. It runs inside the poll job
 * rather than as another queued step on purpose: between "the image exists" and
 * "we have a copy" there is a window where the only copy is somewhere else, and
 * making that window a queue delay is asking to lose pictures whenever the
 * worker is busy.
 */
async function store(generationId: string, tenantId: string, sampleUrl: string): Promise<string> {
  const tenant = await runUnscoped(() => prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }));

  try {
    const downloaded = await flux.download(sampleUrl);
    // The same gate a salon's own upload goes through. We asked for an image;
    // that is not evidence of what came back.
    const { bytes, contentType } = readImageBytes(downloaded);

    const uploaded = await uploadBytes({
      bytes,
      contentType,
      folder: `${tenant?.slug ?? tenantId}/hair-studio`,
      /**
       * Tagged apart from the gallery deliberately. The website renders by tag,
       * and a generated model portrait appearing on a salon's public page
       * alongside photographs of real customers' haircuts is not a mistake we
       * want to make once.
       */
      tags: ['hair-generated', `salon-${tenant?.slug ?? tenantId}`],
    });

    await prisma.hairGeneration.update({
      where: { id: generationId },
      data: {
        status: 'READY',
        imageUrl: uploaded.secureUrl,
        imagePublicId: uploaded.publicId,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
        readyAt: new Date(),
        error: null,
      },
    });

    return 'ready';
  } catch (err) {
    /*
     * Failed, and left retryable: the image is generated and paid for, and the
     * only thing that went wrong is our own copy of it. The row keeps its
     * polling url, so a later attempt can still find it if the provider has not
     * yet swept it away.
     */
    await fail(generationId, 'The finished picture could not be stored. The design is safe — try again.', err);
    return 'failed';
  }
}

async function fail(generationId: string, message: string, err: unknown): Promise<void> {
  if (err) logger.warn({ err, generationId }, 'hair generation failed');
  await runUnscoped(() =>
    prisma.hairGeneration.update({ where: { id: generationId }, data: { status: 'FAILED', error: message } }),
  );
}

function schedulePoll(generationId: string, tenantId: string, attempt: number): Promise<void> {
  return enqueue(
    'hair.generate.poll',
    { generationId, attempt },
    {
      tenantId,
      runAt: new Date(Date.now() + env.BFL_POLL_INTERVAL_MS),
      // The attempt number is part of the key, or the second poll would be
      // collapsed into the first one and the row would wait for ever.
      uniqueKey: `hair.generate.poll:${generationId}:${attempt}`,
      // One attempt. A poll that throws is re-booked by the next poll, not by
      // the queue's own backoff, which would double the schedule.
      maxAttempts: 1,
    },
  );
}

// ------------------------------------------------- catalogue references ------

export interface ReferenceInput {
  catalogId: string;
  /** Which of the style's supported options to draw. Defaults to the middle. */
  texture?: HairTexture | null;
  length?: HairLength | null;
  faceShape?: FaceShape | null;
  /** Hex. A look-book in one colour reads as one haircut repeated. */
  baseColor?: string | null;
  seed?: number | null;
}

/**
 * ONE PICTURE FOR ONE THING THE SALON SELLS, DRAWN ONCE.
 *
 * ── Why this is the endpoint the economics depend on ──────────────────────
 *
 * Every other generation here is per consultation. This one is per MENU ENTRY,
 * made when the salon sets its catalogue up and shown from then on to everybody
 * who opens the look-book. A library that regenerated itself on each page view
 * would cost more per month than the subscription, and the whole design of the
 * feature is that it does not: fifty configuration changes in the 3D studio cost
 * nothing, and a picture is drawn only when somebody asks for one.
 *
 * ── Why it does not go through a design ───────────────────────────────────
 *
 * A design is what a CUSTOMER chose. A reference picture illustrates what the
 * SALON offers, has no customer, and must outlive any particular consultation.
 * Routing it through a throwaway design would put rows in a customer's history
 * for looks nobody ever asked for.
 */
export async function requestCatalogReference(input: ReferenceInput): Promise<HairGeneration> {
  const tenantId = requireTenantId();

  if (!fluxReady) {
    throw BadRequest(
      'Reference pictures are not set up on this server. The catalogue works without them — the 3D studio draws every style itself.',
    );
  }

  const entry = await prisma.hairstyleCatalog.findFirst({ where: { id: input.catalogId, tenantId } });
  if (!entry) throw NotFound('Hairstyle not found');

  await assertUnderDailyCap(tenantId);

  /*
   * MIDDLE OF THE RANGE, NOT THE FIRST OPTION.
   *
   * `supportedLengths[0]` is the shortest the style is offered at, and a
   * look-book drawn entirely at the short end misrepresents half the menu. The
   * middle is the one that looks like the style people have in mind when they
   * say its name.
   */
  const middle = <T>(list: T[], fallback: T): T => list[Math.floor(list.length / 2)] ?? fallback;

  const texture = input.texture ?? middle(entry.supportedTextures, 'STRAIGHT');
  const length = input.length ?? middle(entry.supportedLengths, 'MEDIUM');
  const density = middle(entry.supportedDensities, 'MEDIUM');
  const faceShape = input.faceShape ?? entry.recommendedFaceShapes[0] ?? null;

  const prompt = buildReferencePrompt({
    hairstyleKey: entry.kind,
    styleName: entry.name,
    gender: entry.gender,
    texture,
    length,
    density,
    volume: 50,
    // A dark brown default: it is the commonest hair colour in this market, and
    // it photographs with visible strand separation, which blonde does not.
    baseColor: input.baseColor ?? '#3B2417',
    faceShape,
    /*
     * The style's own switches, at their natural setting. Deliberately NOT the
     * full configurator: a reference picture is of the STYLE, and a bob drawn
     * with curtain bangs and a deep side parting is a picture of one styling of
     * it rather than of the thing on the menu.
     */
    config: {
      bangs: 'NONE',
      layers: entry.supportsLayers ? 'MEDIUM' : 'NONE',
      parting: 'NATURAL',
      ...(entry.supportsFade ? { fade: { type: 'MID' as const, guard: 1 as const, topLength: 50 } } : {}),
    },
  });

  const generation = await prisma.hairGeneration.create({
    data: {
      tenantId,
      branchId: entry.branchId,
      catalogId: entry.id,
      kind: 'CATALOG_REFERENCE',
      status: 'PENDING',
      prompt,
      model: env.BFL_MODEL,
      seed: input.seed ?? Math.floor(Math.random() * 2_147_483_647),
      createdById: currentUserId(),
    },
  });

  await enqueue(
    'hair.generate.submit',
    { generationId: generation.id },
    { tenantId, uniqueKey: `hair.generate:${generation.id}` },
  );

  return generation;
}

/**
 * CHOOSE THE BEST ONE — the step the specification calls "select best result".
 *
 * Generation is cheap and judgement is not: a model draws four plausible heads
 * and exactly one of them looks like the haircut the salon actually does. So
 * nothing is attached automatically. A picture becomes the menu's face only when
 * a person picks it, and picking a different one later is the same call again.
 */
export async function setCatalogPreview(catalogId: string, generationId: string | null) {
  const tenantId = requireTenantId();

  const entry = await prisma.hairstyleCatalog.findFirst({ where: { id: catalogId, tenantId } });
  if (!entry) throw NotFound('Hairstyle not found');

  if (generationId === null) {
    return prisma.hairstyleCatalog.update({ where: { id: entry.id }, data: { previewUrl: null } });
  }

  const picture = await prisma.hairGeneration.findFirst({
    where: { id: generationId, tenantId, catalogId: entry.id },
    select: { status: true, imageUrl: true },
  });
  if (!picture) throw NotFound('That picture');
  if (picture.status !== 'READY' || !picture.imageUrl) {
    throw BadRequest('That picture has not finished yet.');
  }

  return prisma.hairstyleCatalog.update({
    where: { id: entry.id },
    data: { previewUrl: picture.imageUrl },
  });
}

/** Everything drawn for one menu entry, newest first. */
export async function listCatalogReferences(catalogId: string) {
  const tenantId = requireTenantId();
  return prisma.hairGeneration.findMany({
    where: { tenantId, catalogId },
    orderBy: { createdAt: 'desc' },
    take: 24,
    select: publicFields,
  });
}

/**
 * CUT THE HAIR OUT OF THE PICTURE, ONCE.
 *
 * The mask is drawn by a person in the asset studio — a few taps on the hair and
 * a brush to tidy the edges — and stored beside the photograph it belongs to.
 * Blind segmentation was tried first and was confidently wrong: on a portrait
 * with a gradient backdrop it selected the WALL, because the wall was the largest
 * region that was neither skin nor a flat border colour. A rule that wrong is
 * worse than no rule, and a person pointing at the hair is the one piece of
 * information no heuristic has.
 *
 * Stored as its own image rather than as an alpha channel on the photograph:
 * the photograph is shown on its own in the look-book and must stay a plain
 * opaque picture, and a mask that can be redrawn without regenerating the
 * portrait is the point of keeping them apart.
 */
export async function setCatalogMask(catalogId: string, dataUrl: string | null) {
  const tenantId = requireTenantId();

  const entry = await prisma.hairstyleCatalog.findFirst({ where: { id: catalogId, tenantId } });
  if (!entry) throw NotFound('Hairstyle not found');

  if (dataUrl === null) {
    return prisma.hairstyleCatalog.update({ where: { id: entry.id }, data: { maskUrl: null } });
  }

  const { bytes, contentType } = decodeDataUrl(dataUrl);
  const tenant = await runUnscoped(() =>
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  );

  const uploaded = await uploadBytes({
    bytes,
    contentType,
    folder: `${tenant?.slug ?? tenantId}/hair-masks`,
    /*
     * Its own tag, well away from the gallery's. A mask is a black-and-white
     * silhouette of somebody's hair; it is of no interest to anyone but the
     * renderer, and it must never appear on the salon's public page because it
     * happened to share a tag with the photographs.
     */
    tags: ['hair-mask', `salon-${tenant?.slug ?? tenantId}`],
  });

  return prisma.hairstyleCatalog.update({
    where: { id: entry.id },
    data: { maskUrl: uploaded.secureUrl },
  });
}

// ---------------------------------------------------------------- reading ---

export async function listGenerations(input: {
  designId?: string;
  customerId?: string;
  branchId?: string;
  limit?: number;
}) {
  const tenantId = requireTenantId();
  return prisma.hairGeneration.findMany({
    where: {
      tenantId,
      ...optionalBranchFilter(input.branchId),
      ...(input.designId ? { designId: input.designId } : {}),
      ...(input.customerId ? { customerId: input.customerId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 50,
    select: publicFields,
  });
}

export async function getGeneration(id: string) {
  const tenantId = requireTenantId();
  const generation = await prisma.hairGeneration.findFirst({ where: { id, tenantId }, select: publicFields });
  if (!generation) throw NotFound('Generated picture not found');
  return generation;
}

/**
 * What a client is allowed to see.
 *
 * `pollingUrl` and `providerId` are deliberately absent: they are our side of a
 * paid account, they identify a request to the provider, and nothing on a screen
 * needs them. The prompt IS included — a salon is entitled to know what was said
 * on its behalf, and a stylist reading it is how the wording gets better.
 */
const publicFields = {
  id: true,
  kind: true,
  status: true,
  prompt: true,
  model: true,
  seed: true,
  imageUrl: true,
  width: true,
  height: true,
  error: true,
  designId: true,
  catalogId: true,
  customerId: true,
  analysisId: true,
  inputImageUrl: true,
  createdAt: true,
  readyAt: true,
} as const;

/**
 * How much of today's allowance is left, for the screen that spends it.
 *
 * Shown rather than discovered: a stylist who finds out about the cap by being
 * refused mid-consultation has already told the customer they would show them
 * something.
 */
export async function generationStatus() {
  const tenantId = requireTenantId();
  const since = startOfDay(new Date());
  const usedToday = await prisma.hairGeneration.count({
    where: { tenantId, createdAt: { gte: since }, status: { not: 'PENDING' } },
  });

  return {
    ...flux.describe(),
    dailyLimit: env.BFL_DAILY_LIMIT_PER_TENANT,
    usedToday,
    remainingToday: env.BFL_DAILY_LIMIT_PER_TENANT === 0 ? null : Math.max(0, env.BFL_DAILY_LIMIT_PER_TENANT - usedToday),
  };
}

/**
 * RESCUE FOR ROWS THE QUEUE DROPPED.
 *
 * Every wait in this feature is a scheduled job, and a job is a database row
 * that something can delete — a deploy mid-flight, a failed enqueue, an operator
 * clearing the queue. The row then sits at SUBMITTED for ever with a finished
 * picture at the other end of it, expiring.
 *
 * So anything submitted a while ago and still unfinished gets one more poll
 * booked. Cheap, idempotent through the unique key, and the difference between a
 * feature that loses pictures occasionally and one that does not.
 */
export async function sweepStalledGenerations(): Promise<number> {
  const stalled = await runUnscoped(() =>
    prisma.hairGeneration.findMany({
      where: { status: 'SUBMITTED', submittedAt: { lt: dayjs().subtract(5, 'minute').toDate() } },
      select: { id: true, tenantId: true, polls: true },
      take: 50,
    }),
  );

  for (const row of stalled) {
    if (row.polls >= env.BFL_MAX_POLLS) {
      await fail(row.id, 'The image provider did not finish this in time. Nothing was lost — try again.', null);
      continue;
    }
    await schedulePoll(row.id, row.tenantId, row.polls);
  }

  // PENDING rows are the same problem one step earlier: accepted, never sent.
  const unsent = await runUnscoped(() =>
    prisma.hairGeneration.findMany({
      where: { status: 'PENDING', createdAt: { lt: dayjs().subtract(5, 'minute').toDate() } },
      select: { id: true, tenantId: true },
      take: 50,
    }),
  );

  for (const row of unsent) {
    await enqueue(
      'hair.generate.submit',
      { generationId: row.id },
      { tenantId: row.tenantId, uniqueKey: `hair.generate:retry:${row.id}:${dayjs().format('YYYYMMDDHH')}` },
    );
  }

  const total = stalled.length + unsent.length;
  if (total) logger.warn({ stalled: stalled.length, unsent: unsent.length }, 're-queued hair generations the queue lost');
  return total;
}

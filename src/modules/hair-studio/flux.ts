import { env, fluxReady } from '../../config/env';
import { logger } from '../../core/logger';

/**
 * BLACK FOREST LABS, THE ONLY PLACE THAT TALKS TO IT.
 *
 * ── The shape of the thing ────────────────────────────────────────────────
 *
 * Nothing here is request/response. Generating a picture is:
 *
 *   POST /v1/<model>        → { id, polling_url }      (returns in ~200ms)
 *   GET  <polling_url>      → { status: "Pending" }    (for 10-60 seconds)
 *   GET  <polling_url>      → { status: "Ready", result: { sample: <url> } }
 *   GET  <that url>         → the actual bytes, for a little while
 *
 * Three facts drive every decision in this file:
 *
 *   1. The polling address is HANDED BACK, not built. BFL answers from regional
 *      datacentres and a request submitted to one is invisible to another, so a
 *      url assembled from BFL_API_URL asks the wrong building and is told the
 *      request does not exist. We store what we are given.
 *   2. The result url EXPIRES, within about the hour. A row that kept it shows
 *      the salon a broken image the next morning, long after anyone connects the
 *      two. The bytes are downloaded and re-hosted before anything is saved.
 *   3. A refusal is not an error. "Request Moderated" and "Content Moderated"
 *      will never succeed on retry and need different words on screen; a 500 and
 *      a timeout will probably succeed in a minute. Collapsing the two is how a
 *      queue ends up retrying something forever.
 *
 * ── The key ───────────────────────────────────────────────────────────────
 *
 * Goes in the `x-key` header and nowhere else — never a query parameter, never
 * a log line, never into the browser. `describe()` exists so that health and
 * startup can report whether it is configured without anything being able to
 * print it by accident.
 */

/** The only hosts this file will send the key to. See `trustedPollingUrl`. */
const ALLOWED_HOSTS = /(^|\.)bfl\.ai$|(^|\.)bfl\.ml$/i;

export type FluxStatus = 'pending' | 'ready' | 'refused' | 'failed' | 'missing';

export interface FluxSubmitResult {
  providerId: string;
  pollingUrl: string;
}

export interface FluxPollResult {
  status: FluxStatus;
  /** Set only when ready. Temporary — download it now, not later. */
  sampleUrl?: string;
  /** A sentence for a human, when something went wrong. */
  detail?: string;
}

/**
 * Whether the provider has actually answered, as against being configured.
 *
 * The same distinction the feedback model taught us: a key that is PRESENT and a
 * key that WORKS are different facts, and only the second one is worth putting
 * on a health page. Null means nothing has been tried yet.
 */
let answered = false;
let configBroken: string | null = null;

export function fluxVerified(): boolean | null {
  if (configBroken) return false;
  return answered ? true : null;
}

/** What may safely be said about the configuration. Never the key. */
export function describe(): { configured: boolean; model: string; endpoint: string; verified: boolean | null } {
  return {
    configured: fluxReady,
    model: env.BFL_MODEL,
    endpoint: env.BFL_API_URL,
    verified: fluxVerified(),
  };
}

/**
 * IS THIS ADDRESS ONE WE WILL ATTACH THE KEY TO?
 *
 * The polling url arrives in a response body, which makes it input from outside
 * — and the next thing we do with it is send the API key there. A provider
 * having a bad day, a proxy in between, or an injected response is then enough
 * to walk the key off to another host, and nothing in the logs would look wrong.
 *
 * So the host is checked against the provider's own domains before the key goes
 * anywhere near it. Exported for the test, because this is the one function here
 * whose failure is silent and expensive.
 */
export function trustedPollingUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.test(url.hostname)) return null;
  return url;
}

/**
 * Map the provider's status word onto something the rest of the app can switch
 * on. Pure, and the reason the service has no string comparisons in it.
 *
 * An unknown word counts as pending rather than as a failure: BFL has added
 * statuses before, and treating a new one as fatal would throw away a picture
 * that was on its way.
 */
export function classifyStatus(word: string | undefined): FluxStatus {
  switch ((word ?? '').trim()) {
    case 'Ready':
      return 'ready';
    case 'Request Moderated':
    case 'Content Moderated':
      return 'refused';
    case 'Error':
      return 'failed';
    case 'Task not found':
      return 'missing';
    default:
      return 'pending';
  }
}

/**
 * Why a status code means what it does.
 *
 * 401/403/404 are a setting somebody has to change — a wrong key, a model this
 * account cannot use — and they are logged loudly once, because the alternative
 * is a feature that is silently off for days while looking unbuilt. 429 and 5xx
 * are weather: quiet, and worth retrying.
 */
function noteFailure(status: number, detail: string): void {
  if ([400, 401, 403, 404].includes(status)) {
    configBroken = detail;
    logger.error(
      { status, detail, model: env.BFL_MODEL, endpoint: env.BFL_API_URL, set: 'BFL_API_KEY / BFL_MODEL' },
      'hair image generation is MISCONFIGURED and every call will fail until a setting changes',
    );
  } else {
    logger.warn({ status, detail }, 'hair image generation: provider refused this call');
  }
}

export interface SubmitOptions {
  prompt: string;
  /** Same seed, same prompt, same face. This is how a model stays one person. */
  seed?: number;
  width?: number;
  height?: number;
  /**
   * For an edit rather than a fresh portrait: the image to work from, as raw
   * bytes. Sent base64-encoded, which is what the provider accepts.
   */
  inputImage?: Buffer;
  /** Anything the provider should not draw. */
  negativePrompt?: string;
}

/**
 * Hand the work over. Returns in a fraction of a second or not at all.
 *
 * Throws rather than returning null, unlike `core/ai.ts`: there the caller has
 * nothing to store and genuinely does not care why, whereas here the row that
 * recorded the request is sitting in the database waiting to be told what
 * happened, and "it failed" and "it was refused" lead to different columns.
 */
export async function submit(options: SubmitOptions): Promise<FluxSubmitResult> {
  if (!fluxReady) throw new FluxError('Image generation is not set up on this server yet.', 'config');

  const body: Record<string, unknown> = {
    prompt: options.prompt,
    /**
     * Square by default, and the aspect ratio is a product decision rather than
     * a default worth inheriting: every one of these is a head, shown in a grid
     * next to other heads. A 16:9 portrait is mostly wall.
     */
    width: options.width ?? 1024,
    height: options.height ?? 1024,
    output_format: 'jpeg',
    /**
     * ASK FOR THE STRICTEST SAFETY SETTING, NOT THE LOOSEST.
     *
     * These pictures are faces, generated by a salon, shown to customers. The
     * cost of an over-cautious refusal is one retry with different words; the
     * cost of the other mistake is on a salon's wall.
     */
    safety_tolerance: 2,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
    ...(options.inputImage ? { input_image: options.inputImage.toString('base64') } : {}),
  };

  const response = await call(`${env.BFL_API_URL}/v1/${encodeURIComponent(env.BFL_MODEL)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const payload = (await json(response)) as { id?: string; polling_url?: string; detail?: unknown } | null;

  if (!response.ok || !payload?.id) {
    const detail = readDetail(payload) ?? `The image provider answered ${response.status}.`;
    noteFailure(response.status, detail);
    throw new FluxError(detail, [400, 401, 403, 404].includes(response.status) ? 'config' : 'transient');
  }

  /**
   * A missing polling_url is not fatal — the documented fallback is
   * /v1/get_result?id=<id> on the same host we just posted to, which is the
   * right host by construction.
   */
  const pollingUrl = payload.polling_url ?? `${env.BFL_API_URL}/v1/get_result?id=${encodeURIComponent(payload.id)}`;

  if (!trustedPollingUrl(pollingUrl)) {
    /**
     * Refused rather than followed. The request has been accepted and will be
     * billed, and that is the lesser loss: following an address outside the
     * provider's domains means handing the key to whoever supplied it.
     */
    logger.error({ host: safeHost(pollingUrl) }, 'image provider returned a polling address outside its own domains');
    throw new FluxError('The image provider answered with an address we do not trust.', 'config');
  }

  answered = true;
  configBroken = null;
  return { providerId: payload.id, pollingUrl };
}

/**
 * Ask whether it is done. One HTTP call, no waiting, no loop.
 *
 * The loop lives in the job queue, as a job that re-schedules itself, for a
 * reason worth writing down: this worker runs every job in the system one after
 * another in a single pass. A function here that slept for forty seconds would
 * hold up every appointment reminder behind it.
 */
export async function poll(pollingUrl: string): Promise<FluxPollResult> {
  const url = trustedPollingUrl(pollingUrl);
  if (!url) return { status: 'failed', detail: 'The stored polling address is not one we trust.' };

  const response = await call(url.toString(), { method: 'GET' });
  const payload = (await json(response)) as
    | { status?: string; result?: { sample?: string }; detail?: unknown }
    | null;

  if (!response.ok) {
    const detail = readDetail(payload) ?? `The image provider answered ${response.status}.`;
    noteFailure(response.status, detail);
    // 404 while polling means the request aged out of the provider's store,
    // which is nothing to do with configuration and cannot be waited out.
    return { status: response.status === 404 ? 'missing' : 'failed', detail };
  }

  const status = classifyStatus(payload?.status);
  if (status === 'ready') {
    const sampleUrl = payload?.result?.sample;
    if (!sampleUrl) return { status: 'failed', detail: 'The provider reported a finished image but sent no address.' };
    answered = true;
    configBroken = null;
    return { status: 'ready', sampleUrl };
  }

  return { status, detail: status === 'pending' ? undefined : (readDetail(payload) ?? payload?.status) };
}

/**
 * Fetch the finished picture.
 *
 * Deliberately WITHOUT the API key: the sample url is a pre-signed address on a
 * storage host, it needs no credential, and sending one to whatever hostname
 * came back in a response body is exactly the mistake `trustedPollingUrl`
 * exists to prevent. The bytes are checked by the caller before being stored.
 */
export async function download(sampleUrl: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(sampleUrl);
  } catch {
    throw new FluxError('The provider sent an address that is not a url.', 'transient');
  }
  if (url.protocol !== 'https:') throw new FluxError('The provider sent an insecure image address.', 'transient');

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(env.BFL_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new FluxError(`The finished image could not be fetched (${response.status}).`, 'transient');
  }

  /**
   * Bounded by the declared length before anything is read, and again by the
   * byte check afterwards. A worker that happily buffers whatever a third party
   * decides to send it is one bad response away from being killed by the
   * container's memory limit, taking every other queued job with it.
   */
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > 20 * 1024 * 1024) throw new FluxError('The finished image was implausibly large.', 'transient');

  return Buffer.from(await response.arrayBuffer());
}

// ------------------------------------------------------------- plumbing -----

/** A failure with a verdict attached: can retrying possibly help? */
export class FluxError extends Error {
  constructor(
    message: string,
    /**
     * Named `reason` rather than `cause`, which is already a property of Error
     * with an entirely different meaning (the underlying error) — overriding it
     * with a string would be a quiet lie to anything that logs errors generically.
     */
    readonly reason: 'config' | 'transient' | 'refused',
  ) {
    super(message);
    this.name = 'FluxError';
  }
}

async function call(url: string, init: { method: string; body?: string }): Promise<Response> {
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        // The key, in a header, and this is the only line in the codebase that
        // reads it.
        'x-key': env.BFL_API_KEY,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
      // Cancels the request rather than racing it, so a slow provider stops
      // holding a socket as well as a worker slot.
      signal: AbortSignal.timeout(env.BFL_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ detail, host: safeHost(url) }, 'hair image generation: call did not complete');
    throw new FluxError('The image provider could not be reached.', 'transient');
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The provider's own words, when it has any.
 *
 * `detail` is sometimes a string and sometimes FastAPI's array of validation
 * objects, which is why this is a function rather than a property read — the
 * array stringifies to `[object Object]` and that is what a salon owner would
 * have seen on screen.
 */
function readDetail(payload: unknown): string | null {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 300);
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => (typeof item === 'object' && item && 'msg' in item ? String((item as { msg: unknown }).msg) : null))
      .filter(Boolean);
    if (parts.length) return parts.join('; ').slice(0, 300);
  }
  return null;
}

/** Host only, for logs. A full url can carry a signature in its query. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
}

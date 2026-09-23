import type { MessageTemplate } from '@prisma/client';
import { env } from '../config/env';
import { isFillable, isUnmapped } from './whatsapp-template-format';
import type { MetaComponent, MetaTemplatePayload } from './whatsapp-template-format';

export {
  KNOWN_VARIABLES,
  fromMetaComponents,
  guessVariable,
  isFillable,
  isUnmapped,
  SAMPLE_VALUES,
  templateProblems,
  toMetaTemplate,
  type Converted,
  type MetaComponent,
  type MetaTemplatePayload,
} from './whatsapp-template-format';

/**
 * TALKING TO META ABOUT TEMPLATES.
 *
 * The conversion lives in ./whatsapp-template-format, which has no imports and
 * no side effects so it can be tested on its own. This file is the part that
 * touches the network.
 */

// ------------------------------------------------------------- the calls ---

export interface MetaCredentials {
  accessToken: string;
  wabaId: string;
}

/** Meta's answer, kept whole. The message is theirs, not a paraphrase. */
export interface MetaResult<T> {
  ok: boolean;
  data?: T;
  error?: { message: string; code?: number; subcode?: number; type?: string; detail?: string };
  /** The HTTP status, for the cases where Meta returns no error body at all. */
  status: number;
}

interface MetaError {
  error?: { message: string; code?: number; error_subcode?: number; type?: string; error_user_msg?: string };
}

async function call<T>(url: string, init: RequestInit, credentials: MetaCredentials): Promise<MetaResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const json = (await response.json().catch(() => ({}))) as T & MetaError;

    if (!response.ok || json.error) {
      return {
        ok: false,
        status: response.status,
        error: {
          // error_user_msg is the sentence Meta writes for a human; message is
          // the developer one. Prefer the human sentence, keep the other.
          message: json.error?.error_user_msg || json.error?.message || `Meta returned ${response.status}`,
          detail: json.error?.error_user_msg ? json.error?.message : undefined,
          code: json.error?.code,
          subcode: json.error?.error_subcode,
          type: json.error?.type,
        },
      };
    }

    return { ok: true, status: response.status, data: json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: { message: err instanceof Error ? err.message : 'Could not reach Meta' },
    };
  }
}

export interface SubmitResponse {
  id: string;
  status: string;
  category?: string;
}

/** Send a template up for review. Meta answers with an id and PENDING. */
export function submitTemplate(payload: MetaTemplatePayload, credentials: MetaCredentials) {
  return call<SubmitResponse>(
    `${env.WHATSAPP_API_URL}/${credentials.wabaId}/message_templates`,
    { method: 'POST', body: JSON.stringify(payload) },
    credentials,
  );
}

export interface MetaTemplateRow {
  id: string;
  name: string;
  status: string;
  category?: string;
  language?: string;
  rejected_reason?: string;
  components?: MetaComponent[];
}

/**
 * Every template on the account.
 *
 * Paged, and the pages are followed — a salon with more than a hundred
 * templates that silently syncs only the first hundred is worse than one that
 * does not sync at all, because the missing ones look deleted.
 */
export async function listTemplates(credentials: MetaCredentials): Promise<MetaResult<{ data: MetaTemplateRow[] }>> {
  const rows: MetaTemplateRow[] = [];
  let url =
    `${env.WHATSAPP_API_URL}/${credentials.wabaId}/message_templates` +
    `?fields=id,name,status,category,language,rejected_reason,components&limit=100`;

  for (let page = 0; page < 20; page += 1) {
    const result = await call<{ data: MetaTemplateRow[]; paging?: { next?: string } }>(url, { method: 'GET' }, credentials);
    if (!result.ok) return result as MetaResult<{ data: MetaTemplateRow[] }>;

    rows.push(...(result.data?.data ?? []));
    const next = result.data?.paging?.next;
    if (!next) break;
    url = next;
  }

  return { ok: true, status: 200, data: { data: rows } };
}

/**
 * Meta's statuses mapped onto ours.
 *
 * PAUSED and DISABLED are the two that matter and the two most likely to be
 * skipped: Meta pauses a template whose quality rating drops and disables it if
 * that continues. Folding either into APPROVED means the app keeps queueing
 * messages against a template that will not send.
 */
export function mapStatus(metaStatus: string): 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' {
  switch (metaStatus.toUpperCase()) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'PAUSED':
      return 'PAUSED';
    case 'DISABLED':
    case 'PENDING_DELETION':
    case 'DELETED':
      return 'DISABLED';
    default:
      return 'PENDING';
  }
}

/** True when this template can carry a message to a customer right now. */
export function isSendable(template: Pick<MessageTemplate, 'approvalStatus' | 'channel'>): boolean {
  if (template.channel !== 'WHATSAPP') return true;
  return template.approvalStatus === 'APPROVED';
}

/**
 * Why this template cannot be sent, in words a salon owner can act on, or null.
 *
 * One function for campaigns and automations both. They used to disagree:
 * campaigns logged a warning and carried on, automations checked nothing at
 * all. Either way the salon found out when a month of reminders had gone
 * nowhere, because a WhatsApp send against an unapproved template fails at the
 * provider, inside a job, hours later.
 */
/**
 * A template whose placeholders name things we cannot fill.
 *
 * On WhatsApp this is fatal rather than untidy: Meta counts the parameters it
 * expects, so one unfillable name means every send of that template fails, one
 * message at a time, in a job. Imported templates carry unmapped_N names
 * precisely so they land here instead of going out wrong.
 */
export function unfillableVariables(variables: string[]): string[] {
  return variables.filter((v) => !isFillable(v));
}

export function sendabilityProblem(
  template: Pick<MessageTemplate, 'approvalStatus' | 'channel' | 'name' | 'providerTemplateName'> & {
    rejectedReason?: string | null;
    variables?: string[];
    metaVariableOrder?: string[];
  },
): string | null {
  if (template.channel !== 'WHATSAPP') return null;

  const unfillable = unfillableVariables(
    template.metaVariableOrder?.length ? template.metaVariableOrder : (template.variables ?? []),
  );
  if (unfillable.length > 0) {
    const positions = unfillable.filter(isUnmapped);
    return positions.length > 0
      ? `"${template.name}" was imported from Meta and ${positions.length === 1 ? 'one placeholder was' : `${positions.length} placeholders were`} not matched to a customer field (${positions.join(', ')}). Open it and replace ${positions.length === 1 ? 'it' : 'them'} with a real field, or every message will be rejected.`
      : `"${template.name}" uses ${unfillable.join(', ')}, which nothing fills. Every send would be rejected for a parameter mismatch. Replace ${unfillable.length === 1 ? 'it' : 'them'} with a field the app knows.`;
  }

  switch (template.approvalStatus) {
    case 'APPROVED':
      // Approved by Meta but never linked to a name there is the same failure
      // wearing a better badge: the send falls back to free-form text, which
      // Meta refuses outside the 24-hour window.
      return template.providerTemplateName
        ? null
        : `"${template.name}" is marked approved but has no Meta template name, so WhatsApp would refuse it. Press Sync with Meta to fill it in.`;
    case 'DRAFT':
      return `"${template.name}" has never been sent to Meta for review, and WhatsApp only delivers approved templates. Open it and press Submit to Meta — or Sync, if you created it in Business Manager already.`;
    case 'PENDING':
      return `"${template.name}" is still in review with Meta. It usually takes minutes to a few hours; press Sync with Meta to check.`;
    case 'REJECTED':
      return `Meta rejected "${template.name}"${template.rejectedReason ? `: ${template.rejectedReason}` : ''}. A rejected template cannot be sent, and it cannot be renamed — write a new one.`;
    case 'PAUSED':
      return `Meta has paused "${template.name}" because too many customers reported messages like it. It will not send until Meta lifts the pause.`;
    case 'DISABLED':
      return `Meta has disabled "${template.name}". It cannot be used again — write a new one.`;
    default:
      return `"${template.name}" is not approved by Meta, so WhatsApp will not deliver it.`;
  }
}

// ------------------------------------------------------------ diagnosis ---

export interface ProbeResult {
  step: string;
  what: string;
  ok: boolean;
  detail: string;
}

/**
 * ASK META WHAT THIS TOKEN CAN ACTUALLY SEE.
 *
 * Error 100/33 — "does not exist, cannot be loaded due to missing permissions,
 * or does not support this operation" — is one message covering four unrelated
 * causes, and Meta will not say which, because confirming an object exists to a
 * token that cannot see it would let anyone enumerate ids.
 *
 * So take the question apart. Each call below fails independently, and which
 * ones fail names the cause:
 *
 *   token invalid            → every probe fails
 *   wrong WABA id, or the
 *   System User is in another
 *   business portfolio       → identity passes, WABA fails
 *   missing management scope → WABA passes, templates fail
 *   everything fine          → all pass, and the problem is the payload
 *
 * Read-only throughout: nothing here creates, changes or sends anything.
 */
export async function probeAccess(credentials: MetaCredentials, phoneNumberId?: string | null): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  const identity = await call<{ id: string; name?: string }>(
    `${env.WHATSAPP_API_URL}/me?fields=id,name`,
    { method: 'GET' },
    credentials,
  );
  results.push({
    step: 'token',
    what: 'Is the access token valid at all?',
    ok: identity.ok,
    detail: identity.ok
      ? `Valid. Meta knows it as ${identity.data?.name ?? 'an unnamed system user'} (${identity.data?.id}).`
      : (identity.error?.message ?? 'No answer'),
  });

  const waba = await call<{ id: string; name?: string }>(
    `${env.WHATSAPP_API_URL}/${credentials.wabaId}?fields=id,name`,
    { method: 'GET' },
    credentials,
  );
  results.push({
    step: 'waba',
    what: `Can it see WhatsApp Business Account ${credentials.wabaId}?`,
    ok: waba.ok,
    detail: waba.ok
      ? `Yes — "${waba.data?.name ?? credentials.wabaId}".`
      : `${waba.error?.message ?? 'No answer'}${
          waba.error?.subcode === 33
            ? ' — this is Meta saying the token cannot see that object. Either the id is not a WhatsApp Business Account, or the System User holding this token has not been assigned that account as an asset, or the System User belongs to a different Business Portfolio.'
            : ''
        }`,
  });

  const templates = await call<{ data: unknown[] }>(
    `${env.WHATSAPP_API_URL}/${credentials.wabaId}/message_templates?limit=1`,
    { method: 'GET' },
    credentials,
  );
  results.push({
    step: 'templates',
    what: 'Can it read and write templates on that account?',
    ok: templates.ok,
    detail: templates.ok
      ? 'Yes. Submitting a template should work.'
      : `${templates.error?.message ?? 'No answer'} — if the account check above passed but this one failed, the token is missing the whatsapp_business_management permission. Sending only needs whatsapp_business_messaging, so a messaging-only token sends fine and cannot touch templates.`,
  });

  /**
   * The decisive one: which accounts is this token ACTUALLY scoped to?
   *
   * Meta will not say whether a given id exists, but it will happily describe
   * the token you already hold — and granular_scopes lists the exact target ids
   * each permission was granted over. When the configured WABA is not in that
   * list, the list contains the id that should have been configured, which
   * turns "does not exist" into a value to copy.
   *
   * Returns nothing useful for some token types, so a failure here is reported
   * as unknown rather than as a fault.
   */
  const debug = await call<{
    data?: { granular_scopes?: { scope: string; target_ids?: string[] }[]; scopes?: string[]; app_id?: string };
  }>(
    `${env.WHATSAPP_API_URL}/debug_token?input_token=${encodeURIComponent(credentials.accessToken)}`,
    { method: 'GET' },
    credentials,
  );

  const granular = debug.data?.data?.granular_scopes ?? [];
  const management = granular.find((g) => g.scope === 'whatsapp_business_management');
  const messaging = granular.find((g) => g.scope === 'whatsapp_business_messaging');
  const reachable = [...new Set([...(management?.target_ids ?? []), ...(messaging?.target_ids ?? [])])];
  const scopes = debug.data?.data?.scopes ?? granular.map((g) => g.scope);

  /**
   * Informational, never a verdict.
   *
   * An EMPTY target_ids list does not mean the token reaches no accounts — it
   * means Meta did not scope-limit it, which is what a System User with
   * business_management looks like and is stronger, not weaker. The first
   * version of this read empty as "not created against a WhatsApp Business
   * Account at all" and told somebody to go and make a token they had already
   * made, directly underneath two probes that had just succeeded.
   *
   * So this probe only ever contradicts the others when it has positive
   * evidence: a target list that exists and excludes the configured account.
   * The probes above actually attempted the operation; an attempt beats an
   * inference about an attempt.
   */
  const limited = reachable.length > 0;
  const wabaReachable = results.find((r) => r.step === 'waba')?.ok ?? false;

  results.push({
    step: 'scopes',
    what: 'Which WhatsApp accounts is this token scoped to?',
    ok: limited ? reachable.includes(credentials.wabaId) : wabaReachable,
    detail: !debug.ok
      ? `Meta would not describe this token (${debug.error?.message ?? 'no answer'}). Normal for some token types, and not a fault — the checks above tested the real thing.`
      : limited
        ? reachable.includes(credentials.wabaId)
          ? `${credentials.wabaId}, which is the one configured. Permissions: ${scopes.join(', ') || 'none listed'}.`
          : `${reachable.join(', ')} — and NOT the configured ${credentials.wabaId}. Put ${
              reachable.length === 1 ? reachable[0] : 'the right one of those'
            } in WHATSAPP_WABA_ID (or the WhatsApp Business Account ID field) and try again.`
        : `Not restricted to particular accounts — it carries ${
            scopes.join(', ') || 'no listed permissions'
          } across the whole business, which is normal for a System User token.${
            wabaReachable ? '' : ' The account check above still failed, so the token has the permissions but not this account as an assigned asset.'
          }`,
  });

  if (phoneNumberId) {
    const phone = await call<{ display_phone_number?: string; verified_name?: string }>(
      `${env.WHATSAPP_API_URL}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { method: 'GET' },
      credentials,
    );
    results.push({
      step: 'phone',
      what: `Can it send from phone number ${phoneNumberId}?`,
      ok: phone.ok,
      detail: phone.ok
        ? `Yes — ${phone.data?.display_phone_number ?? 'number'} as "${phone.data?.verified_name ?? 'unverified'}".`
        : (phone.error?.message ?? 'No answer'),
    });
  }

  return results;
}

import type { MessageTemplate } from '@prisma/client';
import { env } from '../config/env';
import type { MetaTemplatePayload } from './whatsapp-template-format';

export {
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
    `?fields=id,name,status,category,language,rejected_reason&limit=100`;

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
export function sendabilityProblem(
  template: Pick<MessageTemplate, 'approvalStatus' | 'channel' | 'name' | 'providerTemplateName'> & {
    rejectedReason?: string | null;
  },
): string | null {
  if (template.channel !== 'WHATSAPP') return null;

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

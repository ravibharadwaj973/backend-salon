import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { env } from '../../config/env';
import {
  listTemplates as listMetaTemplates,
  mapStatus,
  submitTemplate,
  toMetaTemplate,
  type MetaCredentials,
} from '../../messaging/whatsapp-templates';

/**
 * THE APP AND META, KEPT IN AGREEMENT ABOUT TEMPLATES.
 *
 * Before this, a template's approvalStatus was whatever somebody typed. Meta
 * was the only thing that actually knew, and nothing asked it — so a salon
 * could have a template marked Approved in Parlon that Meta had rejected a week
 * earlier, and find out when a month of appointment reminders had quietly gone
 * nowhere.
 *
 * Two directions, both explicit and both started by a person pressing a button:
 *
 *   submit — our template goes up for review
 *   sync   — Meta's verdict comes back
 *
 * Neither happens automatically. Submitting is irreversible in a way that
 * matters (a template cannot be renamed afterwards, and deleting one to fix a
 * name restarts review), so it is not something to do on a salon's behalf while
 * they are typing.
 */

// ------------------------------------------------------------ credentials --

interface ResolvedCredentials {
  credentials: MetaCredentials | null;
  source: 'tenant' | 'environment' | 'none';
  missing: string | null;
}

/**
 * Same order of preference as sending: the salon's own account first.
 *
 * A template submitted with the platform's credentials lands on the PLATFORM's
 * WABA, not the salon's — where the salon cannot see it and cannot send it from
 * their own number. Worth being exact about, because the failure is invisible:
 * the submission succeeds.
 */
export async function resolveTemplateCredentials(tenantId: string): Promise<ResolvedCredentials> {
  const config = await runUnscoped(() => prisma.tenantMessagingConfig.findUnique({ where: { tenantId } }));

  if (config?.waAccessToken && config.waBusinessId) {
    return {
      credentials: { accessToken: config.waAccessToken, wabaId: config.waBusinessId },
      source: 'tenant',
      missing: null,
    };
  }

  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_WABA_ID) {
    return {
      credentials: { accessToken: env.WHATSAPP_ACCESS_TOKEN, wabaId: env.WHATSAPP_WABA_ID },
      source: 'environment',
      missing: null,
    };
  }

  const missing = [
    !config?.waBusinessId && !env.WHATSAPP_WABA_ID ? 'the WhatsApp Business Account ID' : null,
    !config?.waAccessToken && !env.WHATSAPP_ACCESS_TOKEN ? 'the access token' : null,
  ].filter(Boolean);

  return {
    credentials: null,
    source: 'none',
    missing: missing.length ? missing.join(' and ') : null,
  };
}

// ---------------------------------------------------------------- submit ---

export interface SubmitOutcome {
  ok: boolean;
  /** What we sent, so a rejection can be read against the actual submission. */
  sent?: { name: string; language: string; category: string; body: string };
  /** Meta's answer, unedited. */
  meta?: { id?: string; status?: string; message?: string; code?: number; subcode?: number };
  problems?: string[];
  source?: string;
}

export async function submitTemplateToMeta(templateId: string): Promise<SubmitOutcome> {
  const tenantId = requireTenantId();
  const template = await prisma.messageTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw NotFound('Message template');

  if (template.channel !== 'WHATSAPP') {
    throw BadRequest(
      `Only WhatsApp templates are reviewed by Meta. ${template.channel.toLowerCase()} messages can be sent as written.`,
    );
  }

  if (template.providerTemplateId) {
    throw BadRequest(
      'This template has already been submitted. Meta does not accept a second submission under the same name — ' +
        'use Sync to refresh its status, or create a new template with a different name.',
    );
  }

  const { credentials, source, missing } = await resolveTemplateCredentials(tenantId);
  if (!credentials) {
    throw BadRequest(
      `WhatsApp is not connected, so there is nowhere to submit this.${missing ? ` What is missing: ${missing}.` : ''}`,
    );
  }

  const { payload, variableOrder, problems } = toMetaTemplate(template);

  // Refused here rather than by Meta. The difference matters: a rejection
  // consumes the name, and a template cannot be renamed afterwards.
  if (problems.length > 0) {
    return { ok: false, problems, source };
  }

  const result = await submitTemplate(payload, credentials);
  const bodyComponent = payload.components.find((c) => c.type === 'BODY');
  const sent = {
    name: payload.name,
    language: payload.language,
    category: payload.category,
    body: bodyComponent?.text ?? '',
  };

  if (!result.ok) {
    return {
      ok: false,
      sent,
      source,
      meta: {
        message: result.error?.message,
        code: result.error?.code,
        subcode: result.error?.subcode,
      },
    };
  }

  await prisma.messageTemplate.update({
    where: { id: templateId },
    data: {
      providerTemplateName: payload.name,
      providerTemplateId: result.data?.id ?? null,
      approvalStatus: mapStatus(result.data?.status ?? 'PENDING'),
      metaVariableOrder: variableOrder,
      rejectedReason: null,
      submittedAt: new Date(),
      syncedAt: new Date(),
    },
  });

  return {
    ok: true,
    sent,
    source,
    meta: { id: result.data?.id, status: result.data?.status },
  };
}

// ------------------------------------------------------------------ sync ---

export interface SyncOutcome {
  ok: boolean;
  checked: number;
  updated: { name: string; from: string; to: string; rejectedReason: string | null }[];
  /** On Meta but not here — usually written in Business Manager by hand. */
  onlyOnMeta: { name: string; status: string; language: string }[];
  /** Here but never submitted. These are the ones that cannot send. */
  notSubmitted: string[];
  source?: string;
  error?: string;
}

export async function syncTemplatesFromMeta(): Promise<SyncOutcome> {
  const tenantId = requireTenantId();
  const { credentials, source, missing } = await resolveTemplateCredentials(tenantId);

  if (!credentials) {
    throw BadRequest(
      `WhatsApp is not connected, so there is nothing to sync with.${missing ? ` What is missing: ${missing}.` : ''}`,
    );
  }

  const result = await listMetaTemplates(credentials);
  if (!result.ok) {
    return {
      ok: false,
      checked: 0,
      updated: [],
      onlyOnMeta: [],
      notSubmitted: [],
      source,
      error: result.error?.message ?? 'Meta did not answer',
    };
  }

  const metaRows = result.data?.data ?? [];
  const locals = await prisma.messageTemplate.findMany({ where: { tenantId, channel: 'WHATSAPP' } });

  // Match on the name Meta knows, falling back to ours — which is what a
  // template created in Business Manager by hand will match on.
  const byName = new Map(metaRows.map((row) => [`${row.name}::${(row.language ?? 'en').toLowerCase()}`, row]));
  const claimed = new Set<string>();

  const updated: SyncOutcome['updated'] = [];
  const notSubmitted: string[] = [];

  for (const local of locals) {
    const name = (local.providerTemplateName || local.name).toLowerCase();
    const language = (local.language || 'en').toLowerCase();
    const row = byName.get(`${name}::${language}`) ?? byName.get(`${name}::en`);

    if (!row) {
      if (!local.providerTemplateId) notSubmitted.push(local.name);
      continue;
    }

    claimed.add(row.id);
    const status = mapStatus(row.status);
    const rejectedReason = row.rejected_reason && row.rejected_reason !== 'NONE' ? row.rejected_reason : null;

    if (status === local.approvalStatus && rejectedReason === local.rejectedReason && local.providerTemplateId === row.id) {
      await prisma.messageTemplate.update({ where: { id: local.id }, data: { syncedAt: new Date() } });
      continue;
    }

    await prisma.messageTemplate.update({
      where: { id: local.id },
      data: {
        approvalStatus: status,
        rejectedReason,
        providerTemplateId: row.id,
        providerTemplateName: row.name,
        syncedAt: new Date(),
      },
    });

    updated.push({ name: local.name, from: local.approvalStatus, to: status, rejectedReason });
  }

  return {
    ok: true,
    checked: metaRows.length,
    updated,
    onlyOnMeta: metaRows
      .filter((row) => !claimed.has(row.id))
      .map((row) => ({ name: row.name, status: row.status, language: row.language ?? 'en' })),
    notSubmitted,
    source,
  };
}

import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma';
import { requireTenantId, runUnscoped } from '../../core/context';
import { BadRequest, NotFound } from '../../core/errors';
import { env } from '../../config/env';
import {
  listTemplates as listMetaTemplates,
  mapStatus,
  submitTemplate,
  toMetaTemplate,
  fromMetaComponents,
  type TemplateButton,
  probeAccess,
  type MetaCredentials,
  type ProbeResult,
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
  /** True when Meta already had this name and we linked to it instead. */
  adopted?: boolean;
  /**
   * Set when Meta accepted the template but we failed to record that.
   * Loud on purpose: it is the one outcome where the two sides disagree.
   */
  unsaved?: string;
  /** What we sent, so a rejection can be read against the actual submission. */
  sent?: { name: string; language: string; category: string; body: string };
  /** Meta's answer, unedited. */
  meta?: { id?: string; status?: string; message?: string; code?: number; subcode?: number; hint?: string };
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
      `"${template.name}" is already on your WhatsApp account as ${template.providerTemplateName} ` +
        `(${template.approvalStatus.toLowerCase()}). Meta does not accept a second copy under the same name. ` +
        'Press “Sync with Meta” to refresh its status, or write a new template under a different name — ' +
        'a template cannot be renamed or its wording changed once Meta holds it.',
    );
  }

  const { credentials, source, missing } = await resolveTemplateCredentials(tenantId);
  if (!credentials) {
    throw BadRequest(
      `WhatsApp is not connected, so there is nowhere to submit this.${missing ? ` What is missing: ${missing}.` : ''}`,
    );
  }

  const { payload, variableOrder, problems } = toMetaTemplate({
    ...template,
    buttons: Array.isArray(template.buttons) ? (template.buttons as TemplateButton[]) : [],
  });

  // Refused here rather than by Meta. The difference matters: a rejection
  // consumes the name, and a template cannot be renamed afterwards.
  if (problems.length > 0) {
    return { ok: false, problems, source };
  }

  const bodyComponent = payload.components.find((c) => c.type === 'BODY');
  const sent = {
    name: payload.name,
    language: payload.language,
    category: payload.category,
    body: bodyComponent?.text ?? '',
  };

  /**
   * Record the ATTEMPT before making it.
   *
   * Everything after this line is a side effect on somebody else's system that
   * cannot be undone. If the process dies, the network drops, or the write
   * below fails, this row is the only evidence that Meta may already hold this
   * name — and without it the next press looks like a first attempt and comes
   * back "there is already English content for this template", which reads like
   * a bug in the app rather than a record we lost.
   */
  await prisma.messageTemplate.update({ where: { id: templateId }, data: { submittedAt: new Date() } });

  const result = await submitTemplate(payload, credentials);

  if (!result.ok) {
    /**
     * Meta already has this name. That is not a failure — the thing we wanted
     * to exist exists. Adopt it rather than making somebody press a second
     * button to repair a state they did not cause.
     *
     * This is what makes Submit idempotent: pressing it twice is safe, and a
     * submission whose result we lost heals itself on the next press.
     */
    if (result.error?.subcode === 2388024) {
      const adopted = await adoptExistingTemplate(templateId, payload.name, payload.language, credentials, variableOrder);
      if (adopted) {
        return {
          ok: true,
          adopted: true,
          sent,
          source,
          meta: { id: adopted.id, status: adopted.status },
        };
      }
    }

    return {
      ok: false,
      sent,
      source,
      meta: {
        message: result.error?.message,
        code: result.error?.code,
        subcode: result.error?.subcode,
        // 2388024 is a name collision, not a fault: a template with this name
        // and language is already on the account. It is the one Meta error with
        // an answer better than "fix it and try again" — the thing you wanted
        // exists, and Sync adopts it.
        hint:
          result.error?.subcode === 2388024
            ? 'This name already exists on your WhatsApp account, so Meta refused a second copy. Press “Sync with Meta” — it will adopt the existing one and fill in its status here. Nothing needs submitting.'
            : undefined,
      },
    };
  }

  /**
   * Meta has accepted it. Saving that is now the only thing standing between
   * us and a template that exists there and is unknown here — so a failure to
   * save is reported rather than thrown, together with the id, because the id
   * is the thing that would otherwise be lost forever.
   */
  let unsaved: string | undefined;
  try {
    await prisma.messageTemplate.update({
      where: { id: templateId },
      data: {
        providerTemplateName: payload.name,
        providerTemplateId: result.data?.id ?? null,
        approvalStatus: mapStatus(result.data?.status ?? 'PENDING'),
        metaVariableOrder: variableOrder,
        rejectedReason: null,
        syncedAt: new Date(),
      },
    });
  } catch (err) {
    unsaved =
      `Meta accepted the template (id ${result.data?.id}) but it could not be recorded here: ` +
      `${err instanceof Error ? err.message : 'unknown error'}. The template EXISTS on your WhatsApp account. ` +
      `Press “Sync with Meta” to link it — do not submit it again.`;
  }

  return {
    ok: true,
    sent,
    source,
    unsaved,
    meta: { id: result.data?.id, status: result.data?.status },
  };
}

/**
 * Link a local template to the copy Meta already holds.
 *
 * Used when a submission is refused for a name that exists — including the
 * common case where we submitted it ourselves and lost the answer.
 */
async function adoptExistingTemplate(
  templateId: string,
  name: string,
  language: string,
  credentials: MetaCredentials,
  variableOrder: string[],
): Promise<{ id: string; status: string } | null> {
  const listed = await listMetaTemplates(credentials);
  if (!listed.ok) return null;

  const row = (listed.data?.data ?? []).find(
    (t) => t.name.toLowerCase() === name.toLowerCase() && (t.language ?? 'en').toLowerCase() === language.toLowerCase(),
  );
  if (!row) return null;

  await prisma.messageTemplate.update({
    where: { id: templateId },
    data: {
      providerTemplateName: row.name,
      providerTemplateId: row.id,
      approvalStatus: mapStatus(row.status),
      metaVariableOrder: variableOrder,
      rejectedReason: row.rejected_reason && row.rejected_reason !== 'NONE' ? row.rejected_reason : null,
      syncedAt: new Date(),
    },
  });

  return { id: row.id, status: row.status };
}

// ------------------------------------------------------------------ sync ---

export interface SyncOutcome {
  ok: boolean;
  checked: number;
  updated: { name: string; from: string; to: string; rejectedReason: string | null }[];
  /**
   * On Meta but not here. Carries enough to import: the wording, the category,
   * and how many values a send has to supply.
   */
  onlyOnMeta: { name: string; status: string; language: string; category: string; body: string; parameters: number }[];
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
      .map((row) => {
        const imported = fromMetaComponents(row.components ?? []);
        return {
          name: row.name,
          status: row.status,
          language: row.language ?? 'en',
          category: row.category ?? 'UTILITY',
          body: imported.bodyText,
          parameters: imported.variables.length,
        };
      }),
    notSubmitted,
    source,
  };
}


// ------------------------------------------------------------ diagnosis ---

export interface AccessReport {
  configured: boolean;
  source: 'tenant' | 'environment' | 'none';
  wabaId: string | null;
  phoneNumberId: string | null;
  missing: string | null;
  probes: ProbeResult[];
  /** The one sentence to act on, derived from which probes failed. */
  verdict: string;
}

/**
 * What is actually wrong with this WhatsApp connection.
 *
 * Built because error 100/33 is unfalsifiable from the outside: one message,
 * four causes, and Meta will not narrow it down. Guessing costs an evening per
 * salon, and every salon onboarding hits this.
 */
export async function diagnoseWhatsAppAccess(): Promise<AccessReport> {
  const tenantId = requireTenantId();
  const { credentials, source, missing } = await resolveTemplateCredentials(tenantId);
  const config = await runUnscoped(() => prisma.tenantMessagingConfig.findUnique({ where: { tenantId } }));
  const phoneNumberId = config?.waPhoneNumberId || env.WHATSAPP_PHONE_NUMBER_ID || null;

  if (!credentials) {
    return {
      configured: false,
      source,
      wabaId: null,
      phoneNumberId,
      missing,
      probes: [],
      verdict: `WhatsApp is not connected.${missing ? ` What is missing: ${missing}.` : ''}`,
    };
  }

  const probes = await probeAccess(credentials, phoneNumberId);
  const failed = (step: string) => probes.some((p) => p.step === step && !p.ok);

  // The scopes probe knows the answer when it fires, so it speaks first.
  const scopeProbe = probes.find((p) => p.step === 'scopes');

  const verdict = failed('token')
    ? 'The access token itself is not valid. Generate a new one and paste it in.'
    : scopeProbe && !scopeProbe.ok && scopeProbe.detail.includes('NOT the configured')
      ? scopeProbe.detail
      : failed('waba')
      ? `The token is valid but cannot see ${credentials.wabaId}. Either that id is not a WhatsApp Business Account, or the System User holding the token has not been assigned it — Business Settings → Users → System Users → Assign Assets → WhatsApp Accounts. If the System User sits in a different Business Portfolio than the account, no permission will help; it has to be moved or recreated in the same portfolio.`
      : failed('templates')
        ? 'The token can see the account but not its templates, which means it is missing the whatsapp_business_management permission. Regenerate it with both whatsapp_business_management and whatsapp_business_messaging ticked.'
        : failed('webhooks')
        ? probes.find((p) => p.step === 'webhooks')?.detail ?? 'No app is subscribed to this account, so no delivery receipts will ever arrive.'
      : failed('phone')
          ? 'Templates are reachable but the phone number is not. Check the Phone number ID against the one on Meta\'s API Setup panel.'
          : 'Everything Meta was asked about answered. Templates can be submitted and messages can be sent.';

  return {
    configured: true,
    source,
    wabaId: credentials.wabaId,
    phoneNumberId,
    missing: null,
    probes,
    verdict,
  };
}


// ---------------------------------------------------------------- import ---

export interface ImportOutcome {
  ok: boolean;
  templateId?: string;
  name?: string;
  language?: string;
  status?: string;
  parameters?: number;
  /**
   * Positions whose meaning could not be inferred. Non-empty means the
   * template is created but cannot send until somebody names them.
   */
  unmapped?: number[];
  message: string;
}

/**
 * CREATE A LOCAL TEMPLATE FROM ONE META ALREADY HOLDS.
 *
 * The reverse of submitting, and the lossy direction. Meta stores positions —
 * `Hi {{1}}, your appointment on {{2}}` — and nothing in the API records what
 * those positions were for. The example values are the only clue.
 *
 * So shapes that are unambiguous are mapped (a URL, a time, a date, a sum, or
 * a sample this app itself supplies) and everything else becomes unmapped_N,
 * which nothing fills and which the send guard refuses. Creating a template
 * that looks imported and fails at send would be worse than not importing it,
 * and a confident wrong guess is worse still: it does not look wrong, it just
 * sends one customer another customer's appointment date.
 */
export async function importTemplateFromMeta(input: { name: string; language: string }): Promise<ImportOutcome> {
  const tenantId = requireTenantId();
  const { credentials, missing } = await resolveTemplateCredentials(tenantId);
  if (!credentials) {
    throw BadRequest(`WhatsApp is not connected.${missing ? ` What is missing: ${missing}.` : ''}`);
  }

  const listed = await listMetaTemplates(credentials);
  if (!listed.ok) {
    return { ok: false, message: listed.error?.message ?? 'Meta did not answer' };
  }

  const row = (listed.data?.data ?? []).find(
    (t) =>
      t.name.toLowerCase() === input.name.toLowerCase() &&
      (t.language ?? 'en').toLowerCase() === input.language.toLowerCase(),
  );
  if (!row) {
    return { ok: false, message: `Meta no longer lists a template called ${input.name} in ${input.language}.` };
  }

  const existing = await prisma.messageTemplate.findFirst({
    where: { tenantId, name: row.name, channel: 'WHATSAPP' },
  });
  if (existing) {
    return {
      ok: false,
      templateId: existing.id,
      message: `A template called ${row.name} already exists here. Press “Sync with Meta” to link it rather than importing a second copy.`,
    };
  }

  const imported = fromMetaComponents(row.components ?? []);

  // Meta has no SERVICE category, and AUTHENTICATION templates are a different
  // product; anything unrecognised is a utility message by their taxonomy.
  const category =
    row.category?.toUpperCase() === 'MARKETING'
      ? 'MARKETING'
      : row.category?.toUpperCase() === 'AUTHENTICATION'
        ? 'AUTHENTICATION'
        : 'UTILITY';

  const created = await prisma.messageTemplate.create({
    data: {
      tenantId,
      name: row.name,
      channel: 'WHATSAPP',
      category,
      // Meta's language, not ours. WhatsApp treats it as part of the
      // template's identity, so en where Meta holds en_US fails every send.
      language: row.language ?? 'en',
      providerTemplateName: row.name,
      providerTemplateId: row.id,
      approvalStatus: mapStatus(row.status),
      rejectedReason: row.rejected_reason && row.rejected_reason !== 'NONE' ? row.rejected_reason : null,
      bodyText: imported.bodyText,
      headerText: imported.headerText,
      footerText: imported.footerText,
      buttons: imported.buttons as unknown as Prisma.InputJsonValue,
      variables: imported.variables,
      metaVariableOrder: imported.variables,
      syncedAt: new Date(),
    },
  });

  return {
    ok: true,
    templateId: created.id,
    name: created.name,
    language: created.language,
    status: created.approvalStatus,
    parameters: imported.variables.length,
    unmapped: imported.unmapped,
    message: imported.unmapped.length
      ? `Imported "${row.name}". ${imported.unmapped.length === 1 ? 'One placeholder' : `${imported.unmapped.length} placeholders`} could not be matched to a customer field — open it and replace ${imported.unmapped.map((n) => `{{unmapped_${n}}}`).join(', ')} before using it. It will not send until you do.`
      : `Imported "${row.name}" with ${imported.variables.length} field${imported.variables.length === 1 ? '' : 's'} matched. It is ready to use.`,
  };
}

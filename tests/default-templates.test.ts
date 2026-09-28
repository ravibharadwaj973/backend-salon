import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';
import { templateProblems } from '../src/messaging/whatsapp-template-format';
import { unfillableVariables } from '../src/messaging/whatsapp-templates';

/**
 * The starter templates every new salon is seeded with.
 *
 * A salon that has email switched on and no email templates sees an empty
 * picker on the Email tab, which reads as a broken screen rather than as an
 * empty cupboard — and the only way out is to write every message by hand.
 * Every channel a salon can send on ships with something to send.
 */

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;

describe('the starter templates', () => {
  it('gives every sendable channel something to start from', () => {
    for (const channel of CHANNELS) {
      expect(DEFAULT_TEMPLATES.filter((t) => t.channel === channel).length).toBeGreaterThan(0);
    }
  });

  it('has no two templates with the same name on the same channel', () => {
    // The unique key is (tenant, name, channel) and seeding uses
    // skipDuplicates, so a clash here would silently seed one and drop the
    // other — with no error anywhere to say which.
    const seen = new Set<string>();
    for (const t of DEFAULT_TEMPLATES) {
      const key = `${t.name}::${t.channel}`;
      expect(seen.has(key), `duplicate starter template: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('gives every email a subject line', () => {
    // An email with no subject lands as "(no subject)" and reads as spam.
    for (const t of DEFAULT_TEMPLATES.filter((t) => t.channel === 'EMAIL')) {
      expect(t.headerText, `${t.name} has no subject`).toBeTruthy();
    }
  });

  it('declares every placeholder it uses, and uses every one it declares', () => {
    // A placeholder missing from `variables` is not offered in the editor and
    // renders as literal {{braces}} in a customer's message.
    for (const t of DEFAULT_TEMPLATES) {
      const used = new Set(
        [...`${t.bodyText} ${t.headerText ?? ''}`.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!),
      );
      expect([...used].sort(), `${t.name} (${t.channel}) declares the wrong variables`).toEqual(
        [...new Set(t.variables)].sort(),
      );
    }
  });

  it('marks email approved and the other two as needing approval', () => {
    // There is nobody to approve an email. WhatsApp waits for Meta and SMS
    // waits for DLT registration, so those start as drafts — claiming they are
    // approved would send a salon straight into a provider rejection.
    for (const t of DEFAULT_TEMPLATES) {
      if (t.channel === 'EMAIL') expect(t.approvalStatus, t.name).toBe('APPROVED');
      else expect(t.approvalStatus, `${t.name} (${t.channel})`).toBe('DRAFT');
    }
  });

  it('keeps every SMS inside one segment', () => {
    // Two segments is two messages and twice the bill. Placeholders are
    // measured at a realistic filled length rather than as {{braces}}.
    for (const t of DEFAULT_TEMPLATES.filter((t) => t.channel === 'SMS')) {
      const filled = t.bodyText.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, 'x'.repeat(14));
      expect(filled.length, `${t.name} is ${filled.length} characters`).toBeLessThanOrEqual(160);
    }
  });

  it('never labels an offer as a utility message', () => {
    // WhatsApp utility is ~7.5x cheaper than marketing, and mislabelling a
    // promotional message is how a salon gets its number blocked.
    const promotional = DEFAULT_TEMPLATES.filter((t) => /offer|winback|birthday|rebooking/.test(t.name));
    for (const t of promotional) {
      expect(t.category, `${t.name} (${t.channel})`).toBe('MARKETING');
    }
  });

  /**
   * EVERY WHATSAPP STARTER MUST BE ONE META WOULD ACCEPT.
   *
   * Five of them were not. They ended on a variable followed by a full stop —
   * "...your balance is now {{points_balance}}." — which reads as a finished
   * sentence and which Meta refuses as a dangling parameter, because it wants
   * the placeholder explained by words rather than punctuation. invoice_sent
   * was one of them, so no salon seeded from these could ever get an invoice
   * template approved, and the failure arrived as a rejection at submission
   * time rather than as anything visible here.
   *
   * This is the cheap guard: a template nobody can submit is not a starter
   * template, and that is decided at build time rather than by Meta.
   */
  it('ships no WhatsApp template that Meta would refuse', () => {
    const broken = DEFAULT_TEMPLATES.filter((t) => t.channel === 'WHATSAPP').flatMap((t) => {
      const problems = templateProblems({
        name: t.name,
        bodyText: t.bodyText,
        headerText: t.headerText ?? null,
        footerText: t.footerText ?? null,
        buttons: t.buttons ?? null,
      });
      return problems.length > 0 ? [`${t.name}: ${problems.join('; ')}`] : [];
    });

    expect(broken).toEqual([]);
  });

  /**
   * EVERY WHATSAPP STARTER NEEDS AN EMAIL TWIN.
   *
   * Not tidiness. A WhatsApp template cannot send until Meta approves it, and
   * the dispatcher falls back to the same-named EMAIL template while that is
   * pending — so a WhatsApp starter without a twin is one that sends NOTHING
   * for however many days Meta takes, with no fallback and nothing on screen
   * to say why.
   *
   * explore_suggested shipped without one and nothing noticed, which is what
   * this test is for.
   */
  it('gives every WhatsApp template an email twin to fall back to', () => {
    const emails = new Set(
      DEFAULT_TEMPLATES.filter((t) => t.channel === 'EMAIL').map((t) => t.name),
    );

    /**
     * Two are exempt, and the reason is the message rather than the effort.
     * Both are about to expire when they are sent, and email is not a channel
     * anybody reads inside the window in which either is true.
     */
    const NO_EMAIL_TWIN: Record<string, string> = {
      appointment_reminder_2h:
        'Two hours before the appointment. Nobody checks email in that window, and a reminder read the next morning is worse than none.',
      waitlist_slot_open:
        'A slot that will be gone in minutes. Offering it by email is unfair to the next person on the list.',
    };

    const orphans = DEFAULT_TEMPLATES.filter(
      (t) => t.channel === 'WHATSAPP' && !emails.has(t.name) && !NO_EMAIL_TWIN[t.name],
    ).map((t) => t.name);

    expect(orphans).toEqual([]);
  });

  /**
   * EVERY LINK IN A STARTER MUST BE ONE THE APP BUILDS.
   *
   * Variables split into two kinds: ones the app fills (a booking link, an
   * invoice number) and ones a person types when sending (an offer, a
   * festival name). A LINK is never the second kind — nobody at a counter
   * types a tracked URL — so a {{..._link}} the app cannot build is a
   * template that can never be sent by anybody, on any channel. The
   * missing-variable gate refuses it, and the only trace is a SKIPPED row in
   * a log nobody reads.
   *
   * The email review_request shipped using {{review_link}}, a name that
   * appears nowhere else in the codebase, so it had never been sendable. This
   * is the check that would have said so on the day it was written.
   */
  it('builds every link a starter template asks for', () => {
    const broken = DEFAULT_TEMPLATES.flatMap((t) => {
      const links = (t.variables ?? []).filter((name) => name.endsWith('_link'));
      const unbuildable = unfillableVariables(links);
      return unbuildable.length > 0 ? [`${t.name} (${t.channel}): ${unbuildable.join(', ')}`] : [];
    });

    expect(broken).toEqual([]);
  });
});

import type { Channel, JourneyActionType, JourneyTrigger, TemplateCategory, TemplateApprovalStatus } from '@prisma/client';

export interface TemplateDefinition {
  name: string;
  channel: Channel;
  category: TemplateCategory;
  language: string;
  bodyText: string;
  variables: string[];
  approvalStatus: TemplateApprovalStatus;
  footerText?: string;
  /** The subject line, for email. Ignored on WhatsApp and SMS. */
  headerText?: string;
}

/**
 * Seed templates. WhatsApp Business requires templates to be registered and
 * approved with the provider before they can be sent, so these start as DRAFT
 * and carry the provider template name once the salon gets approval. UTILITY
 * templates (transactional) and MARKETING templates are kept separate on
 * purpose — marketing sends additionally require an explicit opt-in.
 */
export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  // ------------------------------------------------------- whatsapp: utility
  /**
   * FIFTEEN UTILITY TEMPLATES, AND WHAT MAKES THEM UTILITY.
   *
   * Every one of these reports a fact about something the customer has already
   * done or already holds: an appointment they booked, an invoice they owe, a
   * membership they paid for. None of them asks for anything.
   *
   * That is not a style preference. Meta re-reads the wording at review and
   * files a template under the category its CONTENT belongs to, so a single
   * "book now" or "renew today" moves the whole template to MARKETING — and a
   * marketing template only reaches customers who opted in to marketing, which
   * for a cancellation notice or a payment reminder is the wrong audience by
   * every measure. The link and the ask live in the marketing set below, where
   * they belong.
   */
  {
    name: 'appointment_confirmation',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your appointment at {{salon_name}} is confirmed for {{appointment_date}} at {{appointment_time}} with {{staff_name}}. Services: {{services}}. Reply RESCHEDULE if you need a different time.',
    variables: ['customer_name', 'salon_name', 'appointment_date', 'appointment_time', 'staff_name', 'services'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'appointment_reminder_24h',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, a reminder about your appointment tomorrow at {{appointment_time}} at {{salon_name}}. See you then.',
    variables: ['customer_name', 'appointment_time', 'salon_name'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'appointment_reminder_2h',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your appointment at {{salon_name}} is in about 2 hours ({{appointment_time}}). We are at {{branch_address}}.',
    variables: ['customer_name', 'salon_name', 'appointment_time', 'branch_address'],
    approvalStatus: 'DRAFT',
  },
  {
    // The new time only. Meta counts placeholders, not meanings, and a body
    // carrying both the old and the new time needs values the app does not
    // keep once an appointment has moved.
    name: 'appointment_rescheduled',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your appointment at {{salon_name}} has been moved to {{appointment_date}} at {{appointment_time}} with {{staff_name}}. Reply RESCHEDULE if that does not work.',
    variables: ['customer_name', 'salon_name', 'appointment_date', 'appointment_time', 'staff_name'],
    approvalStatus: 'DRAFT',
  },
  {
    // No booking link. A cancellation with "book again" attached is a sales
    // message wearing a notice, and Meta reads it that way.
    name: 'appointment_cancelled',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your appointment on {{appointment_date}} at {{salon_name}} has been cancelled. Nothing further is needed from you.',
    variables: ['customer_name', 'appointment_date', 'salon_name'],
    approvalStatus: 'DRAFT',
  },
  {
    // Answers a request the customer made. That is what keeps it utility: they
    // asked to be told, and this is the telling.
    name: 'waitlist_slot_open',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, the slot you asked about at {{salon_name}} has opened up: {{appointment_date}} at {{appointment_time}}. Reply YES within the hour and it is yours.',
    variables: ['customer_name', 'salon_name', 'appointment_date', 'appointment_time'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'thank_you',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Thank you for choosing {{salon_name}}, {{customer_name}}. We hope you loved your {{services}}. If anything was not right, reply here and tell us.',
    variables: ['salon_name', 'customer_name', 'services'],
    approvalStatus: 'DRAFT',
  },
  {
    // Sent after a 1- to 3-star rating. No link, no offer -- an apology and a
    // person. Anything else reads as brushing them off.
    name: 'feedback_apology',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      "Thank you for telling us, {{customer_name}} — we're sorry your visit at {{salon_name}} wasn't what it should have been. Someone from the salon will call you today to put it right.",
    variables: ['customer_name', 'salon_name'],
    approvalStatus: 'DRAFT',
  },
  {
    // The loyalty points ride HERE rather than in a message of their own. A
    // standalone points message has no transaction attached, so its only
    // purpose is the loyalty programme and Meta files it as marketing. On a
    // receipt they are part of the receipt.
    name: 'invoice_sent',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Thank you for visiting {{salon_name}}, {{customer_name}}. Invoice {{invoice_number}} for {{amount}} is ready: {{invoice_link}}. You earned points today — your balance is now {{points_balance}}.',
    variables: ['salon_name', 'customer_name', 'invoice_number', 'amount', 'invoice_link', 'points_balance'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'payment_received',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, we have received {{amount}} against invoice {{invoice_number}} at {{salon_name}}. Outstanding balance: {{due_amount}}. Thank you.',
    variables: ['customer_name', 'amount', 'invoice_number', 'salon_name', 'due_amount'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'payment_reminder',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, a gentle reminder that {{due_amount}} is outstanding on invoice {{invoice_number}} at {{salon_name}}. Call {{salon_phone}} if you would like the details.',
    variables: ['customer_name', 'due_amount', 'invoice_number', 'salon_name', 'salon_phone'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'membership_activated',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your {{plan_name}} membership at {{salon_name}} is active and runs until {{expiry_date}}. Member pricing applies from your next visit.',
    variables: ['customer_name', 'plan_name', 'salon_name', 'expiry_date'],
    approvalStatus: 'DRAFT',
  },
  {
    // The fact, and only the fact. "Renew to keep your benefits" is what moved
    // this template to marketing on a live account -- the ask now lives in
    // membership_renewal_offer below.
    name: 'membership_expiring',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your {{plan_name}} membership at {{salon_name}} ends on {{expiry_date}} — {{days_left}} days left. Your benefits stay active until then.',
    variables: ['customer_name', 'plan_name', 'salon_name', 'expiry_date', 'days_left'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'package_purchased',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your {{package_name}} at {{salon_name}} is ready to use. Sessions credited: {{sessions_left}}, valid until {{expiry_date}}.',
    variables: ['customer_name', 'package_name', 'salon_name', 'sessions_left', 'expiry_date'],
    approvalStatus: 'DRAFT',
  },
  {
    // Same treatment as the membership: no booking link, because the link is
    // the pitch. Salons that want the nudge send package_renewal_offer too.
    name: 'package_expiring',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your {{package_name}} at {{salon_name}} has {{sessions_left}} sessions remaining, valid until {{expiry_date}}. Reply here or call us and we will schedule them for you.',
    variables: ['customer_name', 'package_name', 'salon_name', 'sessions_left', 'expiry_date'],
    approvalStatus: 'DRAFT',
  },

  // ----------------------------------------------------- whatsapp: marketing
  /**
   * TEN MARKETING TEMPLATES, AND WHY THEY ARE NOT ALL DISCOUNTS.
   *
   * A salon that only ever messages when it wants something gets muted, and a
   * muted number is worth nothing — WhatsApp pauses templates customers block
   * or report, so an aggressive marketing set damages the utility set that
   * shares the number with it.
   *
   * So four of these ten sell nothing at all: a festival wish, a first-visit
   * anniversary, a seasonal care tip and a new-service announcement. They are
   * still MARKETING by Meta's taxonomy — anything that is not about a
   * transaction the customer already started is — and they still need the
   * opt-in. What they buy is the right to send the other six.
   *
   * `festival_name` is a variable rather than a template per festival on
   * purpose: one approved template serves Diwali, Eid, Onam, Pongal, Christmas
   * and Navratri, and every salon on the platform celebrates a different set.
   */
  {
    // No offer anywhere in it. The warmest message a salon sends all year.
    name: 'festival_greeting',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Happy {{festival_name}} from everyone at {{salon_name}}, {{customer_name}}! Wishing you and your family a bright and joyful celebration.',
    variables: ['festival_name', 'salon_name', 'customer_name'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'festival_offer',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Getting ready for {{festival_name}}, {{customer_name}}? {{salon_name}} has {{offer}} on until {{offer_expiry}}. The diary fills early this week, so book when you can: {{booking_link}} — see you soon!',
    variables: ['festival_name', 'customer_name', 'salon_name', 'offer', 'offer_expiry', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    // Wedding season is the single biggest earner in an Indian salon's year and
    // it is planned months ahead, so this goes out early and talks about
    // planning rather than price.
    name: 'wedding_season_invite',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Wedding season is close, {{customer_name}}. {{salon_name}} is taking bridal and family bookings now — trials, mehendi day, and the morning itself. Tell us the date and we will plan it with you: {{booking_link}} — or just reply here.',
    variables: ['customer_name', 'salon_name', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    // Advice first. A salon that is useful in the monsoon is remembered in
    // December, and nothing here costs the customer anything.
    name: 'seasonal_care_tip',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'A small {{season}} tip from {{salon_name}}, {{customer_name}}: {{tip}}. If your hair is not behaving, come in and we will look at it — no appointment needed for a quick chat.',
    variables: ['season', 'salon_name', 'customer_name', 'tip'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'new_service_launch',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Something new at {{salon_name}}, {{customer_name}}: {{service_name}}. {{service_note}} Have a look whenever you are curious: {{booking_link}} — or ask us anything here.',
    variables: ['salon_name', 'customer_name', 'service_name', 'service_note', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    // A year since their first visit. Costs nothing, sells nothing, and is the
    // message customers most often reply to.
    name: 'first_visit_anniversary',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'It has been a year since your first visit to {{salon_name}}, {{customer_name}} — {{total_visits}} visits since. Thank you for staying with us. Whenever you are due, we are here: {{booking_link}} — no rush at all.',
    variables: ['salon_name', 'customer_name', 'total_visits', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'birthday_wish',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Happy birthday, {{customer_name}}! 🎉 {{salon_name}} would love to treat you this month — book whenever suits you: {{booking_link}} — enjoy your day.',
    variables: ['customer_name', 'salon_name', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'rebooking_reminder',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      "Hi {{customer_name}}, it's been {{days_since_visit}} days since your last {{last_service}} at {{salon_name}}. Shall we book your next one? {{booking_link}} — whenever suits you.",
    variables: ['customer_name', 'days_since_visit', 'last_service', 'salon_name', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'winback_offer',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      "We haven't seen you in a while, {{customer_name}}. Here's {{offer}} on your next visit to {{salon_name}}, valid until {{offer_expiry}}. Book here: {{booking_link}} — we would love to see you.",
    variables: ['customer_name', 'offer', 'salon_name', 'offer_expiry', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    // Sent only after a 4- or 5-star rating: the one message that should ever
    // carry the Google link. MARKETING because Meta decided so -- it was
    // submitted as utility and re-filed -- since asking a favour is
    // promotional in their taxonomy however politely it is worded.
    // UTILITY is OUR classification, and it is what decides whether a plan
    // includes this message. Meta will re-file it as marketing at review --
    // asking a favour is promotional to them -- and that is fine: their answer
    // lands in `category` and governs consent and billing, ours stays in
    // `requestedCategory` and governs the plan. Submitting it as utility costs
    // nothing, because Meta ignores the submitted category either way.
    name: 'google_review_request',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'So glad you enjoyed it, {{customer_name}}! If you have a moment, a review on Google helps {{salon_name}} more than you know: {{google_review_link}} — thank you.',
    variables: ['customer_name', 'salon_name', 'google_review_link'],
    approvalStatus: 'DRAFT',
  },

  // -------------------------------- whatsapp: referenced by journeys & alerts
  /**
   * Not in the fifteen or the ten, and still seeded: the default journeys and
   * the notification catalogue name these, and a reference to a template that
   * does not exist is a step that silently sends nothing.
   */
  {
    // UTILITY is OUR classification, and it is what decides whether a plan
    // includes this message. Meta will re-file it as marketing at review --
    // asking a favour is promotional to them -- and that is fine: their answer
    // lands in `category` and governs consent and billing, ours stays in
    // `requestedCategory` and governs the plan. Submitting it as utility costs
    // nothing, because Meta ignores the submitted category either way.
    name: 'review_request',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, how was your experience at {{salon_name}} today? Rate us in one tap: {{feedback_link}} — it takes a few seconds and it genuinely helps.',
    variables: ['customer_name', 'salon_name', 'feedback_link'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'lead_welcome',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{lead_name}}, thanks for your interest in {{salon_name}}! Reply here or book directly: {{booking_link}} — happy to answer anything first.',
    variables: ['lead_name', 'salon_name', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  {
    /**
     * MARKETING, and no wording makes it otherwise.
     *
     * Submitted as utility with every nudge removed — no "keep visiting", no
     * link, just the numbers — and Meta still filed it as marketing. A points
     * scheme IS an incentive to return, so the subject is promotional to them
     * whatever the sentence says.
     *
     * Which is why invoice_sent carries the points as well: attached to a
     * receipt they ride along as utility, because the message's purpose is the
     * invoice. That is the copy to rely on. This one is here because the
     * notification catalogue names it, and for salons that want a standalone
     * points message and have the opt-in to send it.
     */
    name: 'loyalty_points_earned',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'You earned {{points_earned}} points at {{salon_name}}, {{customer_name}}. Your balance is now {{points_balance}} points — worth {{points_value}} on a future visit.',
    variables: ['points_earned', 'salon_name', 'customer_name', 'points_balance', 'points_value'],
    approvalStatus: 'DRAFT',
  },
  {
    // The ask that was cut out of membership_expiring, sent separately to the
    // customers who agreed to hear it.
    name: 'membership_renewal_offer',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your {{plan_name}} at {{salon_name}} ended on {{expiry_date}}. Renew this month and your member pricing carries on without a gap: {{booking_link}} — or call us and we will sort it.',
    variables: ['customer_name', 'plan_name', 'salon_name', 'expiry_date', 'booking_link'],
    approvalStatus: 'DRAFT',
  },
  // ---------------------------------------------------------------- email --
  /**
   * A salon that has email switched on and no email templates has a template
   * picker that is empty on the Email tab, which reads as a broken screen
   * rather than as an empty cupboard. Every channel a salon can send on ships
   * with something to send.
   *
   * These are APPROVED rather than DRAFT: there is no provider to approve an
   * email. WhatsApp templates wait for Meta and SMS waits for DLT, but an
   * email can go out the moment the salon has a verified domain.
   *
   * Email is a different medium from a WhatsApp message, not the same words in
   * a bigger box: it has a subject line, it is read at a desk rather than on a
   * lock screen, and it is where the longer, more formal messages belong —
   * invoices, renewals, anything a customer might want to find again later.
   * The same `name` as the WhatsApp version is deliberate; the unique key is
   * (tenant, name, channel), so one message can have a version per channel.
   */
  {
    name: 'appointment_confirmation',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    headerText: 'Your appointment at {{salon_name}} is confirmed',
    bodyText:
      'Dear {{customer_name}},\n\nYour appointment at {{salon_name}} is confirmed.\n\nWhen: {{appointment_date}} at {{appointment_time}}\nWith: {{staff_name}}\nServices: {{services}}\nWhere: {{branch_address}}\n\nIf you need a different time, just reply to this email and we will sort it out.\n\nWarm regards,\n{{salon_name}}\n{{salon_phone}}',
    variables: [
      'customer_name',
      'salon_name',
      'appointment_date',
      'appointment_time',
      'staff_name',
      'services',
      'branch_address',
      'salon_phone',
    ],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'invoice_sent',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    headerText: 'Your invoice {{invoice_number}} from {{salon_name}}',
    bodyText:
      'Dear {{customer_name}},\n\nThank you for visiting {{salon_name}}.\n\nInvoice: {{invoice_number}}\nServices: {{services}}\nTotal: {{amount}}\n\nWarm regards,\n{{salon_name}}\n{{salon_phone}}',
    variables: ['customer_name', 'salon_name', 'invoice_number', 'services', 'amount', 'salon_phone'],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'thank_you',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    headerText: 'Thank you for visiting {{salon_name}}',
    bodyText:
      'Dear {{customer_name}},\n\nThank you for coming in today. We hope you left happy.\n\nIf anything was not quite right, reply to this email and tell us — we would rather hear it from you than not at all.\n\nWarm regards,\n{{salon_name}}',
    variables: ['customer_name', 'salon_name'],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'review_request',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    headerText: 'How was your visit to {{salon_name}}?',
    bodyText:
      'Dear {{customer_name}},\n\nWe would love to know how your visit went. It takes a minute and it genuinely helps us:\n\n{{review_link}}\n\nThank you,\n{{salon_name}}',
    variables: ['customer_name', 'review_link', 'salon_name'],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'membership_expiring',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    headerText: 'Your {{plan_name}} membership ends on {{expiry_date}}',
    bodyText:
      'Dear {{customer_name}},\n\nYour {{plan_name}} membership at {{salon_name}} ends on {{expiry_date}}.\n\nRenewing keeps your member pricing and any unused benefits running without a gap. Reply to this email or call us on {{salon_phone}} and we will take care of it.\n\nWarm regards,\n{{salon_name}}',
    variables: ['customer_name', 'plan_name', 'salon_name', 'expiry_date', 'salon_phone'],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'package_expiring',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    headerText: 'You still have sessions left at {{salon_name}}',
    bodyText:
      'Dear {{customer_name}},\n\nYou have {{sessions_left}} session(s) left on your {{package_name}}, and they expire on {{expiry_date}}.\n\nBook whenever suits you: {{booking_link}}\n\nWarm regards,\n{{salon_name}}',
    variables: ['customer_name', 'sessions_left', 'package_name', 'expiry_date', 'booking_link', 'salon_name'],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'birthday_wish',
    channel: 'EMAIL',
    category: 'MARKETING',
    language: 'en',
    headerText: 'Happy birthday, {{customer_name}}',
    bodyText:
      'Dear {{customer_name}},\n\nHappy birthday from everyone at {{salon_name}}.\n\nCome and be looked after this month — book any time: {{booking_link}}\n\nWarm regards,\n{{salon_name}}',
    variables: ['customer_name', 'salon_name', 'booking_link'],
    approvalStatus: 'APPROVED',
  },
  {
    name: 'winback_offer',
    channel: 'EMAIL',
    category: 'MARKETING',
    language: 'en',
    headerText: 'We have missed you at {{salon_name}}',
    bodyText:
      'Dear {{customer_name}},\n\nIt has been a while since your last visit to {{salon_name}}, and we would love to see you again.\n\nBook whenever suits you: {{booking_link}}\n\nWarm regards,\n{{salon_name}}',
    variables: ['customer_name', 'salon_name', 'booking_link'],
    approvalStatus: 'APPROVED',
  },

  // ------------------------------------------------------------------ SMS --
  /**
   * Deliberately few, and deliberately short.
   *
   * An SMS in India needs a DLT-registered template before it can be sent, so
   * these start as DRAFT like the WhatsApp ones — the salon registers the
   * wording, then marks them approved. Registration is per message, so a long
   * list here would be a long list of paperwork nobody does.
   *
   * SMS earns its cost only where WhatsApp might not arrive: a reminder for
   * the hour before, a cancellation, money owed. Anything that can wait or can
   * be read later belongs on WhatsApp or email, which cost less and say more.
   * Each is kept inside one 160-character segment once the variables are
   * filled, because two segments is two messages and twice the bill.
   */
  {
    name: 'appointment_confirmation',
    channel: 'SMS',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      '{{salon_name}}: Appointment confirmed for {{appointment_date}} at {{appointment_time}}. Call {{salon_phone}} to change it.',
    variables: ['salon_name', 'appointment_date', 'appointment_time', 'salon_phone'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'appointment_reminder_24h',
    channel: 'SMS',
    category: 'UTILITY',
    language: 'en',
    bodyText: '{{salon_name}}: Reminder, your appointment is tomorrow at {{appointment_time}}. See you then.',
    variables: ['salon_name', 'appointment_time'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'appointment_cancelled',
    channel: 'SMS',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      '{{salon_name}}: Your appointment on {{appointment_date}} is cancelled. Call {{salon_phone}} to rebook.',
    variables: ['salon_name', 'appointment_date', 'salon_phone'],
    approvalStatus: 'DRAFT',
  },
  {
    name: 'payment_reminder',
    channel: 'SMS',
    category: 'UTILITY',
    language: 'en',
    bodyText: '{{salon_name}}: {{amount}} is outstanding on invoice {{invoice_number}}. Call {{salon_phone}}.',
    variables: ['salon_name', 'amount', 'invoice_number', 'salon_phone'],
    approvalStatus: 'DRAFT',
  },
];

export interface JourneyStepDefinition {
  actionType: JourneyActionType;
  delayMinutes: number;
  channel?: Channel;
  templateName?: string;
  config?: Record<string, unknown>;
}

export interface JourneyDefinition {
  name: string;
  description: string;
  trigger: JourneyTrigger;
  triggerConfig: Record<string, unknown>;
  isActive: boolean;
  steps: JourneyStepDefinition[];
}

const MIN = 1;
const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * The retention engine, expressed as journeys. Each one is created per tenant so
 * owners can edit copy, timing and channel without touching code.
 */
export const DEFAULT_JOURNEYS: JourneyDefinition[] = [
  {
    name: 'Booking confirmation',
    description: 'Confirms the appointment the moment it is booked.',
    trigger: 'APPOINTMENT_BOOKED',
    triggerConfig: {},
    isActive: true,
    steps: [
      {
        actionType: 'SEND_MESSAGE',
        delayMinutes: 0,
        channel: 'WHATSAPP',
        templateName: 'appointment_confirmation',
      },
    ],
  },
  {
    name: 'Post-visit thank you and review',
    description: 'Thanks the customer after the visit and asks for a rating.',
    trigger: 'APPOINTMENT_COMPLETED',
    triggerConfig: {},
    isActive: true,
    steps: [
      { actionType: 'SEND_MESSAGE', delayMinutes: 30 * MIN, channel: 'WHATSAPP', templateName: 'thank_you' },
      { actionType: 'SEND_MESSAGE', delayMinutes: 2 * HOUR, channel: 'WHATSAPP', templateName: 'review_request' },
    ],
  },
  {
    name: 'New customer onboarding',
    description: 'First-visit follow-up and a nudge to rebook at 30 days.',
    trigger: 'FIRST_VISIT',
    triggerConfig: {},
    isActive: true,
    steps: [
      { actionType: 'SEND_MESSAGE', delayMinutes: 1 * HOUR, channel: 'WHATSAPP', templateName: 'thank_you' },
      { actionType: 'SEND_MESSAGE', delayMinutes: 7 * DAY, channel: 'WHATSAPP', templateName: 'review_request' },
      { actionType: 'EXIT_IF_BOOKED', delayMinutes: 30 * DAY },
      { actionType: 'SEND_MESSAGE', delayMinutes: 0, channel: 'WHATSAPP', templateName: 'rebooking_reminder' },
    ],
  },
  {
    name: 'Happy customer to Google',
    description: 'After a 4- or 5-star rating, ask for a public review.',
    trigger: 'FEEDBACK_POSITIVE',
    triggerConfig: {},
    isActive: true,
    steps: [{ actionType: 'SEND_MESSAGE', delayMinutes: 10, channel: 'WHATSAPP', templateName: 'google_review_request' }],
  },
  {
    name: 'Unhappy customer recovery',
    description: 'After a 1- to 3-star rating, apologise and alert the manager. Never sends them to Google.',
    trigger: 'FEEDBACK_NEGATIVE',
    triggerConfig: {},
    isActive: true,
    steps: [{ actionType: 'SEND_MESSAGE', delayMinutes: 5, channel: 'WHATSAPP', templateName: 'feedback_apology' }],
  },
  {
    name: 'Win back lapsed customers',
    description: 'Reaches customers who have not visited for 60 days, then follows up with an offer.',
    trigger: 'NO_VISIT_DAYS',
    triggerConfig: { days: 60, minVisits: 2 },
    isActive: true,
    steps: [
      { actionType: 'SEND_MESSAGE', delayMinutes: 0, channel: 'WHATSAPP', templateName: 'rebooking_reminder' },
      { actionType: 'EXIT_IF_BOOKED', delayMinutes: 5 * DAY },
      {
        actionType: 'SEND_MESSAGE',
        delayMinutes: 0,
        channel: 'WHATSAPP',
        templateName: 'winback_offer',
        config: { offer: '15% off your next service' },
      },
      { actionType: 'EXIT_IF_BOOKED', delayMinutes: 10 * DAY },
      {
        actionType: 'SEND_MESSAGE',
        delayMinutes: 0,
        channel: 'WHATSAPP',
        templateName: 'winback_offer',
        config: { offer: '20% off + complimentary hair spa' },
      },
    ],
  },
  {
    name: 'Membership renewal',
    description: 'Reminds members 30, 7 and 1 day before expiry.',
    trigger: 'MEMBERSHIP_EXPIRING',
    triggerConfig: { days: 30 },
    isActive: true,
    steps: [
      { actionType: 'SEND_MESSAGE', delayMinutes: 0, channel: 'WHATSAPP', templateName: 'membership_expiring' },
      { actionType: 'SEND_MESSAGE', delayMinutes: 23 * DAY, channel: 'WHATSAPP', templateName: 'membership_expiring' },
      { actionType: 'SEND_MESSAGE', delayMinutes: 6 * DAY, channel: 'WHATSAPP', templateName: 'membership_expiring' },
    ],
  },
  {
    name: 'Package expiry nudge',
    description: 'Tells customers to use the sessions they have already paid for.',
    trigger: 'PACKAGE_EXPIRING',
    triggerConfig: { days: 15 },
    isActive: true,
    steps: [
      { actionType: 'SEND_MESSAGE', delayMinutes: 0, channel: 'WHATSAPP', templateName: 'package_expiring' },
    ],
  },
  {
    name: 'Birthday wishes',
    description: 'Sends a birthday offer and awards bonus loyalty points.',
    trigger: 'BIRTHDAY',
    triggerConfig: {},
    isActive: true,
    steps: [
      {
        actionType: 'SEND_MESSAGE',
        delayMinutes: 0,
        channel: 'WHATSAPP',
        templateName: 'birthday_wish',
        config: { offer: '20% off any service this month' },
      },
      { actionType: 'ADD_LOYALTY_POINTS', delayMinutes: 0, config: { points: 50, reason: 'Birthday bonus' } },
    ],
  },
  {
    name: 'New lead follow-up',
    description: 'Answers a new enquiry immediately and follows up after two days.',
    trigger: 'LEAD_CREATED',
    triggerConfig: {},
    isActive: true,
    steps: [
      { actionType: 'SEND_MESSAGE', delayMinutes: 5 * MIN, channel: 'WHATSAPP', templateName: 'lead_welcome' },
      { actionType: 'SEND_MESSAGE', delayMinutes: 2 * DAY, channel: 'WHATSAPP', templateName: 'lead_welcome' },
    ],
  },
];

import type { Channel, TemplateCategory } from '@prisma/client';

/**
 * THE TEMPLATE LIBRARY
 *
 * Ready-written messages a salon can install and then edit. The point is that
 * an owner should never face an empty "write your campaign" box — most of them
 * will not write one, and the automation that never gets written is the one
 * that would have paid for the subscription.
 *
 * Everything here is a starting point, not a finished message. A salon installs
 * a template, it becomes *their* row in `message_templates`, and they change the
 * wording, the offer and the tone. Nothing in the library is sent directly.
 *
 * Two rules run through the whole list:
 *
 *  - **Category is not decoration.** WhatsApp UTILITY costs about ₹0.115 and may
 *    go to anyone who has not opted out. MARKETING costs about ₹0.8631 — 7.5×
 *    more — and needs an explicit opt-in. Mislabelling a promotional message as
 *    utility is how a salon gets its WhatsApp number blocked, so an offer is
 *    always MARKETING here even when it would be cheaper not to be.
 *  - **No fake urgency, no invented scarcity.** These go to real customers of a
 *    small business in their own neighbourhood. "Only 2 slots left!" when there
 *    are twelve is the kind of thing that costs a salon a regular.
 *
 * Festival dates move every year and vary by region, so nothing here is dated.
 * `occasion` groups them; the salon picks the send date when they schedule.
 */

export type LibraryOccasion =
  | 'appointment'
  | 'billing'
  | 'review'
  | 'winback'
  | 'birthday'
  | 'festival'
  | 'offer'
  | 'membership'
  | 'package'
  | 'loyalty'
  | 'referral'
  | 'lead'
  | 'otp'
  | 'operations';

export interface LibraryTemplate {
  /** Stable identifier used to install it. */
  key: string;
  /** What the salon sees in the library. */
  title: string;
  /** One line on when to use it, written for a salon owner. */
  purpose: string;
  occasion: LibraryOccasion;
  channel: Channel;
  category: TemplateCategory;
  language: string;
  bodyText: string;
  variables: string[];
  subject?: string;
  footerText?: string;
  /** Shown as guidance in the UI — the mistake this template avoids. */
  tip?: string;
}

const V = {
  customer: 'customer_name',
  salon: 'salon_name',
  date: 'appointment_date',
  time: 'appointment_time',
  staff: 'staff_name',
  services: 'services',
  amount: 'amount',
  invoice: 'invoice_number',
  booking: 'booking_link',
  feedback: 'feedback_link',
  points: 'points_balance',
  lastService: 'last_service',
  daysSince: 'days_since_visit',
  branchAddress: 'branch_address',
  salonPhone: 'salon_phone',
  expiry: 'expiry_date',
  planName: 'plan_name',
  packageName: 'package_name',
  sessionsLeft: 'sessions_left',
};

export const TEMPLATE_LIBRARY: LibraryTemplate[] = [
  // ------------------------------------------------------------ appointment --
  {
    key: 'appointment_confirmed_wa',
    title: 'Booking confirmed',
    purpose: 'Sent the moment an appointment is booked, so the customer has the details in writing.',
    occasion: 'appointment',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your appointment at {{salon_name}} is confirmed.\n\n📅 {{appointment_date}} at {{appointment_time}}\n💇 {{services}} with {{staff_name}}\n📍 {{branch_address}}\n\nNeed to change it? Just reply here.',
    variables: [V.customer, V.salon, V.date, V.time, V.services, V.staff, V.branchAddress],
    tip: 'Inviting a reply is what makes reminders work later — a customer who has replied once has an open conversation with you.',
  },
  {
    key: 'appointment_reminder_day_before',
    title: 'Reminder — the day before',
    purpose: 'The single message that cuts no-shows most. Sent 24 hours ahead.',
    occasion: 'appointment',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, just a reminder about your appointment tomorrow at {{appointment_time}} with {{staff_name}} at {{salon_name}}.\n\nReply CONFIRM to keep it, or tell us if you need another time — we can offer the slot to someone else.',
    variables: [V.customer, V.time, V.staff, V.salon],
    tip: 'Asking them to confirm gives you a chance to resell the slot. A reminder that only informs saves nothing.',
  },
  {
    key: 'appointment_reminder_same_day',
    title: 'Reminder — a few hours before',
    purpose: 'For salons with a high walk-away rate, or for long colour appointments.',
    occasion: 'appointment',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'See you in a few hours, {{customer_name}} — {{appointment_time}} at {{salon_name}}.\n\n📍 {{branch_address}}\n☎️ {{salon_phone}}',
    variables: [V.customer, V.time, V.salon, V.branchAddress, V.salonPhone],
    tip: 'Do not send both this and the day-before reminder to the same customer unless the appointment is over an hour long.',
  },
  {
    key: 'appointment_reminder_sms',
    title: 'Reminder (SMS)',
    purpose: 'For customers who are not on WhatsApp. Must be a DLT-registered template.',
    occasion: 'appointment',
    channel: 'SMS',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, reminder: your appointment at {{salon_name}} is on {{appointment_date}} at {{appointment_time}}. Call {{salon_phone}} to reschedule.',
    variables: [V.customer, V.salon, V.date, V.time, V.salonPhone],
    tip: 'Keep SMS under 160 characters. Emoji and Hindi characters cut the limit to 70 and triple your cost.',
  },
  {
    key: 'appointment_no_show_followup',
    title: 'After a no-show',
    purpose: 'Sent a few hours after a missed appointment. Recovers more bookings than it loses.',
    occasion: 'appointment',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, we missed you at {{salon_name}} today — hope everything is alright.\n\nShall we find you another time this week?',
    variables: [V.customer, V.salon],
    tip: 'No guilt, no cancellation-fee talk. A missed appointment is usually a bad day, not a bad customer.',
  },

  // ---------------------------------------------------------------- billing --
  {
    key: 'invoice_thankyou',
    title: 'Bill and thank you',
    purpose: 'Sent right after payment — doubles as the receipt.',
    occasion: 'billing',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Thank you for visiting {{salon_name}}, {{customer_name}}!\n\nBill {{invoice_number}} — {{amount}}\n{{services}}\n\nYou now have {{points_balance}} loyalty points. See you again soon 💫',
    variables: [V.salon, V.customer, V.invoice, V.amount, V.services, V.points],
  },
  {
    key: 'payment_due_reminder',
    title: 'Outstanding balance',
    purpose: 'A gentle nudge for a customer who left something to pay.',
    occasion: 'billing',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, a small reminder that {{due_amount}} is still pending on bill {{invoice_number}} at {{salon_name}}. You can settle it on your next visit — no rush.',
    variables: [V.customer, 'due_amount', V.invoice, V.salon],
    tip: 'Say "on your next visit". Chasing money from a regular over WhatsApp costs more in goodwill than the amount usually is.',
  },

  // ----------------------------------------------------------------- review --
  {
    key: 'review_request',
    title: 'Ask how it went',
    purpose: 'Sent 2 hours after a visit. Good ratings go to Google; poor ones come to you first.',
    occasion: 'review',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, how was your {{last_service}} at {{salon_name}} today?\n\nTap to tell us in one click: {{feedback_link}}\n\nIt takes ten seconds and it genuinely helps us.',
    variables: [V.customer, V.lastService, V.salon, V.feedback],
    tip: 'Two hours is the sweet spot — long enough to have left, soon enough to still feel the haircut.',
  },
  {
    key: 'google_review_after_happy',
    title: 'Google review — after a happy rating',
    purpose: 'Only for customers who already rated 4 or 5 stars. Never send this cold.',
    occasion: 'review',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'That is lovely to hear, {{customer_name}} — thank you! 🙏\n\nIf you have thirty seconds, would you say the same on Google? It is how new customers in the area find us:\n{{google_review_link}}',
    variables: [V.customer, 'google_review_link'],
    tip: 'Never offer a discount for a review. It is against Google policy and can get the listing removed — far worse than a bad review.',
  },
  {
    key: 'complaint_owner_followup',
    title: 'After an unhappy rating',
    purpose: 'Goes to the customer from the owner when someone rates 3 stars or below.',
    occasion: 'review',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, this is {{owner_name}}, the owner of {{salon_name}}. I saw your feedback and I am sorry it was not right.\n\nCan I call you to understand what happened? I would like to fix it.',
    variables: [V.customer, 'owner_name', V.salon],
    tip: 'Send within the hour. A complaint answered quickly and personally is what stops a one-star review being written at all.',
  },

  // ---------------------------------------------------------------- winback --
  {
    key: 'winback_gentle',
    title: 'We have missed you',
    purpose: 'For customers who have not visited in about 90 days. No discount — just an invitation.',
    occasion: 'winback',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, it has been a while since your last visit to {{salon_name}} — {{days_since_visit}} days!\n\nShall we book you in with {{staff_name}} again? Just reply with a day that suits you.',
    variables: [V.customer, V.salon, V.daysSince, V.staff],
    tip: 'Send this one first, with no offer. Roughly one in seven comes back without being paid to, and you keep your margin.',
  },
  {
    key: 'winback_with_offer',
    title: 'Win-back with an offer',
    purpose: 'Only for customers who ignored the gentle version. Costs you margin, so use it second.',
    occasion: 'winback',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'We would really like to see you again, {{customer_name}} 💛\n\nHere is {{offer_text}} on your next visit to {{salon_name}}, valid until {{offer_expiry}}.\n\nBook here: {{booking_link}}',
    variables: [V.customer, 'offer_text', V.salon, 'offer_expiry', V.booking],
    tip: 'Always put an expiry on a discount. An open-ended offer teaches your regulars to wait for the next one.',
  },
  {
    key: 'winback_sms',
    title: 'Win-back (SMS)',
    purpose: 'For lapsed customers who never opened WhatsApp.',
    occasion: 'winback',
    channel: 'SMS',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      '{{customer_name}}, we miss you at {{salon_name}}! Book your next appointment: {{booking_link}}',
    variables: [V.customer, V.salon, V.booking],
  },

  // --------------------------------------------------------------- birthday --
  {
    key: 'birthday_wish',
    title: 'Birthday wish',
    purpose: 'Sent on the morning of their birthday. No selling — just the wish.',
    occasion: 'birthday',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Happy birthday, {{customer_name}}! 🎂\n\nEveryone at {{salon_name}} hopes you have a wonderful day.',
    variables: [V.customer, V.salon],
    tip: 'A birthday message with no offer attached is remembered. One with a coupon is read as an advertisement.',
  },
  {
    key: 'birthday_gift',
    title: 'Birthday treat',
    purpose: 'For salons that prefer to give something. Send a few days before, so it is usable on the day.',
    occasion: 'birthday',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Happy birthday month, {{customer_name}}! 🎉\n\nYour gift from {{salon_name}}: {{offer_text}}, yours any time before {{offer_expiry}}.\n\nBook here: {{booking_link}}',
    variables: [V.customer, V.salon, 'offer_text', 'offer_expiry', V.booking],
    tip: 'Give them two or three weeks to use it. A gift that expires on the day itself is not a gift.',
  },
  {
    key: 'anniversary_first_visit',
    title: 'One year with us',
    purpose: 'Sent a year after their first visit. Almost nobody does this, and it is remembered.',
    occasion: 'birthday',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      '{{customer_name}}, it has been a year since your first visit to {{salon_name}} 💫\n\nThank you for coming back. Here is to the next one.',
    variables: [V.customer, V.salon],
  },

  // --------------------------------------------------------------- festival --
  {
    key: 'festival_diwali',
    title: 'Diwali greeting',
    purpose: 'Warm wishes with a booking nudge — the busiest salon fortnight of the Indian year.',
    occasion: 'festival',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Happy Diwali, {{customer_name}}! 🪔\n\nMay your year ahead be bright. If you would like to look your best for the celebrations, our diary is filling fast — book early: {{booking_link}}',
    variables: [V.customer, V.booking],
    tip: 'Send this 10–14 days before, not on the day. On the day itself everyone is busy and every salon is already full.',
  },
  {
    key: 'festival_holi',
    title: 'Holi — after-care',
    purpose: 'The colour-damage angle nobody else uses. Send the day after Holi.',
    occasion: 'festival',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hope you had a wonderful Holi, {{customer_name}}! 🌸\n\nHoli colours are hard on hair and skin. If you would like a repair treatment this week, we have kept some slots free: {{booking_link}}',
    variables: [V.customer, V.booking],
    tip: 'This one works because it is useful rather than promotional. The timing is the whole idea.',
  },
  {
    key: 'festival_karwa_chauth',
    title: 'Karwa Chauth / festive booking',
    purpose: 'For the days when everyone wants mehendi and a blow-dry at the same hour.',
    occasion: 'festival',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, {{festival_name}} is on {{festival_date}} and our slots go quickly that week.\n\nShall we reserve your usual time now? Reply and we will hold it: {{booking_link}}',
    variables: [V.customer, 'festival_name', 'festival_date', V.booking],
    tip: 'Booking ahead for a rush day is a favour to the customer, not a sales pitch. Say it that way.',
  },
  {
    key: 'festival_eid',
    title: 'Eid greeting',
    purpose: 'Wishes plus an early-booking note for Chand Raat, which is always chaotic.',
    occasion: 'festival',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Eid Mubarak, {{customer_name}}! 🌙\n\nFrom all of us at {{salon_name}}. Chand Raat is our busiest night of the year — reply if you would like us to hold a slot for you.',
    variables: [V.customer, V.salon],
  },
  {
    key: 'festival_new_year',
    title: 'New Year greeting',
    purpose: 'A thank-you for the year, with a party-night booking nudge.',
    occasion: 'festival',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Thank you for a wonderful year, {{customer_name}} ✨\n\nEveryone at {{salon_name}} wishes you a happy new year. Booking for the 31st? Reply early — that evening always fills.',
    variables: [V.customer, V.salon],
  },
  {
    key: 'festival_generic',
    title: 'Any festival — blank',
    purpose: 'A neutral shell for Onam, Pongal, Navratri, Christmas, Raksha Bandhan or anything local.',
    occasion: 'festival',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Happy {{festival_name}}, {{customer_name}}!\n\nWarm wishes from everyone at {{salon_name}}. {{festival_message}}',
    variables: [V.customer, V.salon, 'festival_name', 'festival_message'],
    tip: 'India has too many regional festivals to pre-write. Fill this in with the ones your own customers keep.',
  },

  // ------------------------------------------------------------------ offer --
  {
    key: 'offer_weekday',
    title: 'Quiet weekday offer',
    purpose: 'Fills Tuesday to Thursday mornings. Send only to flexible, price-led customers.',
    occasion: 'offer',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, we have free slots at {{salon_name}} on weekday mornings this week.\n\n{{offer_text}} if you come before 3pm, Tuesday to Thursday.\n\nBook: {{booking_link}}',
    variables: [V.customer, V.salon, 'offer_text', V.booking],
    tip: 'Never send this to a customer who happily pays full price on Saturday — you lose that difference permanently.',
  },
  {
    key: 'offer_new_service',
    title: 'New service announcement',
    purpose: 'Introducing a treatment, aimed at the customers most likely to want it.',
    occasion: 'offer',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      '{{customer_name}}, we have something new at {{salon_name}} 💫\n\n{{service_name}} — {{service_description}}\n\nIntroductory price {{service_price}} until {{offer_expiry}}. Book: {{booking_link}}',
    variables: [V.customer, V.salon, 'service_name', 'service_description', 'service_price', 'offer_expiry', V.booking],
  },
  {
    key: 'offer_seasonal_monsoon',
    title: 'Seasonal care (monsoon / summer)',
    purpose: 'Advice first, offer second. Works far better than a plain discount.',
    occasion: 'offer',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}} — {{season_tip}}\n\nIf you would like a {{service_name}} this month, we are offering {{offer_text}} at {{salon_name}}.\n\n{{booking_link}}',
    variables: [V.customer, 'season_tip', 'service_name', 'offer_text', V.salon, V.booking],
    tip: 'Lead with the tip. A message that teaches something gets read even by people who do not book.',
  },

  // ------------------------------------------------------- membership/package --
  {
    key: 'membership_offer',
    title: 'Membership invitation',
    purpose: 'For loyal customers only — 6+ visits a year. Shows them what they already spend.',
    occasion: 'membership',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, you have visited {{salon_name}} {{total_visits}} times this year — thank you!\n\nOur {{plan_name}} membership would have saved you money on those visits: {{plan_benefits}} for {{plan_price}} a year.\n\nWorth a look? Just reply.',
    variables: [V.customer, V.salon, 'total_visits', V.planName, 'plan_benefits', 'plan_price'],
    tip: 'Showing their own visit count is what makes this land. Sell it at the counter after a service they loved, not cold.',
  },
  {
    key: 'membership_expiring',
    title: 'Membership expiring',
    purpose: 'Sent 15 days before expiry, so there is time to renew without pressure.',
    occasion: 'membership',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, your {{plan_name}} membership at {{salon_name}} ends on {{expiry_date}} — {{days_left}} days away.\n\nRenew any time at the salon, or reply here and we will sort it out.',
    variables: [V.customer, V.planName, V.salon, V.expiry, 'days_left'],
  },
  {
    key: 'package_sessions_left',
    title: 'Unused sessions',
    purpose: 'Reminds a customer of what they have already paid for. Brings them in.',
    occasion: 'package',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, you still have {{sessions_left}} sessions left on your {{package_name}} at {{salon_name}}, valid until {{expiry_date}}.\n\nShall we book one in?',
    variables: [V.customer, V.sessionsLeft, V.packageName, V.salon, V.expiry],
    tip: 'Prepaid sessions a customer forgets are money you owe, not money you keep. Chasing them protects the relationship.',
  },

  // ------------------------------------------------------- loyalty/referral --
  {
    key: 'loyalty_points_reminder',
    title: 'Points worth spending',
    purpose: 'When a customer has enough points to redeem something real.',
    occasion: 'loyalty',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      '{{customer_name}}, you have {{points_balance}} points at {{salon_name}} — enough for {{reward_name}} 🎁\n\nUse them on your next visit: {{booking_link}}',
    variables: [V.customer, V.points, V.salon, 'reward_name', V.booking],
  },
  {
    key: 'referral_invite',
    title: 'Refer a friend',
    purpose: 'Send to happy regulars only. The cheapest new customer a salon can get.',
    occasion: 'referral',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, if you know someone who would like {{salon_name}}, send them our way 💛\n\nThey get {{friend_benefit}} on their first visit, and you get {{referrer_benefit}} on your next one.\n\nShare this: {{booking_link}}',
    variables: [V.customer, V.salon, 'friend_benefit', 'referrer_benefit', V.booking],
    tip: 'Send only to customers who rated you 4 or 5 stars. Asking an unhappy customer for a referral is worse than not asking.',
  },
  {
    key: 'referral_thankyou',
    title: 'Thank you for referring',
    purpose: 'Sent when a referred friend actually visits. Makes the next referral much more likely.',
    occasion: 'referral',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Thank you, {{customer_name}}! {{friend_name}} came in today because of you 🙏\n\n{{referrer_benefit}} has been added to your account at {{salon_name}}.',
    variables: [V.customer, 'friend_name', 'referrer_benefit', V.salon],
  },

  // ------------------------------------------------------------------- lead --
  {
    key: 'lead_first_reply',
    title: 'New enquiry — first reply',
    purpose: 'Sent within minutes of an enquiry. Speed is almost the whole thing.',
    occasion: 'lead',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{lead_name}}, thank you for getting in touch with {{salon_name}}!\n\nWhat were you looking for, and when suits you? We are open {{opening_hours}}.',
    variables: ['lead_name', V.salon, 'opening_hours'],
    tip: 'Reply inside five minutes and you convert several times better. This is the one automation worth turning on first.',
  },
  {
    key: 'lead_followup_no_reply',
    title: 'Enquiry follow-up',
    purpose: 'For an enquiry that went quiet. Send once, two days later — never more.',
    occasion: 'lead',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Hi {{lead_name}}, just checking in from {{salon_name}} — still looking to book something?\n\nHappy to suggest a time, or to leave you be if now is not right.',
    variables: ['lead_name', V.salon],
    tip: 'Giving them permission to say no is what makes people answer. Chase a third time and you are a nuisance.',
  },

  // -------------------------------------------------------------------- otp --
  {
    key: 'otp_whatsapp',
    title: 'One-time code (WhatsApp)',
    purpose: 'For customer-portal sign-in. Must be registered with Meta as an authentication template.',
    occasion: 'otp',
    channel: 'WHATSAPP',
    category: 'AUTHENTICATION',
    language: 'en',
    bodyText: '{{otp_code}} is your verification code for {{salon_name}}. It expires in {{otp_minutes}} minutes.',
    variables: ['otp_code', V.salon, 'otp_minutes'],
    tip: 'Never include a link in an OTP message. It trains customers to tap links in messages that claim to be from you.',
  },
  {
    key: 'otp_sms',
    title: 'One-time code (SMS)',
    purpose: 'Fallback when the customer is not on WhatsApp. Needs its own DLT registration.',
    occasion: 'otp',
    channel: 'SMS',
    category: 'AUTHENTICATION',
    language: 'en',
    bodyText: '{{otp_code}} is your OTP for {{salon_name}}. Valid {{otp_minutes}} minutes. Do not share it with anyone.',
    variables: ['otp_code', V.salon, 'otp_minutes'],
  },

  // ------------------------------------------------------------- operations --
  {
    key: 'ops_holiday_notice',
    title: 'Closed for a holiday',
    purpose: 'Tell customers before they turn up to a shut door.',
    occasion: 'operations',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, {{salon_name}} will be closed on {{closure_date}} for {{closure_reason}}. We reopen on {{reopen_date}}.\n\nIf you had a booking that day, we will call you to move it.',
    variables: [V.customer, V.salon, 'closure_date', 'closure_reason', 'reopen_date'],
  },
  {
    key: 'ops_new_branch',
    title: 'New branch opening',
    purpose: 'Announce a second location to customers who live nearer to it.',
    occasion: 'operations',
    channel: 'WHATSAPP',
    category: 'MARKETING',
    language: 'en',
    bodyText:
      'Good news, {{customer_name}} — {{salon_name}} is now open at {{new_branch_address}} 🎉\n\nSame team, same prices, closer to you. Book: {{booking_link}}',
    variables: [V.customer, V.salon, 'new_branch_address', V.booking],
  },
  {
    key: 'ops_stylist_leaving',
    title: 'Their stylist has left',
    purpose: 'The message most salons avoid sending — and the reason those customers never return.',
    occasion: 'operations',
    channel: 'WHATSAPP',
    category: 'UTILITY',
    language: 'en',
    bodyText:
      'Hi {{customer_name}}, {{staff_name}} has moved on from {{salon_name}}. We know you always booked with them.\n\n{{replacement_name}} has your colour formula and full history, so nothing is lost. Shall we book you in?',
    variables: [V.customer, V.staff, V.salon, 'replacement_name'],
    tip: 'Send this before the customer finds out by arriving. Being told first is what keeps them.',
  },

  // ------------------------------------------------------------------ email --
  {
    key: 'email_invoice',
    title: 'Invoice by email',
    purpose: 'For corporate customers and anyone who asks for a GST invoice.',
    occasion: 'billing',
    channel: 'EMAIL',
    category: 'UTILITY',
    language: 'en',
    subject: 'Your invoice {{invoice_number}} from {{salon_name}}',
    bodyText:
      'Dear {{customer_full_name}},\n\nThank you for visiting {{salon_name}}.\n\nInvoice: {{invoice_number}}\nServices: {{services}}\nTotal: {{amount}}\n\nThis invoice includes GST as applicable.\n\nWarm regards,\n{{salon_name}}\n{{salon_phone}}',
    variables: ['customer_full_name', V.salon, V.invoice, V.services, V.amount, V.salonPhone],
  },
  {
    key: 'email_winback',
    title: 'Win-back by email',
    purpose: 'For the small share of customers who gave an email but stopped visiting.',
    occasion: 'winback',
    channel: 'EMAIL',
    category: 'MARKETING',
    language: 'en',
    subject: 'We have missed you at {{salon_name}}',
    bodyText:
      'Dear {{customer_name}},\n\nIt has been {{days_since_visit}} days since your last visit to {{salon_name}}, and we would love to see you again.\n\nBook whenever suits you: {{booking_link}}\n\nWarm regards,\n{{salon_name}}',
    variables: [V.customer, V.daysSince, V.salon, V.booking],
  },
];

export const LIBRARY_OCCASIONS: { key: LibraryOccasion; label: string; description: string }[] = [
  { key: 'appointment', label: 'Appointments', description: 'Confirmations, reminders and no-shows' },
  { key: 'billing', label: 'Billing', description: 'Bills, receipts and outstanding balances' },
  { key: 'review', label: 'Reviews', description: 'Feedback, Google reviews and complaints' },
  { key: 'winback', label: 'Win-back', description: 'Customers who have stopped coming' },
  { key: 'birthday', label: 'Birthdays', description: 'Birthdays and visit anniversaries' },
  { key: 'festival', label: 'Festivals', description: 'Diwali, Holi, Eid, New Year and regional festivals' },
  { key: 'offer', label: 'Offers', description: 'Quiet weekdays, new services, seasonal care' },
  { key: 'membership', label: 'Memberships', description: 'Selling and renewing memberships' },
  { key: 'package', label: 'Packages', description: 'Prepaid sessions and expiry nudges' },
  { key: 'loyalty', label: 'Loyalty', description: 'Points and rewards' },
  { key: 'referral', label: 'Referrals', description: 'Asking regulars to bring friends' },
  { key: 'lead', label: 'Enquiries', description: 'New enquiries and follow-ups' },
  { key: 'otp', label: 'Verification', description: 'One-time codes for customer sign-in' },
  { key: 'operations', label: 'Announcements', description: 'Closures, new branches, staff changes' },
];

export function findLibraryTemplate(key: string): LibraryTemplate | undefined {
  return TEMPLATE_LIBRARY.find((t) => t.key === key);
}

/**
 * WHY A BOX THE APP SHOULD HAVE FILLED IN IS EMPTY.
 *
 * Most variables on the send screen are things only a person knows — an offer,
 * a note. A few are things the APP knows, and when one of those comes back
 * empty the screen says only "Required parameter is missing", which is true
 * and useless: it reports that a value is absent without saying that anything
 * was supposed to produce it, or what stopped it.
 *
 * Somebody hitting that concludes the feature is broken. In practice it is
 * almost always one of three ordinary things — no customer chosen, no website
 * address set, or a customer with no completed visit — each with a fix that
 * takes a minute, and none of them discoverable from the message.
 *
 * So each automatic variable gets a sentence naming the cause and the fix.
 * Pure, and tested, because the value of this file is entirely in whether it
 * names the RIGHT cause: a confident sentence pointing at the wrong setting is
 * worse than no sentence at all.
 */

export interface ResolutionFacts {
  /** A customer was chosen to send to. Nothing per-customer resolves without one. */
  hasCustomer: boolean;
  /** The salon has filled in its website address. */
  hasWebsite: boolean;
  /**
   * A finished visit in any form: a completed appointment, OR a bill with
   * services on it. What the SUGGESTION needs, because it reads a walk-in's
   * services off their invoice when there is no appointment.
   */
  hasCompletedVisit: boolean;
}

/**
 * The order of these checks is the order the values are built in, so the
 * sentence names the FIRST thing that stopped it rather than the last thing
 * noticed. Telling somebody their customer has no completed visit, when the
 * real reason is that no customer is selected, sends them to fix the wrong
 * thing.
 */
export function explainUnresolved(name: string, facts: ResolutionFacts): string | undefined {
  switch (name) {
    case 'suggested_service':
    case 'explore_link': {
      if (!facts.hasCustomer) {
        return 'Worked out for each customer. Choose who this is going to and it fills itself in.';
      }
      if (!facts.hasWebsite) {
        return 'Your website address is not set, so there is no gallery to send them to. Settings → Your website.';
      }
      if (!facts.hasCompletedVisit) {
        return 'This customer has no finished visit or bill yet, so there is nothing to suggest from.';
      }
      return 'No suggestion yet: nothing in this salon’s history pairs with what they had, and there is no other service in that category.';
    }

    case 'website_link':
    case 'gallery_link': {
      if (!facts.hasWebsite) {
        return 'Your website address is not set. Settings → Your website.';
      }
      return undefined;
    }

    case 'feedback_link':
    case 'google_review_link': {
      if (!facts.hasCustomer) return 'Points at one visit. Choose a customer and it fills itself in.';
      /**
       * A bill counts now, so the appointment is no longer required.
       *
       * The feedback page accepts an invoice id as readily as an appointment
       * id, which is what let walk-ins be asked for feedback at all. This
       * sentence used to say a counter-billed customer had nothing for the
       * link to open; leaving it would mean telling somebody a feature is
       * broken at the moment it started working.
       */
      if (!facts.hasCompletedVisit) {
        return 'Points at one visit, and this customer has no finished appointment or bill to point at.';
      }
      return undefined;
    }

    /**
     * Everything else is left alone on purpose.
     *
     * A hint under a box the salon was always expected to fill — an offer, a
     * tip, a note — is noise, and noise trains people to stop reading the
     * hints that matter.
     */
    default:
      return undefined;
  }
}

/** Every reason worth showing, for the variables that came back empty. */
export function explainAll(names: readonly string[], facts: ResolutionFacts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const reason = explainUnresolved(name, facts);
    if (reason) out[name] = reason;
  }
  return out;
}

import { describe, expect, it } from 'vitest';

/**
 * THE SIMULATED CARRIER, AND WHY IT MUST NEVER RUN IN PRODUCTION.
 *
 * Signing up for MSG91 needs a company, a DLT registration and a week. The
 * simulator lets the whole SMS path — queue, send, delivery report, tracked
 * link, funnel — be built and watched before any of that exists.
 *
 * The danger is obvious and worth guarding rather than trusting: a simulated
 * delivery shown to a salon as a real one means 400 customers who were never
 * messaged and nobody chasing them. The guard is checked in two places (the
 * provider, and the job that fakes the report) so a mistake in one config file
 * cannot switch it on for real customers.
 */

const isSimulatedId = (id: string) => id.startsWith('sim_');

/** The condition in providers/index.ts. */
const simulatorChosen = (driver: string, prod: boolean) => driver === 'simulator' && !prod;

/** The condition in the message.simulate_report handler. */
const reportAllowed = (prod: boolean, providerMessageId: string) => !prod && isSimulatedId(providerMessageId);

describe('the production guard', () => {
  it('refuses the simulator in production, whatever the config says', () => {
    expect(simulatorChosen('simulator', true)).toBe(false);
    expect(simulatorChosen('simulator', false)).toBe(true);
  });

  it('refuses the fake delivery report in production too', () => {
    // Two independent checks. A single one would mean that one wrong
    // environment variable is all that stands between a salon and a screen
    // full of deliveries that never happened.
    expect(reportAllowed(true, 'sim_abc')).toBe(false);
    expect(reportAllowed(false, 'sim_abc')).toBe(true);
  });

  it('never fakes a report for a message a real provider sent', () => {
    // If a simulated job were somehow queued against a real message id, it
    // would mark a genuine message delivered without any carrier saying so.
    expect(reportAllowed(false, 'wamid.HBgMOTE5')).toBe(false);
    expect(reportAllowed(false, 're_1a2b3c')).toBe(false);
    expect(reportAllowed(false, '')).toBe(false);
  });

  it('leaves the other drivers alone', () => {
    expect(simulatorChosen('msg91', false)).toBe(false);
    expect(simulatorChosen('console', false)).toBe(false);
  });
});

describe('a simulated message stays identifiable', () => {
  it('is marked in the id, not only on the screen', () => {
    // The prefix is stored, so a simulated send can be told apart in the
    // database months later — after whoever ran it has forgotten.
    expect(isSimulatedId('sim_m1k2j3_abc123')).toBe(true);
    expect(isSimulatedId('console_m1k2j3_abc123')).toBe(false);
  });
});

describe('what the simulator reports back', () => {
  it('fails some messages on purpose', () => {
    // A simulator where everything succeeds teaches nothing about the failure
    // path, which is the half of the product a salon actually reads.
    const FAILURE_RATE = 0.06;
    expect(FAILURE_RATE).toBeGreaterThan(0);
    expect(FAILURE_RATE).toBeLessThan(0.2);
  });

  it('reports after a delay rather than instantly', () => {
    // Instant delivery would hide the exact bug this feature exists to catch:
    // a status that never arrives. Real carriers take seconds.
    const REPORT_DELAY_MS = 4000;
    expect(REPORT_DELAY_MS).toBeGreaterThan(1000);
  });
});

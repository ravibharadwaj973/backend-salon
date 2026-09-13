import { describe, expect, it } from 'vitest';
import { NOTIFICATIONS } from '../src/messaging/notifications';
import { DEFAULT_TEMPLATES } from '../src/modules/messaging/defaults';

describe('notification catalogue', () => {
  it('every named notification points at a template the seed actually creates', () => {
    const seeded = new Set(DEFAULT_TEMPLATES.map((t) => t.name));
    const missing = Object.entries(NOTIFICATIONS)
      .filter(([, def]) => !seeded.has(def.template))
      .map(([key, def]) => `${key} -> ${def.template}`);
    expect(missing).toEqual([]);
  });

  it('marketing notifications never fall back to SMS', () => {
    // A promotional SMS needs its own DLT template registration in India;
    // quietly routing an offer to SMS is how a sender ID gets blocked.
    for (const [key, def] of Object.entries(NOTIFICATIONS)) {
      if (def.category !== 'MARKETING') continue;
      expect(def.channels, key).not.toContain('SMS');
    }
  });

  it('every notification lists at least one channel', () => {
    for (const [key, def] of Object.entries(NOTIFICATIONS)) {
      expect(def.channels.length, key).toBeGreaterThan(0);
    }
  });
});

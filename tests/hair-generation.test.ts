import { describe, expect, it } from 'vitest';
import { classifyStatus, trustedPollingUrl, unknownModelMessage } from '../src/modules/hair-studio/flux';
import { buildPrompt, buildRecolourPrompt, colourName, describeHair } from '../src/modules/hair-studio/hair-prompt';
import type { PromptInput } from '../src/modules/hair-studio/hair-prompt';

/**
 * WHAT IS WORTH TESTING IN AN INTEGRATION WITH A THIRD PARTY.
 *
 * Not the HTTP. Mocking fetch and asserting that a mocked response is parsed
 * proves the mock matches the code, which is the one thing never in doubt.
 *
 * What IS worth pinning is everything that fails QUIETLY: an allowlist that
 * stops allowing, a status word that stops being recognised, a prompt that
 * silently stops saying "keep the same face". None of those break a build and
 * none of them raise an error — they just produce the wrong picture, or send a
 * key somewhere it should not go.
 */

describe('trustedPollingUrl — where the API key may be sent', () => {
  it('accepts the provider’s own hosts, including regional ones', () => {
    expect(trustedPollingUrl('https://api.bfl.ai/v1/get_result?id=abc')).not.toBeNull();
    expect(trustedPollingUrl('https://api.eu.bfl.ai/v1/get_result?id=abc')).not.toBeNull();
    expect(trustedPollingUrl('https://api.us1.bfl.ai/v1/get_result?id=abc')).not.toBeNull();
    expect(trustedPollingUrl('https://api.bfl.ml/v1/get_result?id=abc')).not.toBeNull();
  });

  /**
   * The attack this exists for: the polling address arrives in a RESPONSE BODY,
   * and the next thing we do with it is attach the API key. A provider having a
   * bad day, a proxy in the middle, or an injected response is otherwise enough
   * to walk the key off to someone else's server, with nothing in the logs
   * looking wrong.
   */
  it('refuses any other host, however plausible it looks', () => {
    expect(trustedPollingUrl('https://bfl.ai.evil.com/v1/get_result')).toBeNull();
    expect(trustedPollingUrl('https://api-bfl.ai/v1/get_result')).toBeNull();
    expect(trustedPollingUrl('https://notbfl.ai/v1/get_result')).toBeNull();
    expect(trustedPollingUrl('https://evil.com/?x=api.bfl.ai')).toBeNull();
  });

  it('refuses plaintext and nonsense', () => {
    expect(trustedPollingUrl('http://api.bfl.ai/v1/get_result')).toBeNull();
    expect(trustedPollingUrl('file:///etc/passwd')).toBeNull();
    expect(trustedPollingUrl('not a url at all')).toBeNull();
    expect(trustedPollingUrl('')).toBeNull();
  });
});

describe('classifyStatus', () => {
  it('separates the three outcomes that need different handling', () => {
    expect(classifyStatus('Ready')).toBe('ready');
    expect(classifyStatus('Pending')).toBe('pending');
    // Moderation can never succeed on retry. Collapsing it into a failure is
    // how a queue ends up paying for the same refusal five times.
    expect(classifyStatus('Request Moderated')).toBe('refused');
    expect(classifyStatus('Content Moderated')).toBe('refused');
    expect(classifyStatus('Error')).toBe('failed');
    expect(classifyStatus('Task not found')).toBe('missing');
  });

  /**
   * An unrecognised word means "keep waiting", not "give up".
   *
   * The provider has added statuses before. Treating a new one as fatal throws
   * away a picture that was on its way and has already been charged for; the
   * poll ceiling stops this being an infinite wait.
   */
  it('treats an unknown status as still in progress', () => {
    expect(classifyStatus('Queued')).toBe('pending');
    expect(classifyStatus('')).toBe('pending');
    expect(classifyStatus(undefined)).toBe('pending');
  });
});

describe('colourName', () => {
  it('names the ends of the range', () => {
    expect(colourName('#000000')).toBe('jet black');
    /*
     * Pure white lands on the platinum end rather than on grey, and that is the
     * right answer for hair: somebody who picks #ffffff is asking for white
     * blonde, not for somebody going grey. The assertion is on the family
     * because that is all this function promises — the nearest word a colourist
     * would use, not a reversible encoding of the hex.
     */
    expect(colourName('#ffffff')).toMatch(/platinum|white/);
    expect(colourName('#9b9b9b')).toBe('silver grey');
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(colourName('  #3B2417  ')).toBe(colourName('#3b2417'));
  });

  /** A hex that is not a hex must not end up in a prompt as the literal string. */
  it('falls back to a word rather than passing junk through', () => {
    expect(colourName('rebeccapurple')).toBe('natural brown');
    expect(colourName('#12345')).toBe('natural brown');
  });

  it('puts a colour in the family a colourist would', () => {
    expect(colourName('#c9a227')).toContain('blonde');
    expect(colourName('#b4441f')).toMatch(/copper|ginger/);
    expect(colourName('#1a0f0a')).toMatch(/black|brown/);
  });
});

const base: PromptInput = {
  hairstyleKey: 'bob',
  styleName: 'Layered bob',
  gender: 'FEMALE',
  texture: 'WAVY',
  length: 'MEDIUM',
  density: 'MEDIUM',
  volume: 50,
  baseColor: '#3b2417',
  config: { bangs: 'CURTAIN', layers: 'MEDIUM', parting: 'CENTER' },
};

describe('describeHair', () => {
  it('says the cut, the length with a landmark, the texture and a colour name', () => {
    const text = describeHair(base);
    expect(text).toContain('layered bob');
    expect(text).toContain('collarbone');
    expect(text).toContain('wavy');
    expect(text).toContain('dark chocolate brown');
    // Never the hex. A model cannot read one, and it is not English.
    expect(text).not.toContain('#');
  });

  it('describes bangs, layers and the parting when they are asked for', () => {
    const text = describeHair(base);
    expect(text).toContain('curtain bangs');
    expect(text).toContain('layered');
    expect(text).toContain('parted in the centre');
  });

  it('says nothing about bangs or layers when there are none', () => {
    // A style whose own name does not contain the word, or this asserts nothing:
    // "a layered bob" would match on the cut's name rather than on a layer clause.
    const text = describeHair({
      ...base,
      hairstyleKey: 'blunt_cut',
      styleName: 'Blunt cut',
      config: { bangs: 'NONE', layers: 'NONE', parting: 'NATURAL' },
    });
    expect(text).not.toContain('bangs');
    expect(text).not.toContain('layered');
    // A "natural" parting is the absence of an instruction, not an instruction.
    expect(text).not.toContain('parted');
  });

  /**
   * Volume is a 0-100 slider and most of it is not worth a word. Every clause in
   * a prompt competes for the model's attention; "52% volume" spends that
   * attention on nothing.
   */
  it('mentions volume only at the ends of the slider', () => {
    expect(describeHair({ ...base, volume: 50 })).not.toMatch(/volume|flat/);
    expect(describeHair({ ...base, volume: 95 })).toContain('volume');
    expect(describeHair({ ...base, volume: 5 })).toContain('flat');
  });

  it('says the guard number for a fade, because that is how it is asked for', () => {
    const faded = describeHair({
      ...base,
      hairstyleKey: 'crew_cut',
      styleName: 'Crew cut',
      length: 'VERY_SHORT',
      config: { bangs: 'NONE', layers: 'NONE', parting: 'NATURAL', fade: { type: 'HIGH', guard: 2, topLength: 40 } },
    });
    expect(faded).toContain('high fade');
    expect(faded).toContain('number 2 guard');
  });

  it('calls a zero guard skin, which is a different picture', () => {
    const skin = describeHair({
      ...base,
      config: { bangs: 'NONE', layers: 'NONE', parting: 'NATURAL', fade: { type: 'LOW', guard: 0, topLength: 40 } },
    });
    expect(skin).toContain('skin');
    expect(skin).not.toContain('number 0');
  });

  it('spells out an ombre as two named colours rather than two hexes', () => {
    const text = describeHair({
      ...base,
      config: {
        ...base.config,
        ombre: { enabled: true, rootColor: '#1c1512', endColor: '#d9a95c' },
      } as PromptInput['config'],
    });
    expect(text).toContain('natural black');
    expect(text).toContain('golden blonde');
    expect(text).not.toContain('#');
  });

  it('ignores a colour effect that is switched off', () => {
    const text = describeHair({
      ...base,
      config: { ...base.config, highlights: { enabled: false, color: '#f2e2c4', intensity: 'STRONG' } } as PromptInput['config'],
    });
    expect(text).not.toContain('highlights');
  });
});

describe('buildPrompt', () => {
  /**
   * The subject is held still on purpose. A model left to invent a person draws
   * whatever its training data thinks belongs in a hair advert, and a salon's
   * look-book is a catalogue of haircuts rather than of people.
   */
  it('fixes the framing, the background and the expression', () => {
    const text = buildPrompt(base);
    expect(text).toContain('head and shoulders');
    expect(text).toContain('neutral expression');
    expect(text).toContain('studio background');
    expect(text).toContain('adult female model');
  });

  it('describes an adult model whatever the gender is, and never a named person', () => {
    expect(buildPrompt({ ...base, gender: 'MALE' })).toContain('adult male model');
    expect(buildPrompt({ ...base, gender: 'UNISEX' })).toContain('adult model');
    expect(buildPrompt({ ...base, gender: null })).toContain('adult model');
  });

  /**
   * THE ONE ASSERTION THAT MATTERS MOST.
   *
   * An edit that quietly returns a different woman is worse than no edit at all,
   * because the salon has already told a customer this is what she will look
   * like. The instruction to keep the face has to come FIRST, before every clause
   * that grants licence to change something.
   */
  it('leads an edit with keeping the person, not with the new hair', () => {
    const text = buildPrompt({ ...base, editing: true });
    expect(text.indexOf('same face')).toBeLessThan(text.indexOf('layered bob'));
    expect(text).toContain('Change only the hair');
    expect(text).toContain('same skin tone');
    expect(text).toContain('same age');
    expect(text).toContain('same background');
  });
});

describe('buildRecolourPrompt', () => {
  /**
   * Narrower than a full edit, deliberately. The cut in the source image is the
   * one the salon just approved; naming it again invites the model to re-cut it,
   * and the shape comes back subtly different.
   */
  it('talks about pigment and explicitly leaves the cut alone', () => {
    const text = buildRecolourPrompt({ ...base, baseColor: '#b4441f', editing: true });
    expect(text).toContain('Change only the colour');
    expect(text).toContain('same haircut');
    expect(text).toContain('same length');
    expect(text).toMatch(/copper|ginger/);
    // It must not re-describe the cut it is meant to preserve.
    expect(text).not.toContain('curtain bangs');
    expect(text).not.toContain('collarbone');
  });

  it('carries colour effects across but still nothing about the shape', () => {
    const text = buildRecolourPrompt({
      ...base,
      baseColor: '#1c1512',
      config: {
        ...base.config,
        balayage: { enabled: true, color: '#d9a95c', intensity: 'MEDIUM', placement: 'ENDS' },
      } as PromptInput['config'],
      editing: true,
    });
    expect(text).toContain('balayage');
    expect(text).toContain('on the ends only');
    expect(text).not.toContain('wavy');
  });
});

describe('a wrong model name', () => {
  /**
   * THE FAILURE THIS INTEGRATION ACTUALLY HIT, TWICE, ON ITS FIRST REAL RUN.
   *
   * The model is a path segment, so an unknown one is an unknown ROUTE and the
   * provider answers FastAPI's default body — {"detail":"Not Found"}. Passed
   * through, the salon reads the words "Not Found": true, useless, and
   * indistinguishable from the provider being down. The configured slug was
   * `flux-2-klein`; the endpoint is `flux-2-klein-9b`.
   *
   * The person reading this message is the one who can fix it in one line, so the
   * test holds it to naming the setting and the value that is wrong.
   */
  it('names the setting and the value, not just the status', () => {
    const message = unknownModelMessage('flux-2-klein');
    expect(message).toContain('flux-2-klein');
    expect(message).toContain('BFL_MODEL');
    expect(message).not.toMatch(/^Not Found$/);
  });

  it('points at where the real names are listed', () => {
    const message = unknownModelMessage('whatever');
    expect(message).toContain('docs.bfl.ai');
    expect(message).toContain('flux-2-klein-9b');
  });
});

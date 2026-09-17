import crypto from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

/**
 * The email delivery webhook is a public URL that writes to the database, and
 * one of the things it writes is "stop emailing this person". Forging a bounce
 * for a competitor's best customer costs nothing if the endpoint is open, and
 * nobody would notice for months.
 *
 * So the middleware is exercised for real here, not re-implemented: the secret
 * is set before the module loads, and each case builds the headers Svix would.
 */

const SECRET_BODY = crypto.randomBytes(24).toString('base64');
const SECRET = `whsec_${SECRET_BODY}`;

let verifyResendSignature: (req: Request, res: Response, next: NextFunction) => void;

beforeAll(async () => {
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  ({ verifyResendSignature } = await import('../src/modules/webhooks/resend-signature'));
});

function sign(id: string, timestamp: string, raw: Buffer, secret = SECRET_BODY): string {
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${timestamp}.${raw.toString('utf8')}`)
    .digest('base64');
}

/** A request the middleware can read, with only the parts it touches. */
function request(headers: Record<string, string | undefined>, raw?: Buffer): Request {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    rawBody: raw,
  } as unknown as Request;
}

/** Runs the middleware and reports what it did. */
function run(req: Request): { passed: boolean; status: number | null } {
  let status: number | null = null;
  let passed = false;
  const res = { sendStatus: (code: number) => { status = code; } } as unknown as Response;
  verifyResendSignature(req, res, () => { passed = true; });
  return { passed, status };
}

const body = Buffer.from(JSON.stringify({ type: 'email.bounced', data: { email_id: 're_1' } }));
const now = () => String(Math.floor(Date.now() / 1000));

describe('the Resend webhook signature', () => {
  it('lets through an event Resend signed', () => {
    const id = 'msg_1';
    const ts = now();
    expect(run(request({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sign(id, ts, body)}` }, body))).toEqual({
      passed: true,
      status: null,
    });
  });

  it('rejects a body altered after it was signed', () => {
    const id = 'msg_2';
    const ts = now();
    const header = `v1,${sign(id, ts, body)}`;
    const tampered = Buffer.from(JSON.stringify({ type: 'email.bounced', data: { email_id: 're_999' } }));
    expect(run(request({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': header }, tampered)).status).toBe(401);
  });

  it('rejects a signature made with someone else’s secret', () => {
    const id = 'msg_3';
    const ts = now();
    const other = crypto.randomBytes(24).toString('base64');
    expect(
      run(request({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sign(id, ts, body, other)}` }, body)).status,
    ).toBe(401);
  });

  it('rejects an unsigned request outright — that is what a forgery looks like', () => {
    expect(run(request({}, body)).status).toBe(401);
    expect(run(request({ 'svix-id': 'msg_4', 'svix-timestamp': now() }, body)).status).toBe(401);
  });

  it('rejects a replay of a real event from an hour ago', () => {
    // The signature is still perfectly valid; only the clock says no.
    const id = 'msg_5';
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    expect(run(request({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sign(id, ts, body)}` }, body)).status).toBe(401);
  });

  it('rejects an event whose signature was made for a different delivery id', () => {
    const ts = now();
    const header = `v1,${sign('msg_6', ts, body)}`;
    expect(run(request({ 'svix-id': 'msg_7', 'svix-timestamp': ts, 'svix-signature': header }, body)).status).toBe(401);
  });

  it('accepts either signature while the secret is being rotated', () => {
    // Svix sends both, space separated, so one match has to be enough.
    const id = 'msg_8';
    const ts = now();
    const old = crypto.randomBytes(24).toString('base64');
    const header = `v1,${sign(id, ts, body, old)} v1,${sign(id, ts, body)}`;
    expect(run(request({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': header }, body)).passed).toBe(true);
  });

  it('ignores a signature version it does not understand', () => {
    const id = 'msg_9';
    const ts = now();
    expect(run(request({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v2,${sign(id, ts, body)}` }, body)).status).toBe(401);
  });
});

describe('when no secret is configured', () => {
  it('passes the request through, but says so loudly', async () => {
    vi.resetModules();
    process.env.RESEND_WEBHOOK_SECRET = '';
    const { verifyResendSignature: unconfigured } = await import('../src/modules/webhooks/resend-signature');
    const { logger } = await import('../src/core/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    let passed = false;
    unconfigured(request({}, body), { sendStatus: () => undefined } as unknown as Response, () => { passed = true; });

    expect(passed).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

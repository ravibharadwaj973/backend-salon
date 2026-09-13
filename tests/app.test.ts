import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('http surface', () => {
  it('answers the liveness probe', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('refuses protected routes without a token', async () => {
    const res = await request(app).get('/api/v1/customers');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token rather than trusting it', async () => {
    const res = await request(app).get('/api/v1/customers').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  /**
   * Feature-gated routes are mounted as `authenticate → requireFeature → router`.
   * Get that order wrong and the gate reads `req.auth.tenantId` on an
   * unauthenticated request, which crashes with a TypeError instead of
   * answering 401 — and leaks nothing useful while failing loudly in the app.
   *
   * A 500 here means the middleware order has regressed.
   */
  it.each([
    '/api/v1/leads',
    '/api/v1/packages',
    '/api/v1/memberships',
    '/api/v1/loyalty',
    '/api/v1/expenses',
    '/api/v1/inventory',
    '/api/v1/segments',
    '/api/v1/campaigns',
    '/api/v1/journeys',
  ])('answers 401 rather than crashing on %s without a token', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('validates the request body before touching the database', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('attaches a request id to every response', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  // Deleting a plan is a platform-operator action, not a salon one. A salon
  // token must not reach it at all, and neither must an anonymous caller —
  // 401 here proves the route is mounted behind the platform guard rather
  // than missing, which a 404 would not distinguish.
  it('keeps plan deletion behind the platform guard', async () => {
    const res = await request(app).delete('/api/v1/platform/plans/whatever');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

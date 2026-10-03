import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index.js';
import { memKV } from './helpers.js';

const PI = 'pi-secret-123';
const WATCH = 'watch-secret-9';
let env;

const call = (method, path, key, body) =>
  worker.fetch(
    new Request(`https://ap127-readiness.test${path}`, {
      method,
      headers: { ...(key ? { 'X-Key': key } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );

const PLAN = {
  v: 1,
  gen: '2026-10-03T22:15:00+07:00',
  ge: 1791090900,
  moves: [
    { id: 'm-apply', w: 'Long run 25 km', from: '2026-10-09', to: '2026-10-10', rule: 'R2', why: 'x', ap: 1 },
    { id: 'm-advice', w: 'Tempo', from: '2026-10-06', to: '2026-10-07', rule: 'R1', why: 'y', ap: 0 },
  ],
  applies: [],
};

beforeEach(() => {
  env = { READINESS_KV: memKV(), PI_KEY: PI, WATCH_KEY: WATCH };
});

describe('auth', () => {
  it('401s without a key', async () => {
    expect((await call('GET', '/plan')).status).toBe(401);
  });
  it('403s the watch key on Pi routes and vice versa', async () => {
    expect((await call('PUT', '/plan', WATCH, PLAN)).status).toBe(403);
    expect((await call('GET', '/apply/pending', WATCH)).status).toBe(403);
    expect((await call('GET', '/plan', PI)).status).toBe(403);
    expect((await call('POST', '/apply', PI, { id: 'm-apply' })).status).toBe(403);
  });
  it('404s unknown routes for an authenticated caller', async () => {
    expect((await call('GET', '/nope', WATCH)).status).toBe(404);
  });
});

describe('plan round-trip', () => {
  it('404s before any plan is published', async () => {
    const r = await call('GET', '/plan', WATCH);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'no_plan' });
  });
  it('stores a valid plan and serves it to the watch', async () => {
    expect((await call('PUT', '/plan', PI, PLAN)).status).toBe(204);
    const r = await call('GET', '/plan', WATCH);
    expect(r.status).toBe(200);
    const got = await r.json();
    expect(got.gen).toBe(PLAN.gen);
    expect(got.moves).toHaveLength(2);
    expect(got.applies).toEqual([]);
  });
  it('rejects an invalid plan with a reason', async () => {
    const r = await call('PUT', '/plan', PI, '{bad');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_json' });
  });
});

describe('apply flow', () => {
  beforeEach(async () => {
    await call('PUT', '/plan', PI, PLAN);
  });

  it('queues an applyable move and shows it as pending on the next GET /plan', async () => {
    const r = await call('POST', '/apply', WATCH, { id: 'm-apply' });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ id: 'm-apply', st: 'pending' });
    const plan = await (await call('GET', '/plan', WATCH)).json();
    expect(plan.applies).toEqual([{ id: 'm-apply', st: 'pending', why: '' }]);
  });

  it('refuses advice-only and unknown moves', async () => {
    expect((await call('POST', '/apply', WATCH, { id: 'm-advice' })).status).toBe(409);
    expect((await call('POST', '/apply', WATCH, { id: 'm-nope' })).status).toBe(409);
  });

  it('is idempotent while pending', async () => {
    await call('POST', '/apply', WATCH, { id: 'm-apply' });
    const again = await call('POST', '/apply', WATCH, { id: 'm-apply' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: 'm-apply', st: 'pending' });
  });

  it('lets the Pi read pending applies and post a result', async () => {
    await call('POST', '/apply', WATCH, { id: 'm-apply' });
    const pend = await (await call('GET', '/apply/pending', PI)).json();
    expect(pend.pending.map((p) => p.id)).toEqual(['m-apply']);

    const res = await call('POST', '/apply/result', PI, { id: 'm-apply', st: 'failed', why: 'x'.repeat(200) });
    expect(res.status).toBe(200);
    const plan = await (await call('GET', '/plan', WATCH)).json();
    expect(plan.applies[0].st).toBe('failed');
    expect(plan.applies[0].why).toHaveLength(80);
    expect((await (await call('GET', '/apply/pending', PI)).json()).pending).toEqual([]);
  });

  it('allows a retry after a failure', async () => {
    await call('POST', '/apply', WATCH, { id: 'm-apply' });
    await call('POST', '/apply/result', PI, { id: 'm-apply', st: 'failed', why: 'boom' });
    expect((await call('POST', '/apply', WATCH, { id: 'm-apply' })).status).toBe(202);
  });

  it('validates results', async () => {
    expect((await call('POST', '/apply/result', PI, { id: 'm-apply', st: 'weird' })).status).toBe(400);
    expect((await call('POST', '/apply/result', PI, { id: 'm-ghost', st: 'ok' })).status).toBe(404);
  });

  it('rate-limits to 10 applies per hour', async () => {
    for (let i = 0; i < 10; i++) {
      await call('POST', '/apply', WATCH, { id: 'm-apply' });
      await call('POST', '/apply/result', PI, { id: 'm-apply', st: 'failed', why: '' });
    }
    expect((await call('POST', '/apply', WATCH, { id: 'm-apply' })).status).toBe(429);
  });
});

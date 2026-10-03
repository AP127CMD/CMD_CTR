import {
  roleFor, validatePlan, findApplyableMove, hourBucket,
  RESULT_STATES, APPLY_LIMIT_PER_HOUR, APPLY_TTL_S,
} from './lib.js';

// Storage + relay only. The Pi (pi-native/readiness) computes every plan and move;
// this Worker never decides anything beyond auth, shape and the move whitelist.
const PLAN_KEY = 'plan:latest';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function readApplies(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'apply:', cursor });
    for (const k of page.keys) {
      const rec = await kv.get(k.name, 'json');
      if (rec) out.push(rec);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

const ROUTES = {
  'PUT /plan': { role: 'pi', handler: putPlan },
  'GET /plan': { role: 'watch', handler: getPlan },
  'POST /apply': { role: 'watch', handler: postApply },
  'GET /apply/pending': { role: 'pi', handler: getPending },
  'POST /apply/result': { role: 'pi', handler: postResult },
};

async function putPlan(request, kv) {
  const text = await request.text();
  const err = validatePlan(text);
  if (err) return json({ error: err }, 400);
  await kv.put(PLAN_KEY, text);
  return new Response(null, { status: 204 });
}

async function getPlan(_request, kv) {
  const plan = await kv.get(PLAN_KEY, 'json');
  if (!plan) return json({ error: 'no_plan' }, 404);
  plan.applies = (await readApplies(kv)).map(({ id, st, why }) => ({ id, st, why }));
  return json(plan);
}

async function postApply(request, kv) {
  const body = await readJsonBody(request);
  const id = body && typeof body.id === 'string' ? body.id : '';
  const plan = await kv.get(PLAN_KEY, 'json');
  if (!findApplyableMove(plan, id)) return json({ error: 'unknown_move' }, 409);

  const existing = await kv.get(`apply:${id}`, 'json');
  if (existing && existing.st !== 'failed') return json({ id, st: existing.st }, 200);

  const bucket = `rl:${hourBucket(Date.now())}`;
  const used = parseInt((await kv.get(bucket)) || '0', 10);
  if (used >= APPLY_LIMIT_PER_HOUR) return json({ error: 'rate_limited' }, 429);
  await kv.put(bucket, String(used + 1), { expirationTtl: 7200 });

  const rec = { id, st: 'pending', why: '', at: new Date().toISOString() };
  await kv.put(`apply:${id}`, JSON.stringify(rec), { expirationTtl: APPLY_TTL_S });
  return json({ id, st: 'pending' }, 202);
}

async function getPending(_request, kv) {
  return json({ pending: (await readApplies(kv)).filter((a) => a.st === 'pending') });
}

async function postResult(request, kv) {
  const body = (await readJsonBody(request)) || {};
  if (!RESULT_STATES.has(body.st)) return json({ error: 'bad_state' }, 400);
  const existing = await kv.get(`apply:${body.id}`, 'json');
  if (!existing) return json({ error: 'unknown_apply' }, 404);
  const rec = { ...existing, st: body.st, why: String(body.why || '').slice(0, 80), at: new Date().toISOString() };
  await kv.put(`apply:${body.id}`, JSON.stringify(rec), { expirationTtl: APPLY_TTL_S });
  return json({ id: body.id, st: body.st });
}

export default {
  async fetch(request, env) {
    const role = roleFor(request, env);
    if (!role) return json({ error: 'unauthorized' }, 401);
    const { pathname } = new URL(request.url);
    const route = ROUTES[`${request.method} ${pathname}`];
    if (!route) return json({ error: 'not_found' }, 404);
    if (route.role !== role) return json({ error: 'forbidden' }, 403);
    return route.handler(request, env.READINESS_KV);
  },
};

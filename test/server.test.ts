import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, handleDecide, handleEvent, handleOptions, handleTick } from '../src/server/handlers.ts';
import { MemoryStore } from '../src/server/memory-store.ts';
import type { DecideResponse } from '../src/server/types.ts';
import { ADMIN, CRON, DAY, ORIGIN, adminReq, decideReq, eventReq, experimentBody, makeCtx, titleCtx, visitorId } from './support/fixtures.ts';

const EXP = 'exp_test0001';

async function setup(body: Record<string, unknown> = experimentBody()) {
  const env = makeCtx();
  const res = await handleAdmin(adminReq('POST', '/experiments', body), env.ctx);
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return env;
}

const decide = async (env: ReturnType<typeof makeCtx>, v: string, p = '/', headers: Record<string, string> = {}) => {
  const res = await handleDecide(decideReq(EXP, v, p, headers), env.ctx);
  return { res, body: (await res.json()) as DecideResponse };
};

// ------------------------------------------------------------------ creating an experiment

test('an experiment with safe changes is created in the canary stage', async () => {
  const env = makeCtx();
  const res = await handleAdmin(adminReq('POST', '/experiments', experimentBody()), env.ctx);
  const body = (await res.json()) as { ok: boolean; stage: string; weights: Record<string, number> };
  assert.equal(res.status, 201);
  assert.equal(body.stage, 'canary');
  assert.ok(Math.abs(body.weights.v1 - 0.01) < 1e-12 && Math.abs(body.weights.original - 0.98) < 1e-12);
  assert.equal((await handleAdmin(adminReq('POST', '/experiments', experimentBody()), env.ctx)).status, 409, 'same id twice');
});

test('creation is refused, with reasons, when a variant breaks the safety rules', async () => {
  const env = makeCtx();
  const bad = experimentBody({
    variants: {
      v1: { label: 'Fake deadline', changes: [{ selector: 'h1.hero-title', kind: 'text', text: 'Save 30% this week', context: titleCtx }] },
      v2: { label: 'Locked place', changes: [{ selector: 'div.price-box', kind: 'text', text: 'Cheap', context: titleCtx }] },
    },
  });
  const res = await handleAdmin(adminReq('POST', '/experiments', bad), env.ctx);
  const body = (await res.json()) as { errors: string[] };
  assert.equal(res.status, 422);
  assert.ok(body.errors.some((e) => /v1.*facts/.test(e)));
  assert.ok(body.errors.some((e) => /v1.*honesty/.test(e)));
  assert.ok(body.errors.some((e) => /v2.*scope/.test(e)));
  assert.equal((await env.ctx.store.listAll()).length, 0, 'nothing is stored');
});

test('creation checks the shape of everything it is given', async () => {
  const env = makeCtx();
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['no name', { name: '' }, /name/],
    ['bad origin', { allowedOrigins: ['https://site.example/path'] }, /allowedOrigins/],
    ['no origins', { allowedOrigins: [] }, /allowedOrigins/],
    ['bad target', { target: { path: 'home' } }, /target/],
    ['bad goal', { goal: { type: 'click' } }, /goal/],
    ['unknown setting', { config: { nope: 1 } }, /not a setting/],
    ['out of range setting', { config: { draws: 99_999_999 } }, /between/],
    ['fixed setting', { config: { guardrails: { errorRatio: 100 } } }, /cannot be changed/],
    ['control as a variant', { variants: { original: { label: 'x', changes: [] } } }, /original/],
    ['no variants', { variants: {} }, /variants/],
    ['policy missing', { policy: undefined }, /policy/],
  ];
  for (const [name, over, re] of cases) {
    const res = await handleAdmin(adminReq('POST', '/experiments', experimentBody(over)), env.ctx);
    const body = (await res.json()) as { errors: string[] };
    assert.equal(res.status, 422, name);
    assert.ok(body.errors.some((e) => re.test(e)), `${name}: ${body.errors.join(' | ')}`);
  }
  const notJson = await handleAdmin(new Request('https://hone.example/api/admin/experiments', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` }, body: '{oops' }), env.ctx);
  assert.equal(notJson.status, 400);
});

test('the admin endpoints need the token, and are off when none is set', async () => {
  const env = makeCtx();
  assert.equal((await handleAdmin(adminReq('GET', '/experiments', undefined, null), env.ctx)).status, 401);
  assert.equal((await handleAdmin(adminReq('GET', '/experiments', undefined, 'wrong'), env.ctx)).status, 401);
  assert.equal((await handleAdmin(adminReq('GET', '/experiments'), env.ctx)).status, 200);
  const off = makeCtx(new MemoryStore(), { adminToken: undefined });
  assert.equal((await handleAdmin(adminReq('GET', '/experiments'), off.ctx)).status, 503);
});

// ------------------------------------------------------------------ deciding

test('a visitor gets a variant, the same one every time, and the changes that go with it', async () => {
  const env = await setup();
  const seen: Record<string, number> = { original: 0, v1: 0, v2: 0 };
  const first = new Map<string, string>();
  for (let i = 0; i < 3000; i++) {
    const { body } = await decide(env, visitorId(i));
    assert.equal(body.assigned, true);
    assert.equal(body.track, true);
    first.set(visitorId(i), body.variant as string);
    seen[body.variant as string]++;
    if (body.variant === 'original') assert.deepEqual(body.changes, []);
    if (body.variant === 'v1') assert.equal(body.changes[0].kind === 'text' && body.changes[0].text, 'Learn AI without the jargon');
  }
  assert.ok(seen.v1 > 10 && seen.v1 < 60, `v1 got ${seen.v1} of 3000 (expected about 1%)`);
  assert.ok(seen.v2 > 10 && seen.v2 < 60, `v2 got ${seen.v2} of 3000`);
  for (let i = 0; i < 3000; i++) assert.equal((await decide(env, visitorId(i))).body.variant, first.get(visitorId(i)));
  assert.deepEqual((await decide(env, visitorId(1))).body.goal, { type: 'click', selector: 'a.hero-cta' });
});

test('pages other than the target page assign nobody, but know visitors who were assigned', async () => {
  const env = await setup();
  const a = await decide(env, visitorId(1), '/about');
  assert.deepEqual([a.body.assigned, a.body.variant, a.body.target, a.body.track], [false, null, false, false]);
  assert.equal((await env.ctx.store.getVisitor(EXP, visitorId(1))), null, 'nothing was stored');

  const home = await decide(env, visitorId(1), '/');
  assert.equal(home.body.assigned, true);
  const other = await decide(env, visitorId(1), '/thanks');
  assert.deepEqual([other.body.assigned, other.body.variant, other.body.target, other.body.track], [true, home.body.variant, false, true]);
  assert.deepEqual(other.body.changes, [], 'changes only apply on the target page');
});

test('target paths match with or without a trailing slash and a query', async () => {
  const env = await setup(experimentBody({ target: { path: '/courses/', match: 'prefix' } }));
  assert.equal((await decide(env, visitorId(1), '/courses')).body.target, true);
  assert.equal((await decide(env, visitorId(1), '/courses/ai/?utm=1')).body.target, true);
  assert.equal((await decide(env, visitorId(1), '/coursesx')).body.target, false);
});

test('only listed sites may read the answers; the right one gets its own origin back', async () => {
  const env = await setup();
  const ok = await decide(env, visitorId(1), '/', { origin: ORIGIN });
  assert.equal(ok.res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.res.headers.get('vary') ?? '', /Origin/);
  const bad = await decide(env, visitorId(2), '/', { origin: 'https://evil.example' });
  assert.equal(bad.res.status, 403);
  assert.equal(bad.res.headers.get('access-control-allow-origin'), null);
  assert.equal(await env.ctx.store.getVisitor(EXP, visitorId(2)), null, 'a refused call stores nothing');
  assert.equal(handleOptions().status, 204);
});

test('bad requests and unknown experiments are refused without touching the store', async () => {
  const env = await setup();
  for (const [e, v, p] of [['', visitorId(1), '/'], [EXP, 'short', '/'], [EXP, visitorId(1), 'nope'], ['bad key!', visitorId(1), '/']] as const) {
    assert.equal((await handleDecide(decideReq(e, v, p), env.ctx)).status, 400, `${e}|${v}|${p}`);
  }
  assert.equal((await handleDecide(decideReq('exp_missing', visitorId(1)), env.ctx)).status, 404);
});

test('bots, Do Not Track and Global Privacy Control see the original and are never stored', async () => {
  const env = await setup();
  const cases: Array<Record<string, string>> = [
    { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
    { 'user-agent': 'Mozilla/5.0 HeadlessChrome/126.0' },
    { 'user-agent': '' },
    { 'sec-gpc': '1' },
    { dnt: '1' },
  ];
  for (const [i, headers] of cases.entries()) {
    const { body } = await decide(env, visitorId(i), '/', headers);
    assert.deepEqual([body.variant, body.assigned, body.track, body.changes], ['original', false, false, []], JSON.stringify(headers));
    assert.equal(await env.ctx.store.getVisitor(EXP, visitorId(i)), null);
  }
});

test('kill switch: everyone sees the original at once, nothing is recorded, and resuming brings back the same variants', async () => {
  const env = await setup(experimentBody({ config: { canaryShare: 0.5 } }));
  const before = new Map<string, string>();
  for (let i = 0; i < 200; i++) before.set(visitorId(i), (await decide(env, visitorId(i))).body.variant as string);
  assert.ok([...before.values()].includes('v1'));

  const kill = await handleAdmin(adminReq('POST', `/experiments/${EXP}/kill`, { reason: 'checking' }), env.ctx);
  assert.deepEqual(await kill.json(), { ok: true, changed: true, killed: true });
  for (let i = 0; i < 400; i++) {
    const { body } = await decide(env, visitorId(i));
    assert.deepEqual([body.variant, body.changes, body.track], ['original', [], false]);
  }
  assert.equal(await env.ctx.store.getVisitor(EXP, visitorId(399)), null, 'new visitors are not stored while killed');
  const ev = await handleEvent(eventReq({ e: EXP, v: visitorId(1), t: 'goal', p: '/' }), env.ctx);
  assert.equal(ev.status, 204);
  assert.equal((await env.ctx.store.getVisitor(EXP, visitorId(1)))?.convertedAt, null, 'goals are dropped while killed');

  assert.equal(((await (await handleAdmin(adminReq('POST', `/experiments/${EXP}/kill`), env.ctx)).json()) as { changed: boolean }).changed, false, 'pressing twice changes nothing');
  await handleAdmin(adminReq('POST', `/experiments/${EXP}/resume`, { reason: 'all clear' }), env.ctx);
  for (let i = 0; i < 200; i++) assert.equal((await decide(env, visitorId(i))).body.variant, before.get(visitorId(i)));

  const status = (await (await handleAdmin(adminReq('GET', `/experiments/${EXP}`), env.ctx)).json()) as { audit: Array<{ action: string; actor: string; reason: string }> };
  const kills = status.audit.filter((a) => a.action.startsWith('kill_switch'));
  assert.deepEqual(kills.map((a) => [a.action, a.actor, a.reason]), [['kill_switch_on', 'person', 'checking'], ['kill_switch_off', 'person', 'all clear']]);
});

// ------------------------------------------------------------------ events

async function assignTo(env: ReturnType<typeof makeCtx>, wanted: string, from = 0): Promise<string> {
  for (let i = from; i < from + 20000; i++) {
    const { body } = await decide(env, visitorId(i));
    if (body.variant === wanted) return visitorId(i);
  }
  throw new Error(`nobody got ${wanted}`);
}

test('views, health and goals are recorded against the variant the visitor was shown', async () => {
  const env = await setup(experimentBody({ config: { canaryShare: 0.5 } }));
  const id = await assignTo(env, 'v1');
  for (const body of [
    { e: EXP, v: id, t: 'view', p: '/', err: 0 },
    { e: EXP, v: id, t: 'view', p: '/', err: 1 },
    { e: EXP, v: id, t: 'health', p: '/', err: 0, lcp: 1800 },
    { e: EXP, v: id, t: 'goal', p: '/' },
  ]) assert.equal((await handleEvent(eventReq(body), env.ctx)).status, 204);

  env.clock.t += 7 * DAY + 1;
  const row = (await env.ctx.store.getExperiment(EXP))!;
  const m = await env.ctx.store.measure(EXP, { order: ['original', 'v1', 'v2'], now: env.clock.t, windowMs: 7 * DAY, lagMs: DAY, confirmPhase: null, confirmN: 0, phase: row.state.phase });
  assert.deepEqual([m.variants.v1.views, m.variants.v1.errors, m.variants.v1.lcpN, m.variants.v1.lcpSum], [2, 1, 1, 1800]);
  assert.deepEqual([m.variants.original.views, m.variants.v2.views], [0, 0]);
  assert.equal(m.variants.v1.total.s, 1);
  assert.equal(Object.values(m.dayViews).reduce((a, b) => a + b, 0), 2);
});

test('events for unknown visitors, wrong pages, bots and bad bodies change nothing', async () => {
  const env = await setup(experimentBody({ config: { canaryShare: 0.5 } }));
  const id = await assignTo(env, 'v1');
  const drop = async (body: unknown, headers: Record<string, string> = {}) => handleEvent(eventReq(body, headers), env.ctx);

  assert.equal((await drop({ e: EXP, v: visitorId(99_999), t: 'view', p: '/' })).status, 204, 'never assigned');
  assert.equal((await drop({ e: EXP, v: id, t: 'view', p: '/about' })).status, 204, 'not the target page');
  assert.equal((await drop({ e: EXP, v: id, t: 'view', p: '/' }, { 'user-agent': 'Googlebot/2.1' })).status, 204);
  assert.equal((await drop({ e: EXP, v: id, t: 'view', p: '/' }, { 'sec-gpc': '1' })).status, 204);
  assert.equal((await drop({ e: EXP, v: id, t: 'view', p: '/' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await drop('{nope')).status, 400);
  assert.equal((await drop({ e: EXP, v: id, t: 'bogus', p: '/' })).status, 400);
  assert.equal((await drop({ e: EXP, v: id, t: 'health', p: '/', lcp: -5 })).status, 400);
  assert.equal((await drop({ e: EXP, v: id, t: 'health', p: '/', lcp: 9_999_999 })).status, 400);
  assert.equal((await drop({ e: EXP, v: id, t: 'view', p: '/', err: 7 })).status, 400);
  assert.equal((await drop('x'.repeat(3000))).status, 413);
  assert.equal((await handleEvent(new Request('https://hone.example/api/event'), env.ctx)).status, 405);
  assert.equal((await drop({ e: 'exp_nothere', v: id, t: 'view', p: '/' })).status, 404);

  const m = await env.ctx.store.measure(EXP, { order: ['original', 'v1', 'v2'], now: env.clock.t, windowMs: 7 * DAY, lagMs: DAY, confirmPhase: null, confirmN: 0, phase: 0 });
  assert.equal(m.variants.v1.views + m.variants.original.views + m.variants.v2.views, 0);
});

test('a page-view goal only counts on its own page, and a goal counts once, inside the window', async () => {
  const env = await setup(experimentBody({ goal: { type: 'pageview', path: '/thanks' }, config: { canaryShare: 0.5 } }));
  const id = await assignTo(env, 'v1');
  await handleEvent(eventReq({ e: EXP, v: id, t: 'goal', p: '/elsewhere' }), env.ctx);
  assert.equal((await env.ctx.store.getVisitor(EXP, id))?.convertedAt, null);
  env.clock.t += 2 * DAY;
  await handleEvent(eventReq({ e: EXP, v: id, t: 'goal', p: '/thanks' }), env.ctx);
  const at = (await env.ctx.store.getVisitor(EXP, id))?.convertedAt;
  assert.equal(at, env.clock.t);
  env.clock.t += DAY;
  await handleEvent(eventReq({ e: EXP, v: id, t: 'goal', p: '/thanks' }), env.ctx);
  assert.equal((await env.ctx.store.getVisitor(EXP, id))?.convertedAt, at, 'the second goal does not move the first');

  const late = await assignTo(env, 'v1', 5000);
  env.clock.t += 8 * DAY;
  await handleEvent(eventReq({ e: EXP, v: late, t: 'goal', p: '/thanks' }), env.ctx);
  assert.equal((await env.ctx.store.getVisitor(EXP, late))?.convertedAt, null, 'outside the 7-day window');
});

// ------------------------------------------------------------------ the tick

test('the cron endpoint needs its secret, and moves the experiment forward', async () => {
  const env = await setup(experimentBody({ config: { canaryShare: 0.5, canaryMinExposures: 300, warmupMinDays: 7 } }));
  const call = (token: string | null) => handleTick(new Request('https://hone.example/api/cron/tick', { headers: token ? { authorization: `Bearer ${token}` } : {} }), env.ctx);
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('nope')).status, 401);

  for (let i = 0; i < 2000; i++) await decide(env, visitorId(i));
  env.clock.t += 2 * DAY;
  const res = await call(CRON);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { results: Record<string, string> };
  assert.equal(body.results[EXP], 'done');
  const status = (await (await handleAdmin(adminReq('GET', `/experiments/${EXP}`), env.ctx)).json()) as { stage: string; audit: Array<{ action: string }> };
  assert.equal(status.stage, 'warmup', 'enough visitors and a day have passed, so the canary ends');
  assert.ok(status.audit.some((a) => a.action === 'stage_warmup'));
});

test('the cron endpoint is off when no secret is configured', async () => {
  const env = makeCtx(new MemoryStore(), { cronSecret: undefined });
  assert.equal((await handleTick(new Request('https://hone.example/api/cron/tick', { headers: { authorization: 'Bearer x' } }), env.ctx)).status, 503);
});

test('two ticks at once: one does the work, the other steps aside', async () => {
  const env = await setup();
  const { runTick } = await import('../src/server/tick.ts');
  assert.equal(await env.ctx.store.claimTick(EXP, 'someone-else', env.clock.t, 120_000), true);
  assert.equal(await runTick(env.ctx.store, EXP, env.clock.t), 'busy');
  assert.equal(await env.ctx.store.saveTick(EXP, 'wrong-token', (await env.ctx.store.getExperiment(EXP))!.state, [], env.clock.t), false);
  env.clock.t += 121_000;
  assert.equal(await runTick(env.ctx.store, EXP, env.clock.t), 'done', 'an abandoned lease expires');
});

test('a busy site ticks itself in the background, but only when the last tick is old', async () => {
  const jobs: Array<Promise<unknown>> = [];
  const env = makeCtx(new MemoryStore(), { tickEveryMs: 5 * 60_000, schedule: (p) => void jobs.push(p) });
  await handleAdmin(adminReq('POST', '/experiments', experimentBody()), env.ctx);
  await decide(env, visitorId(1));
  assert.equal(jobs.length, 0, 'just created, nothing to do yet');
  env.clock.t += 6 * 60_000;
  await decide(env, visitorId(2));
  assert.equal(jobs.length, 1);
  assert.equal(await jobs[0], 'done');
  await decide(env, visitorId(3));
  assert.equal(jobs.length, 1, 'ticked a moment ago');
});

test('browsers are told not to cache anything', async () => {
  const env = await setup();
  const { res } = await decide(env, visitorId(1));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

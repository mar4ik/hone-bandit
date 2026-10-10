import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAtEdge, parseCookies } from '../edge/hone-edge.mjs';
import type { EdgeOptions } from '../edge/hone-edge.mjs';
import { handleAdmin, handleDecide } from '../src/server/handlers.ts';
import { ORIGIN, UA, adminReq, experimentBody, makeCtx, policy, visitorId } from './support/fixtures.ts';

const API = 'https://hone.example';
const EXP = 'exp_test0001';
const PAGE = 'https://site.example/';
const NOW = 1_800_000_000_000;
const ID = 'abcdef0123456789abcdef0123456789';

const HERO_A = [{ selector: 'html', kind: 'attr', attr: 'data-hero', value: 'a' }];
const answerA = { v: 1, variant: 'hero-a', assigned: true, target: true, changes: HERO_A, track: true, goal: { type: 'click', selector: '.btn' } };

function page(headers: Record<string, string> = {}, method = 'GET', url = PAGE): Request {
  return new Request(url, { method, headers: { 'user-agent': UA, ...headers } });
}

/** A Hone that answers with `body` and remembers what it was asked. */
function fakeHone(body: unknown = answerA, status = 200) {
  const calls: Array<{ url: URL; ua: string | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), ua: new Headers(init?.headers).get('user-agent') });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const opts = (over: Partial<EdgeOptions> = {}): EdgeOptions => ({ api: API, experiment: EXP, now: () => NOW, newId: () => ID, ...over });
const record = (over: Record<string, unknown> = {}) => encodeURIComponent(JSON.stringify({ v: 1, t: NOW, i: ID, p: '/', a: { variant: 'hero-a', track: true, changes: HERO_A, goal: null }, ...over }));
const cookieNamed = (lines: string[], name: string) => lines.find((l) => l.startsWith(name + '='));
const answerCookie = (lines: string[]) => {
  const line = cookieNamed(lines, 'hone_ans_' + EXP);
  assert.ok(line, 'an answer cookie is set');
  return JSON.parse(decodeURIComponent(line.split(';')[0].slice(('hone_ans_' + EXP + '=').length)));
};

test('edge: a new visitor is asked about once, with their own user agent, and gets an id and the answer in cookies', async () => {
  const h = fakeHone();
  const r = await decideAtEdge(page(), opts({ fetch: h.fetchFn }));
  assert.equal(r.outcome, 'decided');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.pathname, '/api/decide');
  assert.equal(h.calls[0].url.searchParams.get('e'), EXP);
  assert.equal(h.calls[0].url.searchParams.get('v'), ID);
  assert.equal(h.calls[0].url.searchParams.get('p'), '/');
  assert.equal(h.calls[0].ua, UA, 'Hone sees the visitor\'s browser, not the server\'s');
  assert.equal(r.id, ID);
  assert.equal(r.cookies.length, 2);
  assert.match(cookieNamed(r.cookies, 'hone_vid')!, new RegExp(`^hone_vid=${ID}; Path=/; Max-Age=31536000; SameSite=Lax; Secure$`));
  assert.match(cookieNamed(r.cookies, 'hone_ans_' + EXP)!, /; Path=\/; Max-Age=21600; SameSite=Lax; Secure$/);
  const saved = answerCookie(r.cookies);
  assert.deepEqual({ v: saved.v, t: saved.t, i: saved.i, p: saved.p }, { v: 1, t: NOW, i: ID, p: '/' });
  assert.deepEqual(saved.a, { variant: 'hero-a', track: true, changes: HERO_A, goal: { type: 'click', selector: '.btn' } });
  assert.equal((r.answer as { variant: string }).variant, 'hero-a');
});

test('edge: a visitor whose answer is still fresh is not asked again and gets no new cookies', async () => {
  const h = fakeHone();
  const r = await decideAtEdge(page({ cookie: `hone_vid=${ID}; hone_ans_${EXP}=${record()}` }), opts({ fetch: h.fetchFn }));
  assert.equal(r.outcome, 'fresh');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(r.cookies, []);
});

test('edge: an old, foreign or damaged answer is asked about again, with the same visitor id and no second id cookie', async () => {
  const cases: Record<string, string> = {
    old: record({ t: NOW - 7 * 3600000 }),
    'from the future': record({ t: NOW + 60000 }),
    'someone else': record({ i: 'zzzzzzzz00000000' }),
    'another page': record({ p: '/other' }),
    'not tracked': record({ a: { variant: 'original', track: false, changes: [], goal: null } }),
    damaged: 'not-json-%E0%A4%A',
  };
  for (const [what, value] of Object.entries(cases)) {
    const h = fakeHone();
    const r = await decideAtEdge(page({ cookie: `hone_vid=${ID}; hone_ans_${EXP}=${value}` }), opts({ fetch: h.fetchFn }));
    assert.equal(r.outcome, 'decided', what);
    assert.equal(h.calls.length, 1, what);
    assert.equal(h.calls[0].url.searchParams.get('v'), ID, what);
    assert.equal(cookieNamed(r.cookies, 'hone_vid'), undefined, `${what}: the id cookie is already there`);
    assert.equal(answerCookie(r.cookies).a.variant, 'hero-a', what);
  }
});

test('edge: Global Privacy Control, Do Not Track, crawlers, other methods and skipped requests: no call, no id, no cookie', async () => {
  const cases: Array<[string, Request, string, Partial<EdgeOptions>?]> = [
    ['gpc', page({ 'sec-gpc': '1' }), 'skipped:privacy'],
    ['dnt', page({ dnt: '1' }), 'skipped:privacy'],
    ['googlebot', page({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), 'skipped:bot'],
    ['curl', page({ 'user-agent': 'curl/8.4.0' }), 'skipped:bot'],
    ['no user agent', new Request(PAGE), 'skipped:bot'],
    ['POST', page({}, 'POST'), 'skipped:method'],
    ['custom rule', page({}, 'GET', PAGE + '?hero=a'), 'skipped:custom', { skip: (_r: Request, u: URL) => u.searchParams.has('hero') }],
  ];
  for (const [what, req, outcome, extra] of cases) {
    const h = fakeHone();
    const r = await decideAtEdge(req, opts({ fetch: h.fetchFn, ...extra }));
    assert.equal(r.outcome, outcome, what);
    assert.equal(h.calls.length, 0, what);
    assert.deepEqual(r.cookies, [], what);
    assert.equal(r.id, null, what);
  }
});

test('edge: a slow Hone is given up on at the time limit, the page goes out without an answer, and the id is kept so agent.js asks as the same visitor', async () => {
  const hung = ((_url: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
  const t0 = Date.now();
  const r = await decideAtEdge(page(), opts({ fetch: hung, timeoutMs: 30, now: Date.now }));
  assert.equal(r.outcome, 'slow');
  assert.ok(Date.now() - t0 < 500, 'it did not wait for Hone');
  assert.equal(r.answer, null);
  assert.equal(r.cookies.length, 1);
  assert.match(r.cookies[0], new RegExp(`^hone_vid=${ID};`));
});

test('edge: a broken Hone (network error, 500, not JSON, wrong version) never breaks the page: no answer, nothing else changed', async () => {
  const boom = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const cases: Array<[string, typeof fetch]> = [
    ['network error', boom],
    ['500', fakeHone({ error: 'server_error' }, 500).fetchFn],
    ['not json', fakeHone('<html>oops</html>').fetchFn],
    ['wrong version', fakeHone({ v: 2, variant: 'x' }).fetchFn],
  ];
  for (const [what, fetchFn] of cases) {
    const r = await decideAtEdge(page(), opts({ fetch: fetchFn }));
    assert.equal(r.outcome, 'error', what);
    assert.equal(r.answer, null, what);
    assert.equal(cookieNamed(r.cookies, 'hone_ans_' + EXP), undefined, what);
  }
});

test('edge: an answer that is not worth keeping sets no answer cookie, and an old one is taken away', async () => {
  const untracked = { v: 1, variant: 'original', assigned: false, target: true, changes: [], track: false, goal: null };
  const offTarget = { ...answerA, target: false };
  for (const [what, body] of [['not tracked (kill switch, bot, finished)', untracked], ['page is not the one under test', offTarget]] as const) {
    const first = await decideAtEdge(page(), opts({ fetch: fakeHone(body).fetchFn }));
    assert.equal(cookieNamed(first.cookies, 'hone_ans_' + EXP), undefined, what);
    const again = await decideAtEdge(page({ cookie: `hone_vid=${ID}; hone_ans_${EXP}=${record({ t: NOW - 7 * 3600000 })}` }), opts({ fetch: fakeHone(body).fetchFn }));
    assert.match(cookieNamed(again.cookies, 'hone_ans_' + EXP)!, /^hone_ans_exp_test0001=; Path=\/; Max-Age=0;/, what);
  }
});

test('edge: rememberHours 0 keeps nothing and asks every time; a huge answer is not put in a cookie; plain http gets no Secure flag', async () => {
  const h = fakeHone();
  const none = await decideAtEdge(page({ cookie: `hone_vid=${ID}; hone_ans_${EXP}=${record()}` }), opts({ fetch: h.fetchFn, rememberHours: 0 }));
  assert.equal(none.outcome, 'decided');
  assert.match(cookieNamed(none.cookies, 'hone_ans_' + EXP)!, /^hone_ans_exp_test0001=; Path=\/; Max-Age=0;/, 'nothing is kept, and an old answer is taken away');

  const big = { ...answerA, changes: Array.from({ length: 40 }, (_, i) => ({ selector: `.item-${i}`, kind: 'text', text: 'x'.repeat(60) })) };
  const huge = await decideAtEdge(page(), opts({ fetch: fakeHone(big).fetchFn }));
  assert.equal(huge.outcome, 'decided');
  assert.equal(cookieNamed(huge.cookies, 'hone_ans_' + EXP), undefined, 'too big for a cookie: agent.js asks for it instead');
  assert.ok(cookieNamed(huge.cookies, 'hone_vid'));

  const local = await decideAtEdge(page({}, 'GET', 'http://localhost:3000/'), opts({ fetch: h.fetchFn }));
  assert.ok(local.cookies.length === 2 && local.cookies.every((c) => !/Secure/.test(c)));
});

test('edge: cookies are read the way browsers send them', () => {
  assert.deepEqual(parseCookies('a=1; b=two=2;  c = 3 ; =x; d'), { a: '1', b: 'two=2', c: '3' });
  assert.deepEqual(parseCookies(null), {});
});

// ------------------------------------------------------------------ against the real handlers

const heroSwitchBody = () => experimentBody({
  policy: { ...policy, slots: { html: { kinds: ['attr'], attrs: { 'data-hero': ['a', 'b'] } } } },
  variants: { 'hero-a': { label: 'Hero A', changes: HERO_A } },
  config: { canaryShare: 0.5 },
});

test('edge, against the real Hone: the same visitor gets the same version at the edge and in the browser; Hone must see the visitor\'s user agent', async () => {
  const env = makeCtx();
  assert.equal((await handleAdmin(adminReq('POST', '/experiments', heroSwitchBody()), env.ctx)).status, 201);
  // The edge runs on another machine: it calls Hone over the network, with no Origin header.
  const toHone = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    return handleDecide(new Request(String(input), { headers }), env.ctx);
  }) as typeof fetch;
  const noUa = ((input: string | URL | Request) => handleDecide(new Request(String(input), { headers: { 'user-agent': 'node' } }), env.ctx)) as typeof fetch;

  let seenA = 0;
  let seenOriginal = 0;
  for (let i = 0; i < 60; i++) {
    const id = visitorId(i);
    const r = await decideAtEdge(page(), opts({ fetch: toHone, newId: () => id }));
    assert.equal(r.outcome, 'decided');
    const variant = (r.answer as { variant: string }).variant;
    if (variant === 'hero-a') seenA++;
    else seenOriginal++;
    // The browser asks later with its own request (and an Origin): same person, same answer.
    const later = (await (await handleDecide(new Request(`${API}/api/decide?e=${EXP}&v=${id}&p=/`, { headers: { 'user-agent': UA, origin: ORIGIN } }), env.ctx)).json()) as { variant: string };
    assert.equal(later.variant, variant, `visitor ${i}`);
    if (variant === 'hero-a') assert.deepEqual(answerCookie(r.cookies).a.changes, HERO_A);
  }
  assert.ok(seenA > 10 && seenOriginal > 10, `both versions are handed out (${seenA}/${seenOriginal})`);

  // Without the visitor's user agent Hone takes the caller for a crawler: everybody would get the original.
  const r = await decideAtEdge(page(), opts({ fetch: noUa, newId: () => visitorId(999) }));
  assert.equal(r.outcome, 'decided');
  assert.equal((r.answer as { track: boolean }).track, false);
  assert.equal(cookieNamed(r.cookies, 'hone_ans_' + EXP), undefined);
});


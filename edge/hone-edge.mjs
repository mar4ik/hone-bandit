/**
 * Hone at the edge: decide the version BEFORE the page is sent, so the page arrives already showing it.
 *
 * Without this, a brand-new visitor's browser has to load agent.js, then ask Hone, and the parts that may change stay
 * hidden meanwhile (a blank area for a second or more). Here the site's own server asks Hone first (one short call,
 * server to server), puts the answer in a cookie on the page response, and the page's first lines read it. Nothing is
 * hidden, nothing waits. If Hone is slow or down, the visitor simply gets the page as it is today.
 *
 * It is a plain function that takes a standard Request and gives back cookies, so it works in any server that speaks
 * Request/Response (Vercel Routing Middleware, Cloudflare Workers, Deno, Bun, Node 18+). Nothing here is specific to
 * one site; see README → "Deciding before the page is sent" for how to wire it up.
 *
 *   const r = await decideAtEdge(request, { api: 'https://YOUR-HONE-HOST', experiment: 'exp_xxxxxxxx' });
 *   // r.cookies: Set-Cookie lines to add to the page response (may be empty)
 *   // r.answer:  Hone's answer ({ variant, changes, track, goal, ... }) or null
 *
 * What it sets:
 *   hone_vid            the visitor id (the same cookie agent.js uses), only when the visitor had none
 *   hone_ans_<exp>      Hone's answer for this page, as agent.js keeps it in localStorage ({v,t,i,p,a}), for a few hours
 *
 * It never runs for: non-GET requests, visitors who sent Global Privacy Control / Do Not Track (they get no cookie
 * at all), crawlers, or a visitor whose answer is still fresh. Any failure (timeout, error, odd answer) returns no
 * answer, and the page falls back to what agent.js does on its own.
 */

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;
// The same list the Hone server uses for itself, so a skipped crawler and a crawler Hone would ignore are the same.
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|facebookexternalhit|curl|wget|python-requests|node-fetch|go-http|monitor|uptime/i;
const ID_MAX_AGE = 31536000; // a year, like agent.js
const MAX_ANSWER_COOKIE = 3000; // characters; browsers keep about 4096 per cookie

/** @typedef {{ api: string, experiment: string, path?: string, timeoutMs?: number, rememberHours?: number,
 *   skip?: (request: Request, url: URL) => boolean, fetch?: typeof fetch, now?: () => number, newId?: () => string }} EdgeOptions */
/** @typedef {{ outcome: string, id: string | null, cookies: string[], answer: any, ms: number }} EdgeResult */

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

export function cleanPath(p) {
  p = String(p || '/').split(/[?#]/)[0];
  return p.length > 1 ? p.replace(/\/+$/, '') : p || '/';
}

function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieLine(name, value, maxAge, secure) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The same checks agent.js makes before it trusts a saved answer. */
function usableAnswer(x, id, path, rememberMs, now) {
  if (!x || x.v !== 1 || x.i !== id || x.p !== path || typeof x.t !== 'number') return false;
  const age = now - x.t;
  if (age < 0 || age > rememberMs) return false;
  const a = x.a;
  return !!a && a.track === true && typeof a.variant === 'string' && Array.isArray(a.changes);
}

/** @param {Request} request @param {EdgeOptions} opts @returns {Promise<EdgeResult>} */
export async function decideAtEdge(request, opts) {
  const started = (opts.now || Date.now)();
  const done = (outcome, id = null, cookies = [], answer = null) => ({ outcome, id, cookies, answer, ms: (opts.now || Date.now)() - started });

  const key = opts.experiment;
  if (!opts.api || !KEY_RE.test(key || '')) return done('error');
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  const now = (opts.now || Date.now)();
  const path = cleanPath(opts.path || url.pathname);
  const rememberMs = Math.min(Math.max(opts.rememberHours ?? 6, 0), 720) * 3600000;

  // Visitors who asked not to be tracked, and crawlers, are left alone: no call, no cookie, no id.
  if (request.method !== 'GET') return done('skipped:method');
  if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') return done('skipped:privacy');
  const ua = request.headers.get('user-agent') || '';
  if (ua.length < 8 || BOT_RE.test(ua)) return done('skipped:bot');
  if (opts.skip && opts.skip(request, url)) return done('skipped:custom');

  const jar = parseCookies(request.headers.get('cookie'));
  const STORE = 'hone_ans_' + key;
  const cookies = [];
  let id = ID_RE.test(jar.hone_vid || '') ? jar.hone_vid : null;
  if (id && rememberMs) {
    try {
      const saved = JSON.parse(decodeURIComponent(jar[STORE] || ''));
      if (usableAnswer(saved, id, path, rememberMs, now)) return done('fresh', id, [], saved.a);
    } catch {
      // no saved answer, or a damaged one: ask again
    }
  }
  if (!id) {
    id = (opts.newId || randomId)();
    if (!ID_RE.test(id)) return done('error');
    cookies.push(cookieLine('hone_vid', id, ID_MAX_AGE, secure));
  }

  // One short call. Whatever happens, the page is still sent.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 400);
  let d = null;
  let outcome = 'decided';
  try {
    const target = `${opts.api.replace(/\/+$/, '')}/api/decide?e=${encodeURIComponent(key)}&v=${encodeURIComponent(id)}&p=${encodeURIComponent(path)}`;
    const res = await (opts.fetch || fetch)(target, { headers: { 'user-agent': ua }, cache: 'no-store', signal: ctl.signal });
    d = res.ok ? await res.json() : null;
    if (!d) outcome = 'error';
  } catch (err) {
    outcome = ctl.signal.aborted ? 'slow' : 'error';
  } finally {
    clearTimeout(timer);
  }
  if (!d || d.v !== 1) return done(outcome === 'decided' ? 'error' : outcome, id, cookies, null);

  // The same rule agent.js uses for what it keeps: only a page the test is about, only while the visitor is in a running test.
  const keep = rememberMs > 0 && d.target === true && d.track === true && typeof d.variant === 'string' && d.variant;
  if (keep) {
    const record = { v: 1, t: now, i: id, p: path, a: { variant: d.variant, track: true, changes: Array.isArray(d.changes) ? d.changes : [], goal: d.goal || null } };
    const value = encodeURIComponent(JSON.stringify(record));
    if (value.length <= MAX_ANSWER_COOKIE) cookies.push(cookieLine(STORE, value, Math.floor(rememberMs / 1000), secure));
  } else if (STORE in jar) {
    cookies.push(cookieLine(STORE, '', 0, secure)); // forget an old answer
  }
  return done('decided', id, cookies, d);
}

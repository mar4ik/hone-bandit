import { createHash, timingSafeEqual } from 'node:crypto';
import type { TargetRule } from './types.ts';

export const KEY_RE = /^[A-Za-z0-9_-]{3,64}$/;
export const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const VARIANT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Wraps a route so a crash becomes a plain 500 instead of a stack trace, and is logged for the owner.
 * The browser script treats any failure as "show the original", so a broken server never breaks the site.
 */
export async function guard(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    console.error('hone: unhandled error', err);
    return json(500, { error: 'server_error' });
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...headers } });
}

/**
 * Browsers send an Origin header on cross-origin calls. Only sites the owner listed may read the answers.
 * Calls with no Origin (same-site GET, curl, a server) pass: this is a guard for browsers, not a login.
 */
export function corsFor(req: Request, allowedOrigins: string[]): { ok: boolean; headers: Record<string, string> } {
  const origin = req.headers.get('origin');
  if (!origin) return { ok: true, headers: {} };
  if (allowedOrigins.includes(origin)) {
    // Beacons are sent with credentials; browsers want this header on the answer, even though no cookie is used.
    return { ok: true, headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } };
  }
  return { ok: false, headers: { vary: 'Origin' } };
}

/** Answer to a preflight. The real requests are checked against the experiment's own list of sites. */
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    },
  });
}

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|facebookexternalhit|curl|wget|python-requests|node-fetch|go-http|monitor|uptime/i;

/** Crawlers and monitors are shown the original and never counted. A missing user agent is not a browser. */
export function isBot(req: Request): boolean {
  const ua = req.headers.get('user-agent') ?? '';
  return ua.length < 8 || BOT_RE.test(ua);
}

/** Global Privacy Control and Do Not Track: show the original, store nothing. */
export function optedOut(req: Request): boolean {
  return req.headers.get('sec-gpc') === '1' || req.headers.get('dnt') === '1';
}

/** Takes a path or a URL path with a query, returns a clean path, or null if it is not one. */
export function cleanPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512 || raw[0] !== '/') return null;
  let p = raw.split(/[?#]/)[0];
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

export function matchesPath(rule: TargetRule, path: string): boolean {
  const want = cleanPath(rule.path);
  const got = cleanPath(path);
  if (want === null || got === null) return false;
  if (rule.match === 'prefix') return want === '/' || got === want || got.startsWith(`${want}/`);
  return got === want;
}

/** Compares a bearer token with a secret without leaking how much of it matched. */
export function bearerOk(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export function newKey(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

import { MemoryStore } from '../../src/server/memory-store.ts';
import type { Ctx } from '../../src/server/handlers.ts';
import type { Store } from '../../src/server/store.ts';
import { DAY } from '../../src/core/types.ts';

export const ORIGIN = 'https://site.example';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const ADMIN = 'admin-secret-for-tests';
export const CRON = 'cron-secret-for-tests';

export interface Clock {
  t: number;
}

export function makeCtx(store: Store = new MemoryStore(), over: Partial<Ctx> = {}): { ctx: Ctx; clock: Clock } {
  const clock: Clock = { t: 1_800_000_000_000 };
  return { ctx: { store, now: () => clock.t, adminToken: ADMIN, cronSecret: CRON, tickEveryMs: 0, ...over }, clock };
}

export const policy = {
  slots: {
    'h1.hero-title': { kinds: ['text'], maxChars: 70 },
    'a.hero-cta': { kinds: ['text', 'style'], maxChars: 28 },
    'ul.cards': { kinds: ['order'] },
  },
  neverChange: ['price', 'legal', 'consent', 'form', 'checkout', 'cookie'],
  facts: { numbers: ['4 weeks'], claims: [] },
  brand: { colors: ['#14202B', '#F6F6F1', '#C8381A', '#FFFFFF'], fonts: ['Newsreader', 'Hanken Grotesk'], minFontPx: 14, maxFontPx: 72, forbiddenWords: ['guru'] },
};

export const titleCtx = { color: '#14202B', background: '#F6F6F1', fontSizePx: 48 };

export function experimentBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exp_test0001',
    name: 'Hero test',
    target: { path: '/' },
    goal: { type: 'click', selector: 'a.hero-cta' },
    allowedOrigins: [ORIGIN],
    policy,
    variants: {
      v1: { label: 'Shorter headline', changes: [{ selector: 'h1.hero-title', kind: 'text', text: 'Learn AI without the jargon', context: titleCtx }] },
      v2: { label: 'Different button', changes: [{ selector: 'a.hero-cta', kind: 'text', text: 'See the courses', context: { color: '#FFFFFF', background: '#C8381A', fontSizePx: 18, bold: true } }] },
    },
    config: {},
    ...over,
  };
}

export function adminReq(method: string, path: string, body?: unknown, token: string | null = ADMIN): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://hone.example/api/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function decideReq(e: string, v: string, p = '/', headers: Record<string, string> = {}): Request {
  const url = new URL('https://hone.example/api/decide');
  url.searchParams.set('e', e);
  url.searchParams.set('v', v);
  url.searchParams.set('p', p);
  return new Request(url, { headers: { 'user-agent': UA, origin: ORIGIN, ...headers } });
}

export function eventReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://hone.example/api/event', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': UA, origin: ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const visitorId = (i: number): string => `visitor-${String(i).padStart(7, '0')}`;
export { DAY };

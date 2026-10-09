import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { handleAdmin, handleDecide, handleEvent, handleOptions, handleTick } from './handlers.ts';
import type { Ctx } from './handlers.ts';

/**
 * Runs the same handlers the Next.js routes run, on a plain Node server.
 * Used by the demo and the browser tests. The deployed app does not use this file.
 */

export async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const method = req.method ?? 'GET';
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = Buffer.concat(chunks);
  }
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body: body ? new Uint8Array(body) : undefined });
}

export async function sendResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

export function apiServer(ctx: Ctx, opts: { agentJs: string; origin: () => string }): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const preflight = req.method === 'OPTIONS';
      if (path === '/agent.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        return void res.end(readFileSync(opts.agentJs));
      }
      const request = await toRequest(req, opts.origin());
      if (path === '/api/decide') return await sendResponse(res, preflight ? handleOptions() : await handleDecide(request, ctx));
      if (path === '/api/event') return await sendResponse(res, preflight ? handleOptions() : await handleEvent(request, ctx));
      if (path === '/api/cron/tick') return await sendResponse(res, await handleTick(request, ctx));
      if (path.startsWith('/api/admin/')) return await sendResponse(res, await handleAdmin(request, ctx));
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err instanceof Error ? err.stack : err));
    }
  });
}

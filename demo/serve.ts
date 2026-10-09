/**
 * Try Hone on a copy of a real site, on your own machine. Nothing is changed on disk.
 *
 *   node demo/serve.ts --site ~/Documents/AIQB-local
 *
 * Starts two servers: the site (as is, with one script tag added to its home page while serving) and the Hone API.
 * The experiment comes from demo/aiqb-hero.experiment.json. State is kept in memory; stop the server and it is gone.
 * Needs Node 22.18 or newer.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { handleAdmin } from '../src/server/handlers.ts';
import type { Ctx } from '../src/server/handlers.ts';
import { MemoryStore } from '../src/server/memory-store.ts';
import { apiServer } from '../src/server/node-http.ts';

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    'site-port': { type: 'string', default: '4000' },
    'api-port': { type: 'string', default: '4001' },
    experiment: { type: 'string', default: new URL('./aiqb-hero.experiment.json', import.meta.url).pathname },
  },
});
if (!values.site) {
  console.error('usage: node demo/serve.ts --site <folder with index.html>');
  process.exit(2);
}
const siteDir = resolve(values.site.replace(/^~/, process.env.HOME ?? '~'));
if (!existsSync(join(siteDir, 'index.html'))) {
  console.error(`no index.html in ${siteDir}`);
  process.exit(2);
}
const sitePort = Number(values['site-port']);
const apiPort = Number(values['api-port']);
const siteOrigin = `http://localhost:${sitePort}`;
const apiOrigin = `http://localhost:${apiPort}`;
const adminToken = process.env.ADMIN_TOKEN ?? 'demo-admin';

const ctx: Ctx = { store: new MemoryStore(), now: () => Date.now(), adminToken, cronSecret: 'demo-cron', tickEveryMs: 0 };

const definition = JSON.parse(readFileSync(values.experiment, 'utf8')) as Record<string, unknown>;
const made = await handleAdmin(
  new Request(`${apiOrigin}/api/admin/experiments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...definition, allowedOrigins: [siteOrigin, `http://127.0.0.1:${sitePort}`] }),
  }),
  ctx,
);
const madeBody = (await made.json()) as { id?: string; errors?: string[] };
if (made.status !== 201 || !madeBody.id) {
  console.error('the experiment was refused:', madeBody.errors ?? madeBody);
  process.exit(1);
}
const experimentId = madeBody.id;
const hide = (definition.hide as string | undefined) ?? '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

const site = createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = normalize(join(siteDir, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(siteDir)) {
    res.writeHead(403);
    return void res.end();
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404);
    return void res.end('not found');
  }
  let body: Buffer | string = readFileSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  if (file === join(siteDir, 'index.html')) {
    const tag = `<script src="${apiOrigin}/agent.js" data-experiment="${experimentId}"${hide ? ` data-hide="${hide}"` : ''}></script>`;
    body = body.toString('utf8').replace('</head>', `  ${tag}\n</head>`);
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(body);
});

const api = apiServer(ctx, { agentJs: new URL('../public/agent.js', import.meta.url).pathname, origin: () => apiOrigin });
site.listen(sitePort, () => {
  api.listen(apiPort, () => {
    console.log(`Site:        ${siteOrigin}/   (your files, with one script tag added on the way out)`);
    console.log(`Hone API:    ${apiOrigin}/`);
    console.log(`Experiment:  ${experimentId}`);
    console.log(`Status:      curl -s -H "Authorization: Bearer ${adminToken}" ${apiOrigin}/api/admin/experiments/${experimentId}`);
    console.log(`Kill switch: curl -s -X POST -H "Authorization: Bearer ${adminToken}" -d '{"reason":"demo"}' ${apiOrigin}/api/admin/experiments/${experimentId}/kill`);
  });
});

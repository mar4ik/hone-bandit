import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { chooseVariant, viewFromState } from '../src/core/engine.ts';
import { handleAdmin } from '../src/server/handlers.ts';
import { MemoryStore } from '../src/server/memory-store.ts';
import { apiServer } from '../src/server/node-http.ts';
import { DAY } from '../src/core/types.ts';
import { Chrome } from './support/chrome.ts';
import type { Page } from './support/chrome.ts';
import { UA, adminReq, experimentBody, makeCtx, policy, titleCtx } from './support/fixtures.ts';

const CHROME = process.env.HONE_TEST_CHROME;
const skip = CHROME ? false : 'Set HONE_TEST_CHROME to a Chrome or Chromium program to run the browser tests';

const EXP = 'exp_browser01';
const html = readFileSync(new URL('./support/page.html', import.meta.url), 'utf8');

const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const until = async (fn: () => Promise<boolean> | boolean, ms = 6000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out');
};

test('the browser script, in a real browser, against the real handlers', { skip }, async (t) => {
  const { ctx, clock } = makeCtx(new MemoryStore());
  clock.t = Date.now(); // real time, so the browser and the server agree about "now"
  ctx.now = () => Date.now();

  // The API is on 127.0.0.1 and the page on localhost: two different sites, so cross-site rules really apply.
  let delayDecideMs = 0;
  let apiPort = 0;
  let sitePort = 0;
  const api = apiServer(ctx, { agentJs: new URL('../public/agent.js', import.meta.url).pathname, origin: () => `http://127.0.0.1:${apiPort}` });
  const slowApi = createServer(async (req, res) => {
    if (delayDecideMs && req.url?.startsWith('/api/decide')) await new Promise((r) => setTimeout(r, delayDecideMs));
    api.emit('request', req, res);
  });
  apiPort = await listen(slowApi);

  const siteHtml = (extra = '') => html.replace('<!--HONE-->', `<script src="http://127.0.0.1:${apiPort}/agent.js" data-experiment="${EXP}" data-hide=".hero-title,.hero-cta" ${extra}></script>`);
  const site = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/other' || path === '/down' || path === '/index.html') {
      const body = path === '/down' ? siteHtml('data-api="http://127.0.0.1:9"') : siteHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  sitePort = await listen(site);
  const siteUrl = `http://localhost:${sitePort}`;

  const created = await handleAdmin(
    adminReq('POST', '/experiments', experimentBody({
      id: EXP,
      allowedOrigins: [siteUrl],
      policy: {
        ...policy,
        slots: { ...policy.slots, 'h2.not-on-the-page': { kinds: ['text'] } },
      },
      variants: {
        v1: { label: 'Title', changes: [{ selector: 'h1.hero-title', kind: 'text', text: 'Learn AI without\nthe jargon', context: titleCtx }] },
        v2: { label: 'Button', changes: [
          { selector: 'a.hero-cta', kind: 'text', text: 'See the courses', context: { color: '#FFFFFF', background: '#C8381A', fontSizePx: 18, bold: true } },
          { selector: 'a.hero-cta', kind: 'style', style: { background: '#14202B' }, context: { color: '#FFFFFF', background: '#C8381A', fontSizePx: 18, bold: true } },
        ] },
        v3: { label: 'Order', changes: [{ selector: 'ul.cards', kind: 'order', order: ['advanced', 'starter', 'popular'], originalOrder: ['starter', 'popular', 'advanced'], context: titleCtx }] },
        v4: { label: 'Broken', changes: [{ selector: 'h2.not-on-the-page', kind: 'text', text: 'Nothing here', context: titleCtx }] },
      },
      config: { canaryShare: 0.2 },
    })),
    ctx,
  );
  assert.equal(created.status, 201, await created.clone().text());

  const row = (await ctx.store.getExperiment(EXP))!;
  const view = viewFromState(EXP, ['original', 'v1', 'v2', 'v3', 'v4'], row.state, false);
  const idFor = (variant: string): string => {
    for (let i = 0; ; i++) {
      const id = `browser-test-${variant}-${i}`;
      if (chooseVariant(view, id) === variant) return id;
    }
  };

  const chrome = await Chrome.launch(CHROME as string, UA);
  const pages: Page[] = [];
  const open = async (opts: { visitor?: string; gpc?: boolean; headers?: Record<string, string> } = {}): Promise<Page> => {
    const p = await chrome.newPage();
    pages.push(p);
    await p.setup(UA, ['localhost', '127.0.0.1']);
    if (opts.headers) await p.send('Network.setExtraHTTPHeaders', { headers: opts.headers });
    const init = [
      opts.visitor ? `try{ if(!localStorage.getItem('hone_vid')) localStorage.setItem('hone_vid', ${JSON.stringify(opts.visitor)}) }catch(e){}` : '',
      opts.gpc ? "Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })" : '',
    ].join(';');
    if (init.replace(/;/g, '')) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: init });
    return p;
  };
  t.after(async () => {
    for (const p of pages) p.close();
    chrome.close();
    slowApi.close();
    site.close();
  });

  const hone = (p: Page) => p.eval<{ variant: string; assigned: boolean; track: boolean; applyFailed: boolean; visitorId: string } | null>('window.__hone || null');
  const text = (p: Page, sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)}).innerText`);
  const visible = (p: Page, sel: string) => p.eval<boolean>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).visibility === 'visible'`);
  const measure = () => ctx.store.measure(EXP, { order: ['original', 'v1', 'v2', 'v3', 'v4'], now: Date.now(), windowMs: 7 * DAY, lagMs: DAY, confirmPhase: null, confirmN: 0, phase: 0 });

  await t.test('each kind of change is applied, and the original is left alone', async () => {
    let p = await open({ visitor: idFor('v1') });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal((await hone(p))?.variant, 'v1');
    assert.equal(await text(p, 'h1.hero-title'), 'Learn AI without\nthe jargon');
    assert.equal(await p.eval('document.querySelector("h1.hero-title br") !== null'), true, 'a new line in the text becomes a line break');
    assert.equal(await p.eval('document.documentElement.getAttribute("data-hone-variant")'), 'v1');

    p = await open({ visitor: idFor('v2') });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal(await text(p, 'a.hero-cta'), 'See the courses');
    assert.equal(await p.eval('getComputedStyle(document.querySelector("a.hero-cta")).backgroundColor'), 'rgb(20, 32, 43)');

    p = await open({ visitor: idFor('v3') });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.deepEqual(await p.eval('Array.from(document.querySelectorAll("ul.cards li")).map(li => li.dataset.honeKey)'), ['advanced', 'starter', 'popular']);

    p = await open({ visitor: idFor('original') });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal((await hone(p))?.variant, 'original');
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today');
    assert.equal((await hone(p))?.track, true);
  });

  await t.test('the same person gets the same version on every visit, and the hidden parts are shown again', async () => {
    const p = await open({ visitor: idFor('v1') });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    const first = await hone(p);
    assert.equal(await visible(p, 'h1.hero-title'), true);
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    const second = await hone(p);
    assert.equal(second?.variant, 'v1');
    assert.equal(second?.visitorId, first?.visitorId, 'the id is kept in the page\'s own storage');
    await p.goto(`${siteUrl}/other`);
    await p.waitFor('window.__hone');
    const other = await hone(p);
    assert.equal(other?.assigned, true, 'known on other pages...');
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today', '...but nothing changes there');
  });

  await t.test('a view is reported when the page loads, health when it is left, and the goal when the button is clicked', async () => {
    const id = idFor('v1');
    const earlier = (await measure()).variants.v1; // earlier checks used this version too
    const p = await open({ visitor: id });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    await until(async () => (await measure()).variants.v1.views >= earlier.views + 1);
    await p.eval('document.querySelector("a.hero-cta").addEventListener("click", e => e.preventDefault()); document.querySelector("a.hero-cta").click()');
    await until(async () => (await ctx.store.getVisitor(EXP, id))?.convertedAt != null);
    await p.goto('about:blank'); // leaving the page sends the health numbers
    await until(async () => (await measure()).variants.v1.lcpN >= earlier.lcpN + 1, 8000);
    const m = (await measure()).variants.v1;
    assert.equal(m.views, earlier.views + 1);
    assert.equal(m.errors, earlier.errors);
    assert.ok(m.lcpSum > earlier.lcpSum);
  });

  await t.test('a change that cannot be applied is reported as an error for that version', async () => {
    const id = idFor('v4');
    const p = await open({ visitor: id });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal((await hone(p))?.applyFailed, true);
    assert.equal(await visible(p, 'h1.hero-title'), true, 'the page is still shown');
    await until(async () => (await measure()).variants.v4.errors >= 1);
    assert.equal((await measure()).variants.v4.views, 1);
  });

  await t.test('Global Privacy Control: the page is left alone and nothing is stored, not even an id', async () => {
    const id = idFor('v1');
    const p = await open({ visitor: id, gpc: true });
    await p.goto(`${siteUrl}/`);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(await p.eval('window.__hone === undefined'), true);
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today');
    assert.equal(await visible(p, 'h1.hero-title'), true);
    assert.equal(await p.eval('localStorage.getItem("hone_vid")'), id, 'only what the test put there');
    const p2 = await open({ gpc: true });
    await p2.goto(`${siteUrl}/`);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await p2.eval('localStorage.getItem("hone_vid")'), null, 'no id is made');
  });

  await t.test('a server that is down: the page is shown as it is, within the time limit', async () => {
    const p = await open({ visitor: idFor('v1') });
    const started = Date.now();
    await p.goto(`${siteUrl}/down`);
    await p.waitFor('getComputedStyle(document.querySelector("h1.hero-title")).visibility === "visible"', 3000);
    assert.ok(Date.now() - started < 2500);
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today');
  });

  await t.test('a slow server: the page shows as it is after the time limit, then switches when the answer comes', async () => {
    delayDecideMs = 1500;
    try {
      const p = await open({ visitor: idFor('v1') });
      await p.goto(`${siteUrl}/`);
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(await visible(p, 'h1.hero-title'), true, 'revealed after 700 ms');
      assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today');
      await p.waitFor('window.__hone', 4000);
      assert.equal(await text(p, 'h1.hero-title'), 'Learn AI without\nthe jargon');
    } finally {
      delayDecideMs = 0;
    }
  });

  await t.test('a site that is not on the list gets nothing, and nothing is stored', async () => {
    const id = `browser-test-foreign-${Date.now()}`;
    const p = await open({ visitor: id });
    await p.goto(`http://127.0.0.1:${sitePort}/`); // same server, but a different origin than the one on the list
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await p.eval('window.__hone === undefined'), true);
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today');
    assert.equal(await ctx.store.getVisitor(EXP, id), null);
  });

  await t.test('the kill switch: the next page load shows the original and reports nothing', async () => {
    const id = idFor('v1');
    const before = (await measure()).variants.v1.views;
    await handleAdmin(adminReq('POST', `/experiments/${EXP}/kill`, { reason: 'browser test' }), ctx);
    const p = await open({ visitor: id });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    const h = await hone(p);
    assert.deepEqual([h?.variant, h?.track], ['original', false]);
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await measure()).variants.v1.views, before);
    await handleAdmin(adminReq('POST', `/experiments/${EXP}/resume`, { reason: 'done' }), ctx);
  });

});

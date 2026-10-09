import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleAdmin, handleDecide } from '../src/server/handlers.ts';
import type { DecideResponse } from '../src/server/types.ts';
import { MemoryStore } from '../src/server/memory-store.ts';
import { apiServer } from '../src/server/node-http.ts';
import { Chrome } from './support/chrome.ts';
import type { Page } from './support/chrome.ts';
import { ADMIN, UA, adminReq, decideReq, makeCtx, visitorId } from './support/fixtures.ts';

/**
 * The owner's console, in a real browser, on the real handlers.
 * The page is served the way the deployed app serves it: the headers and the /console address come from next.config.mjs itself.
 * Set HONE_SHOTS to a folder to also save a picture of every screen.
 */

const CHROME = process.env.HONE_TEST_CHROME;
const skip = CHROME ? false : 'Set HONE_TEST_CHROME to a Chrome or Chromium program to run the browser tests';
const SHOTS = process.env.HONE_SHOTS;
const SITE = 'https://aiqb-prototype.vercel.app';

const consoleDir = new URL('../public/console/', import.meta.url).pathname;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the console: sign in, make a test from the form, watch it, stop it, bring it back', { skip }, async (t) => {
  const { ctx, clock } = makeCtx(new MemoryStore());
  clock.t = Date.now();
  ctx.now = () => Date.now();

  // ---- serve /console and /api on one origin, with the deployed app's own rewrites and headers
  const config = (await import(new URL('../next.config.mjs', import.meta.url).href)).default as {
    rewrites: () => Promise<Array<{ source: string; destination: string }>>;
    headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
  };
  const rewrites = await config.rewrites();
  const headerRules = await config.headers();
  let port = 0;
  const api = apiServer(ctx, { agentJs: new URL('../public/agent.js', import.meta.url).pathname, origin: () => `http://localhost:${port}` });
  const server = createServer((req, res) => {
    const asked = (req.url ?? '/').split('?')[0];
    if (asked.startsWith('/api/') || asked === '/agent.js') return void api.emit('request', req, res);
    const extra: Record<string, string> = {};
    for (const rule of headerRules) {
      const prefix = rule.source.endsWith('/:path*') ? rule.source.slice(0, -'/:path*'.length) : null;
      if (rule.source === asked || (prefix !== null && asked.startsWith(`${prefix}/`))) for (const h of rule.headers) extra[h.key.toLowerCase()] = h.value;
    }
    const path = rewrites.find((r) => r.source === asked)?.destination ?? asked;
    const name = path.startsWith('/console/') ? path.slice('/console/'.length) : '';
    const ext = name.slice(name.lastIndexOf('.'));
    if (!name || name.includes('/') || name.includes('..') || !TYPES[ext] || !existsSync(join(consoleDir, name))) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[ext], ...extra });
    res.end(readFileSync(join(consoleDir, name)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;

  const chrome = await Chrome.launch(CHROME as string, UA);
  const p: Page = await chrome.newPage();
  t.after(() => {
    p.close();
    chrome.close();
    server.close();
  });
  await p.setup(UA, ['localhost', '127.0.0.1']);
  // Every refusal by the page's security policy is recorded, so a blocked script or style cannot hide.
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__csp = []; document.addEventListener('securitypolicyviolation', function (e) { window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); });" });

  // ---- small helpers
  const text = (sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)}).innerText`);
  const body = () => p.eval<string>('document.body.innerText');
  const exists = (sel: string) => p.eval<boolean>(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  const click = (sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const fill = (sel: string, value: string) =>
    p.eval(`(function () { var el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
  const clickText = (sel: string, label: string) =>
    p.eval(`(function () { var els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})); var el = els.filter(function (e) { return e.textContent.trim() === ${JSON.stringify(label)}; })[0]; if (!el) throw new Error('no ' + ${JSON.stringify(sel)} + ' saying ' + ${JSON.stringify(label)}); el.click(); })()`);
  const go = async (hash: string) => {
    await p.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(80);
  };
  const shot = async (name: string, width = 1280) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const phone = width < 500;
    const metrics = (height: number) => p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    await metrics(800);
    await sleep(200);
    const height = await p.eval<number>('Math.ceil(document.documentElement.scrollHeight)');
    await metrics(Math.max(800, height));
    await sleep(200);
    const r = await p.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `${name}${phone ? '-phone' : ''}.png`), Buffer.from(r.data, 'base64'));
    await p.send('Emulation.clearDeviceMetricsOverride');
  };
  const rows = () => p.eval<string[]>('Array.from(document.querySelectorAll("table.tests tbody tr")).map(function (r) { return r.innerText.replace(/\\s+/g, " ").trim(); })');

  await t.test('without a token, the first thing is the sign-in screen, and /console is the address', async () => {
    await p.goto(`${base}/console`);
    await p.waitFor('document.querySelector("#token")');
    assert.match(await text('h1'), /Sign in/);
    assert.equal(await p.eval('document.getElementById("nav").hidden'), true, 'the menu is hidden until you are in');
    await shot('01-sign-in');
    await shot('01-sign-in', 390);
  });

  await t.test('a wrong token is refused with words, and nothing is kept', async () => {
    await fill('#token', 'not-the-token');
    await click('button[type=submit]');
    await p.waitFor('document.querySelector(".err").textContent.length > 0');
    assert.match(await text('.err'), /does not match/);
    assert.equal(await p.eval('sessionStorage.getItem("hone_admin_token")'), null);
    assert.equal(await p.eval('document.getElementById("token").type'), 'password', 'the token is never shown on screen');
  });

  await t.test('the right token opens Activity, which is empty at first', async () => {
    await fill('#token', ADMIN);
    await click('button[type=submit]');
    await p.waitFor('document.querySelector(".empty")');
    assert.match(await body(), /No tests yet/);
    assert.equal(await p.eval('document.getElementById("nav").hidden'), false);
    assert.equal(await p.eval('sessionStorage.getItem("hone_admin_token")'), ADMIN, 'kept for this tab only');
    await shot('02-activity-empty');
  });

  await t.test('New test: the form says what is missing before it asks the server anything', async () => {
    await clickText('.nav a', 'New test');
    await p.waitFor('document.querySelector("#f_name")');
    await shot('03-new-empty');
    await click('.btn--redsolid');
    await p.waitFor('document.querySelector(".note--warn")');
    const said = await text('.note--warn');
    for (const need of [/Give the test a name/, /Say which button counts/, /Version 1 needs a name/, /say where on the page/]) assert.match(said, need);
    assert.deepEqual((await ctx.store.listAll()).length, 0, 'nothing was sent');
    await fill('#f_name', 'Hero A vs Hero B');
    assert.equal(await exists('.note--warn'), false, 'an old complaint does not stay on screen once the form changes');
  });

  await t.test('New test: Hero A against the original, made without a terminal', async () => {
    await fill('#f_name', 'Hero A vs Hero B');
    assert.equal(await p.eval('document.querySelector("#f_id").value'), 'exp_hero_a_vs_hero_b_1', 'the id is made from the name');
    await fill('#f_origins', `${SITE}\nhttp://localhost:4000`);
    await fill('#f_hide', '.hero,.story-hero');
    assert.match(await text('.code pre'), /<script src="http:\/\/localhost:\d+\/agent\.js" data-experiment="exp_hero_a_vs_hero_b_1" data-hide="\.hero,\.story-hero"><\/script>/, 'the line to paste follows the form');
    await fill('#f_goalSelector', '.hero__actions .btn, .story-hero__actions .btn');
    await fill('#v0_label', 'Hero A');
    await fill('select[aria-label="What kind of change"]', 'attr');
    await p.waitFor('document.querySelector("#v0c0attr")');
    await fill('#v0c0selector', 'html');
    await fill('#v0c0attr', 'data-hero');
    await fill('#v0c0value', 'a');
    await fill('#f_share', '50');
    await shot('04-new-filled');
    await shot('04-new-filled', 390);
    await click('.btn--redsolid');
    await p.waitFor('location.hash.indexOf("#/test/exp_hero_a_vs_hero_b_1") === 0 && document.querySelector(".versions")');
    assert.match(await body(), /The test is created\. It changes nothing on your site yet\./);
  });

  await t.test('what the form made is exactly what the server stored, and visitors get it', async () => {
    const shown = (await (await handleAdmin(adminReq('GET', '/experiments/exp_hero_a_vs_hero_b_1'), ctx)).json()) as {
      stage: string; hide: string; allowedOrigins: string[]; goal: unknown; weights: Record<string, number>;
      variants: Array<{ id: string; label: string; changes: unknown[] }>;
    };
    assert.equal(shown.stage, 'canary');
    assert.equal(shown.hide, '.hero,.story-hero');
    assert.deepEqual(shown.allowedOrigins, [SITE, 'http://localhost:4000']);
    assert.deepEqual(shown.goal, { type: 'click', selector: '.hero__actions .btn, .story-hero__actions .btn' });
    assert.deepEqual(shown.weights, { original: 0.5, 'hero-a': 0.5 });
    assert.deepEqual(shown.variants.find((v) => v.id === 'hero-a')?.changes, [{ selector: 'html', kind: 'attr', attr: 'data-hero', value: 'a' }]);
    let got: DecideResponse | null = null;
    for (let i = 0; i < 40 && got?.variant !== 'hero-a'; i++) {
      got = (await (await handleDecide(decideReq('exp_hero_a_vs_hero_b_1', visitorId(i), '/', { origin: SITE }), ctx)).json()) as DecideResponse;
    }
    assert.equal(got?.variant, 'hero-a');
    assert.deepEqual(got?.changes, [{ selector: 'html', kind: 'attr', attr: 'data-hero', value: 'a' }]);
  });

  await t.test('the new test shows the line to paste, the versions and the guardrails', async () => {
    const said = await body();
    assert.match(said, /Hero A vs Hero B/);
    assert.match(said, /Safety trial/);
    assert.match(said, /aiqb-prototype\.vercel\.app/);
    assert.match(said, /Sets data-hero to “a” on html/);
    assert.match(said, /The page as it is/);
    assert.match(said, /Page errors: Hero A/);
    assert.equal(await p.eval('document.querySelectorAll(".versions tbody tr").length'), 2);
    const tags = await p.eval<string[]>('Array.from(document.querySelectorAll(".code pre")).map(function (e) { return e.textContent; })');
    assert.equal(tags.length, 1, 'just created: the line is in the green note, and not shown a second time under Install');
    for (const tag of tags) assert.equal(tag, `<script src="${base}/agent.js" data-experiment="exp_hero_a_vs_hero_b_1" data-hide=".hero,.story-hero"></script>`);
    await shot('05-test-new');
    await shot('05-test-new', 390);
  });

  await t.test('Activity lists it, and clicking a row opens it', async () => {
    await clickText('.nav a', 'Activity');
    await p.waitFor('document.querySelector("table.tests")');
    const list = await rows();
    assert.equal(list.length, 1);
    assert.match(list[0], /Hero A vs Hero B/);
    assert.match(list[0], /Safety trial/);
    assert.match(await text('.figures'), /1\s*\n?\s*Tests running now/);
    await shot('06-activity');
    await shot('06-activity', 390);
    await click('table.tests tbody tr');
    await p.waitFor('location.hash === "#/test/exp_hero_a_vs_hero_b_1" && document.querySelector(".versions")');
    assert.equal(await p.eval('document.body.innerText.includes("The test is created")'), false, 'the "just created" note is only shown once');
    assert.equal(await text('.side .code pre'), `<script src="${base}/agent.js" data-experiment="exp_hero_a_vs_hero_b_1" data-hide=".hero,.story-hero"></script>`, 'but the line can always be found again under Install');
  });

  await t.test('the kill switch asks first, then shows the original to everyone, and can be undone', async () => {
    await clickText('button', 'Show the original to everyone');
    await p.waitFor('document.querySelector("input[placeholder^=Why]")');
    await clickText('button', 'Cancel');
    assert.equal((await ctx.store.getExperiment('exp_hero_a_vs_hero_b_1'))?.killed, false, 'asking is not doing');
    await clickText('button', 'Show the original to everyone');
    await fill('input[placeholder^=Why]', 'testing the switch');
    await clickText('button', 'Yes, show the original to everyone');
    await p.waitFor('document.body.innerText.includes("The kill switch is on")');
    assert.equal((await ctx.store.getExperiment('exp_hero_a_vs_hero_b_1'))?.killed, true);
    assert.match(await body(), /Paused/);
    assert.match(await body(), /Kill switch on: everyone sees the original/);
    assert.match(await body(), /testing the switch/);
    const gone = (await (await handleDecide(decideReq('exp_hero_a_vs_hero_b_1', visitorId(1), '/', { origin: SITE }), ctx)).json()) as DecideResponse;
    assert.equal(gone.variant, 'original');
    await shot('07-test-paused');
    await clickText('.nav a', 'Activity');
    await p.waitFor('document.querySelector("table.tests")');
    assert.match((await rows())[0], /Paused/);
    await go('#/test/exp_hero_a_vs_hero_b_1');
    await p.waitFor('document.querySelector(".versions")');
    await clickText('button', 'Resume the test');
    await clickText('button', 'Yes, resume the test');
    await p.waitFor('!document.body.innerText.includes("The kill switch is on")');
    assert.equal((await ctx.store.getExperiment('exp_hero_a_vs_hero_b_1'))?.killed, false);
    assert.match(await body(), /Test resumed/);
  });

  await t.test('a text change: the safety checks answer in the page, and the owner fixes it', async () => {
    await go('#/new');
    await p.waitFor('document.querySelector("#f_name")');
    await fill('#f_name', 'Headline');
    await fill('#f_origins', SITE);
    await fill('#f_goalSelector', 'a.hero-cta');
    await fill('#v0_label', 'Shorter');
    await fill('#v0c0selector', 'h1.hero-title');
    await fill('#v0c0text', 'Learn AI in 30 days\nwithout the jargon');
    await fill('#v0c0color', '#14202B');
    await fill('#v0c0bg', '#F6F6F1');
    await fill('#v0c0size', '48');
    await click('.btn--redsolid');
    await p.waitFor('document.querySelector(".note--warn") && /safety checks/.test(document.querySelector(".note--warn").innerText)');
    assert.match(await text('.note--warn'), /30/, 'the number that was not approved is named');
    assert.equal((await ctx.store.listAll()).length, 1, 'nothing was created');
    await shot('08-new-refused');
    await fill('#f_numbers', '30 days');
    await click('.btn--redsolid');
    await p.waitFor('location.hash.indexOf("#/test/exp_headline_1") === 0 && document.querySelector(".versions")');
    assert.match(await body(), /Text of h1\.hero-title becomes “Learn AI in 30 days \/ without the jargon”/);
    const stored = (await (await handleAdmin(adminReq('GET', '/experiments/exp_headline_1'), ctx)).json()) as { weights: Record<string, number> };
    assert.ok(Math.abs(stored.weights.shorter - 0.1) < 1e-9 && Math.abs(stored.weights.original - 0.9) < 1e-9, 'the default start share is 10%');
  });

  await t.test('a pasted experiment file goes through the same checks; an id that exists is explained', async () => {
    await go('#/new');
    await p.waitFor('document.querySelector("details.paste")');
    await p.eval('document.querySelector("details.paste").open = true');
    await fill('textarea[aria-label="Experiment file"]', '{ nope');
    await clickText('button', 'Create from this file');
    assert.match(await text('details.paste .err'), /not valid JSON/);
    const file = (await (await handleAdmin(adminReq('GET', '/experiments/exp_headline_1'), ctx)).json()) as Record<string, unknown>;
    assert.ok(file.id);
    await fill('textarea[aria-label="Experiment file"]', JSON.stringify({ id: 'exp_headline_1', name: 'again', allowedOrigins: [SITE], target: { path: '/' }, goal: { type: 'click', selector: 'a' }, policy: { slots: {}, neverChange: [], facts: { numbers: [], claims: [] }, brand: { colors: [], fonts: [], minFontPx: 12, maxFontPx: 200, forbiddenWords: [] } }, variants: {}, config: {} }));
    await clickText('button', 'Create from this file');
    await p.waitFor('document.querySelector(".note--warn")');
    assert.ok((await text('.note--warn')).length > 10);
  });

  await t.test('Activity with two tests, and a test that does not exist', async () => {
    await go('#/');
    await p.waitFor('document.querySelectorAll("table.tests tbody tr").length === 2');
    await shot('09-activity-two');
    await go('#/test/exp_nope_1');
    await p.waitFor('document.querySelector(".note--warn")');
    assert.match(await body(), /does not exist/);
  });

  await t.test('signing out forgets the token; a token the server later refuses sends you back to sign in', async () => {
    await click('#signout');
    await p.waitFor('document.querySelector("#token")');
    assert.equal(await p.eval('sessionStorage.getItem("hone_admin_token")'), null);
    await fill('#token', ADMIN);
    await click('button[type=submit]');
    await p.waitFor('document.querySelector("table.tests")');
    await p.eval('sessionStorage.setItem("hone_admin_token", "stale"); location.reload()');
    await p.waitFor('document.querySelector("#token") && document.querySelector(".err").textContent.length > 0');
    assert.match(await text('.err'), /refused/);
  });

  await t.test('nothing the server said was ever run as code, and the security policy blocked nothing', async () => {
    assert.deepEqual(await p.eval('window.__csp'), []);
    assert.deepEqual(p.consoleErrors, []);
  });

  await t.test('the security headers are on the console and the page is not frameable', async () => {
    for (const path of ['/console', '/console/console.js']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
      assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    assert.equal((await fetch(`${base}/console/..%2Fpackage.json`)).status, 404);
  });
});

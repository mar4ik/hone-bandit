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
const EXP2 = 'exp_browser02';
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

  const siteHtml = (extra = '', key = EXP, hide = '.hero-title,.hero-cta') => html.replace('<!--HONE-->', `<script src="http://127.0.0.1:${apiPort}/agent.js" data-experiment="${key}" data-hide="${hide}" ${extra}></script>`);
  let streaming = false; // the front page arrives in two parts, the heading cut in half, 300 ms apart
  const site = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' && streaming) {
      const full = siteHtml();
      const cut = full.indexOf('with AI today</h1>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write(full.slice(0, cut));
      return void setTimeout(() => res.end(full.slice(cut)), 300);
    }
    if (path === '/' || path === '/other' || path === '/down' || path === '/index.html' || path === '/switch' || path === '/norem') {
      const body = path === '/down' ? siteHtml('data-api="http://127.0.0.1:9"') : path === '/switch' ? siteHtml('', EXP2, '.hero-a,.hero-b') : path === '/norem' ? siteHtml('data-remember="0"') : siteHtml();
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
  /**
   * storage: things already in the page's storage before anything runs (a saved answer, say).
   * probe: JavaScript that says what the visitor would see right now (or null if not yet); every change is written down, one per screen refresh.
   * beacons: write down everything the page reports.
   */
  const open = async (opts: { visitor?: string; gpc?: boolean; headers?: Record<string, string>; storage?: Record<string, string>; probe?: string; beacons?: boolean } = {}): Promise<Page> => {
    const p = await chrome.newPage();
    pages.push(p);
    await p.setup(UA, ['localhost', '127.0.0.1']);
    if (opts.headers) await p.send('Network.setExtraHTTPHeaders', { headers: opts.headers });
    const init = [
      opts.visitor ? `try{ if(!localStorage.getItem('hone_vid')) localStorage.setItem('hone_vid', ${JSON.stringify(opts.visitor)}) }catch(e){}` : '',
      ...Object.entries(opts.storage ?? {}).map(([k, v]) => `try{ if(!localStorage.getItem(${JSON.stringify(k)})) localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)}) }catch(e){}`),
      opts.gpc ? "Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })" : '',
      opts.probe ? `window.__seen = []; (function tick(){ try { var s = (${opts.probe}); if (s !== null && window.__seen[window.__seen.length - 1] !== s) window.__seen.push(s); } catch (e) {} requestAnimationFrame(tick); })()` : '',
      opts.beacons ? "window.__beacons = []; (function(){ var o = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function (u, b) { Promise.resolve(b.text()).then(function (t) { window.__beacons.push(JSON.parse(t)); }); return o(u, b); }; })()" : '',
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


  // ---- what a visitor who has been here before has saved ----
  const STORE = `hone_ans_${EXP}`;
  const v1Changes = [{ selector: 'h1.hero-title', kind: 'text', text: 'Learn AI without\nthe jargon', context: titleCtx }];
  const v2Changes = [
    { selector: 'a.hero-cta', kind: 'text', text: 'See the courses', context: { color: '#FFFFFF', background: '#C8381A', fontSizePx: 18, bold: true } },
    { selector: 'a.hero-cta', kind: 'style', style: { background: '#14202B' }, context: { color: '#FFFFFF', background: '#C8381A', fontSizePx: 18, bold: true } },
  ];
  const savedAnswer = (id: string, variant: string, changes: unknown[], over: Record<string, unknown> = {}): string =>
    JSON.stringify({ v: 1, t: Date.now(), i: id, p: '/', a: { variant, track: true, changes, goal: { type: 'click', selector: 'a.hero-cta' } }, ...over });
  const fresh = (variant: string, tag: string): string => {
    for (let i = 0; ; i++) {
      const id = `browser-test-${tag}-${variant}-${i}`;
      if (chooseVariant(view, id) === variant) return id;
    }
  };
  const stored = async (p: Page): Promise<{ a: { variant: string; changes: unknown[] } } | null> => JSON.parse(await p.eval<string>(`localStorage.getItem(${JSON.stringify(STORE)}) || 'null'`));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Lets the page draw twice, so that the probe has looked at what is on screen. */
  const frames = (p: Page) => p.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
  /**
   * The heading as a visitor would see it on each screen refresh: "visible|text" or "hidden|". While the browser is still reading the page in,
   * a heading that is only half there is hidden on purpose; that is not written down.
   */
  const HEADING = `(function(){ var h = document.querySelector('h1.hero-title'); if (!h) return null; var v = getComputedStyle(h).visibility; if (v === 'hidden' && document.readyState === 'loading') return null; return v + '|' + h.innerText; })()`;
  const ORIGINAL_HEADING = 'Learn to work\nwith AI today';
  const V1_HEADING = 'Learn AI without\nthe jargon';
  const ORIGINAL_RAW = 'Learn to workwith AI today'; // innerText says nothing about a hidden heading, so the raw text is used where it is hidden
  const rawText = (p: Page, sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  /**
   * Opens the front page and looks at it 250 ms later. If the machine was too busy to get there in time (the page's own 700 ms limit
   * would have passed), it starts over with a new page, a few times; this keeps the checks about waiting honest on a loaded machine.
   */
  const lookEarly = async (mk: () => Promise<Page>, url: string, look: (p: Page) => Promise<void>): Promise<Page> => {
    for (let tries = 0; ; tries++) {
      const p = await mk();
      const t0 = Date.now();
      await p.goto(url);
      await sleep(250);
      if (Date.now() - t0 < 500 || tries >= 4) {
        await look(p);
        return p;
      }
      p.close();
    }
  };
  /** Runs a check while the server's answer is held back. */
  const withSlowServer = async (ms: number, fn: () => Promise<void>): Promise<void> => {
    delayDecideMs = ms;
    try {
      await fn();
    } finally {
      delayDecideMs = 0;
    }
  };

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

  await t.test('switching a data- attribute (one hero for another): the answer is applied, the hidden hero stays hidden, and a click on the shown hero is the goal', async () => {
    const made = await handleAdmin(
      adminReq('POST', '/experiments', experimentBody({
        id: EXP2,
        allowedOrigins: [siteUrl],
        target: { path: '/switch' },
        goal: { type: 'click', selector: '.go-a, .go-b' },
        policy: { ...policy, slots: { html: { kinds: ['attr'], attrs: { 'data-hero': ['a', 'b'] } } } },
        variants: { 'hero-a': { label: 'Hero A', changes: [{ selector: 'html', kind: 'attr', attr: 'data-hero', value: 'a' }] } },
        config: { canaryShare: 0.5 },
      })),
      ctx,
    );
    assert.equal(made.status, 201, await made.clone().text());
    const view2 = viewFromState(EXP2, ['original', 'hero-a'], (await ctx.store.getExperiment(EXP2))!.state, false);
    const idFor2 = (variant: string): string => {
      for (let i = 0; ; i++) {
        const id = `browser-switch-${variant}-${i}`;
        if (chooseVariant(view2, id) === variant) return id;
      }
    };
    const shown = (p: Page, sel: string) => p.eval<boolean>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`);

    const a = await open({ visitor: idFor2('hero-a') });
    await a.goto(`${siteUrl}/switch`);
    await a.waitFor('window.__hone');
    assert.equal((await hone(a))?.variant, 'hero-a');
    assert.equal((await hone(a))?.applyFailed, false);
    assert.equal(await a.eval('document.documentElement.dataset.hero'), 'a');
    assert.equal(await shown(a, '.hero-a'), true);
    assert.equal(await shown(a, '.hero-b'), false);
    await a.eval('document.querySelector(".go-a").addEventListener("click", e => e.preventDefault()); document.querySelector(".go-a").click()');
    await until(async () => (await ctx.store.getVisitor(EXP2, idFor2('hero-a')))?.convertedAt != null);

    const o = await open({ visitor: idFor2('original') });
    await o.goto(`${siteUrl}/switch`);
    await o.waitFor('window.__hone');
    assert.equal((await hone(o))?.variant, 'original');
    assert.equal(await o.eval('document.documentElement.dataset.hero'), 'b', 'the page keeps the hero it started with');
    assert.equal(await shown(o, '.hero-b'), true);
    assert.equal(await shown(o, '.hero-a'), false);
    await o.eval('document.querySelector(".go-b").addEventListener("click", e => e.preventDefault()); document.querySelector(".go-b").click()');
    await until(async () => (await ctx.store.getVisitor(EXP2, idFor2('original')))?.convertedAt != null);
  });

  await t.test('Global Privacy Control: the page is left alone and nothing is stored, not even an id', async () => {
    const id = idFor('v1');
    const p = await open({ visitor: id, gpc: true, storage: { [STORE]: savedAnswer(id, 'v1', v1Changes) } });
    await p.goto(`${siteUrl}/`);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(await p.eval('window.__hone === undefined'), true);
    assert.equal(await text(p, 'h1.hero-title'), 'Learn to work\nwith AI today', 'even a saved answer is not used');
    assert.equal(await visible(p, 'h1.hero-title'), true);
    assert.equal(await p.eval('localStorage.getItem("hone_vid")'), id, 'only what the test put there');
    assert.deepEqual(await p.eval('Object.keys(localStorage).sort()'), ['hone_vid', STORE].sort(), 'nothing new is stored');
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

  // ------------------------------------------------------------------ the remembered answer

  await t.test('a visitor who was here before sees their version from the first screen refresh, even while the server is slow', async () => {
    const id = fresh('v1', 'rem-a');
    const p = await open({ visitor: id, probe: HEADING });
    await p.goto(`${siteUrl}/`); // the first visit: the page waits for the server, which then answers
    await p.waitFor('window.__hone');
    await frames(p);
    assert.equal((await stored(p))?.a.variant, 'v1', 'the answer is kept');
    assert.deepEqual((await p.eval<string[]>('window.__seen')).filter((x) => x.startsWith('visible|')), [`visible|${V1_HEADING}`], 'a new visitor sees the answer, not the original, once it is there');

    await withSlowServer(1500, async () => {
      await p.goto(`${siteUrl}/`);
      assert.equal(await p.eval('window.__hone === undefined'), true, 'the server has not answered yet');
      assert.equal(await text(p, 'h1.hero-title'), V1_HEADING);
      assert.equal(await visible(p, 'h1.hero-title'), true);
      assert.equal(await p.eval('document.documentElement.getAttribute("data-hone-variant")'), 'v1');
      await p.waitFor('window.__hone', 4000);
      assert.equal((await hone(p))?.variant, 'v1');
      await frames(p);
      assert.deepEqual(await p.eval('window.__seen'), [`visible|${V1_HEADING}`], 'never hidden, never the original, never a second change');
    });
  });

  await t.test('a returning visitor who was given the original sees it at once, too', async () => {
    const id = fresh('original', 'rem-b');
    const p = await open({ visitor: id, probe: HEADING });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal((await stored(p))?.a.variant, 'original');
    await withSlowServer(1500, async () => {
      await p.goto(`${siteUrl}/`);
      assert.equal(await p.eval('window.__hone === undefined'), true);
      await frames(p);
      assert.deepEqual(await p.eval('window.__seen'), [`visible|${ORIGINAL_HEADING}`], 'no wait for something that does not change');
    });
  });

  await t.test('a new visitor still waits for the answer, and nothing is kept until it comes', async () => {
    await withSlowServer(1500, async () => {
      await lookEarly(() => open({ visitor: fresh('v1', 'rem-c') }), `${siteUrl}/`, async (p) => {
        assert.equal(await visible(p, 'h1.hero-title'), false, 'hidden while the server thinks');
        assert.equal(await stored(p), null);
        await p.waitFor('window.__hone', 4000);
        assert.equal(await text(p, 'h1.hero-title'), V1_HEADING);
        assert.equal((await stored(p))?.a.variant, 'v1');
      });
    });
  });

  await t.test('when the server says something different, the page switches to it, takes back what the saved answer had changed, and keeps the new answer', async () => {
    const id = fresh('v1', 'rem-d');
    await sleep(400); // let the views that earlier checks reported arrive before counting
    const m0 = await measure();
    const before = { v1: m0.variants.v1.views, v2: m0.variants.v2.views };
    await withSlowServer(2000, async () => {
      // The saved answer is Version 2 (button text and colour), but the server has this visitor on Version 1 (heading).
      const p = await open({ visitor: id, storage: { [STORE]: savedAnswer(id, 'v2', v2Changes) } });
      await p.goto(`${siteUrl}/`);
      assert.equal(await text(p, 'a.hero-cta'), 'See the courses', 'what was saved is shown first');
      assert.equal(await p.eval('getComputedStyle(document.querySelector("a.hero-cta")).backgroundColor'), 'rgb(20, 32, 43)');
      assert.equal(await text(p, 'h1.hero-title'), ORIGINAL_HEADING);
      await p.waitFor('window.__hone', 4000);
      assert.equal((await hone(p))?.variant, 'v1');
      assert.equal(await text(p, 'h1.hero-title'), V1_HEADING);
      assert.equal(await text(p, 'a.hero-cta'), 'Choose a course', 'the button is back as it was');
      assert.equal(await p.eval('getComputedStyle(document.querySelector("a.hero-cta")).backgroundColor'), 'rgb(200, 56, 26)', 'and so is its colour');
      assert.equal(await p.eval('document.documentElement.getAttribute("data-hone-variant")'), 'v1');
      assert.equal((await stored(p))?.a.variant, 'v1', 'the saved answer is now the new one');
    });
    await until(async () => (await measure()).variants.v1.views === before.v1 + 1);
    await sleep(300);
    const after = await measure();
    assert.equal(after.variants.v1.views, before.v1 + 1, 'the view is counted for the version the server chose');
    assert.equal(after.variants.v2.views, before.v2, 'and not for the one that was only shown from memory');
  });

  await t.test('a click on the goal before the server has answered still counts, once', async () => {
    const id = fresh('v1', 'rem-e');
    const p = await open({ visitor: id, beacons: true });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal((await ctx.store.getVisitor(EXP, id))?.convertedAt ?? null, null);
    await withSlowServer(2500, async () => {
      await p.goto(`${siteUrl}/`);
      const clicked = Date.now();
      await p.eval('document.querySelector("a.hero-cta").addEventListener("click", e => e.preventDefault()); document.querySelector("a.hero-cta").click()');
      await until(async () => (await ctx.store.getVisitor(EXP, id))?.convertedAt != null, 1500);
      assert.ok(Date.now() - clicked < 1500, 'counted without waiting for the answer');
      assert.equal(await p.eval('window.__hone === undefined'), true, '(which had not come yet)');
      await p.waitFor('window.__hone', 4000);
      await p.eval('document.querySelector("a.hero-cta").click()'); // and a second click changes nothing
      await sleep(200);
      const sent = await p.eval<Array<{ t: string }>>('window.__beacons');
      assert.equal(sent.filter((b) => b.t === 'goal').length, 1, 'reported once');
      assert.equal(sent.filter((b) => b.t === 'view').length, 1, 'and the view once, after the answer');
    });
  });

  await t.test('a saved answer that is old, for someone else, for another page or damaged is ignored: the page waits for the server as for a new visitor', async () => {
    const cases: Array<[string, (id: string) => string]> = [
      ['older than 6 hours', (id) => savedAnswer(id, 'v1', v1Changes, { t: Date.now() - 7 * 3600 * 1000 })],
      ['from the future', (id) => savedAnswer(id, 'v1', v1Changes, { t: Date.now() + 3600 * 1000 })],
      ['for another visitor id', () => savedAnswer('someone-else-0001', 'v1', v1Changes)],
      ['for another page', (id) => savedAnswer(id, 'v1', v1Changes, { p: '/other' })],
      ['not JSON', () => 'v1 please'],
      ['the visitor was not in the test', (id) => savedAnswer(id, 'v1', v1Changes, { a: { variant: 'v1', track: false, changes: v1Changes, goal: null } })],
      ['changes that make no sense', (id) => savedAnswer(id, 'v1', v1Changes, { a: { variant: 'v1', track: true, changes: [{ selector: 5, kind: 'script' }], goal: null } })],
    ];
    await withSlowServer(1200, async () => {
      for (const [why, make] of cases) {
        const id = fresh('v1', 'rem-f');
        await lookEarly(() => open({ visitor: id, storage: { [STORE]: make(id) } }), `${siteUrl}/`, async (p) => {
          assert.equal(await visible(p, 'h1.hero-title'), false, `${why}: hidden until the server answers`);
          assert.equal(await rawText(p, 'h1.hero-title'), ORIGINAL_RAW, `${why}: nothing from the saved answer is applied`);
          await p.waitFor('window.__hone', 4000);
          assert.equal(await text(p, 'h1.hero-title'), V1_HEADING, why);
          assert.equal((await stored(p))?.a.variant, 'v1', `${why}: replaced by the real answer`);
        });
      }
    });
  });

  await t.test('data-remember="0": nothing is kept and nothing is used', async () => {
    const id = fresh('v1', 'rem-g');
    let p: Page | null = null;
    await withSlowServer(1200, async () => {
      p = await lookEarly(() => open({ visitor: id, storage: { [STORE]: savedAnswer(id, 'v1', v1Changes) } }), `${siteUrl}/norem`, async (q) => {
        assert.equal(await visible(q, 'h1.hero-title'), false, 'waits like a new visitor');
        await q.waitFor('window.__hone', 4000);
      });
    });
    await (p as unknown as Page).goto(`${siteUrl}/norem`);
    await (p as unknown as Page).waitFor('window.__hone');
    const p2 = await open({ visitor: fresh('v1', 'rem-h') });
    await p2.goto(`${siteUrl}/norem`);
    await p2.waitFor('window.__hone');
    assert.deepEqual(await p2.eval('Object.keys(localStorage)'), ['hone_vid'], 'only the visitor id');
  });

  await t.test('a page that is still arriving: the change waits for the heading to be complete, and is applied once, whoever asks first', async () => {
    streaming = true;
    try {
      // A new visitor: the answer is back long before the heading is.
      const id = fresh('v1', 'rem-i');
      const p = await open({ visitor: id, probe: HEADING });
      await p.goto(`${siteUrl}/`);
      await p.waitFor('window.__hone');
      await frames(p);
      assert.equal((await hone(p))?.applyFailed, false, 'nothing is reported as failed just because the page had not arrived yet');
      assert.equal(await text(p, 'h1.hero-title'), V1_HEADING, 'not mixed up with the half that arrived late');
      assert.equal(await p.eval('document.querySelectorAll("h1.hero-title br").length'), 1);
      assert.deepEqual((await p.eval<string[]>('window.__seen')).filter((x) => x.startsWith('visible|')), [`visible|${V1_HEADING}`]);

      // The same visitor again: now the saved answer is waiting for the heading.
      await p.goto(`${siteUrl}/`);
      await p.waitFor('window.__hone');
      await frames(p);
      assert.equal(await text(p, 'h1.hero-title'), V1_HEADING);
      assert.equal(await p.eval('document.querySelectorAll("h1.hero-title br").length'), 1);
      assert.deepEqual((await p.eval<string[]>('window.__seen')).filter((x) => x.startsWith('visible|')), [`visible|${V1_HEADING}`], 'the original is never shown');
    } finally {
      streaming = false;
    }
  });

  await t.test('the hero switch: a returning visitor has the right hero from the first screen refresh, and the other one is never shown', async () => {
    const view2 = viewFromState(EXP2, ['original', 'hero-a'], (await ctx.store.getExperiment(EXP2))!.state, false);
    let id = '';
    for (let i = 0; !id; i++) if (chooseVariant(view2, `browser-switch-rem-${i}`) === 'hero-a') id = `browser-switch-rem-${i}`;
    const HEROES = `(function(){ var a = document.querySelector('.hero-a'), b = document.querySelector('.hero-b'); if (!a || !b) return null; var on = function (e) { var c = getComputedStyle(e); return c.display !== 'none' && c.visibility === 'visible'; }; return 'data-hero=' + document.documentElement.dataset.hero + ' A=' + on(a) + ' B=' + on(b); })()`;
    const p = await open({ visitor: id, probe: HEROES });
    await p.goto(`${siteUrl}/switch`);
    await p.waitFor('window.__hone');
    assert.ok(await p.eval('localStorage.getItem("hone_ans_" + ' + JSON.stringify(EXP2) + ')'), 'saved');
    await withSlowServer(1500, async () => {
      await p.goto(`${siteUrl}/switch`);
      assert.equal(await p.eval('window.__hone === undefined'), true);
      await frames(p);
      assert.deepEqual(await p.eval('window.__seen'), ['data-hero=a A=true B=false'], 'Hero A from the very first refresh, Hero B never');
    });
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


  // ---- an answer that came with the page, in a cookie (edge/hone-edge.mjs decided before the page was sent) ----
  const setCookie = (p: Page, name: string, value: string) => p.send('Network.setCookie', { name, value, url: siteUrl, path: '/' });
  const listenForAnswers = (p: Page) => p.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__answers = []; document.addEventListener("hone:answer", function (e) { window.__answers.push(e.detail); })' });

  await t.test('an answer that arrives in a cookie with the page is shown at once, like a saved one, for a visitor with nothing stored; the server\'s word follows as an event', async () => {
    const id = fresh('v1', 'edge-a');
    const p = await open({ probe: HEADING });
    await listenForAnswers(p);
    await setCookie(p, 'hone_vid', id);
    await setCookie(p, STORE, encodeURIComponent(savedAnswer(id, 'v1', v1Changes)));
    await withSlowServer(1500, async () => {
      await p.goto(`${siteUrl}/`);
      assert.equal(await p.eval('window.__hone === undefined'), true, 'the server has not answered yet');
      assert.equal(await text(p, 'h1.hero-title'), V1_HEADING);
      assert.equal(await visible(p, 'h1.hero-title'), true);
      assert.equal(await p.eval('document.documentElement.getAttribute("data-hone-variant")'), 'v1');
      assert.deepEqual(await p.eval('window.__answers'), [], 'no word from the server yet');
      await p.waitFor('window.__hone', 4000);
      assert.equal((await hone(p))?.visitorId, id, 'the id is the one in the cookie');
      await frames(p);
      assert.deepEqual(await p.eval('window.__seen'), [`visible|${V1_HEADING}`], 'never hidden, never the original, never a second change');
      const answers = await p.eval<Array<{ variant: string; changes: unknown[]; track: boolean }>>('window.__answers');
      assert.equal(answers.length, 1);
      assert.deepEqual([answers[0].variant, answers[0].track, answers[0].changes.length], ['v1', true, 1]);
    });
  });

  await t.test('when the server says something other than the cookie, the page switches, the event says so, and the newer answer is what the next visit uses', async () => {
    const id = fresh('original', 'edge-b');
    const p = await open({ probe: HEADING });
    await listenForAnswers(p);
    await setCookie(p, 'hone_vid', id);
    await setCookie(p, STORE, encodeURIComponent(savedAnswer(id, 'v1', v1Changes)));
    await withSlowServer(600, async () => {
      await p.goto(`${siteUrl}/`);
      assert.equal(await text(p, 'h1.hero-title'), V1_HEADING, 'the cookie\'s answer first');
      await p.waitFor('window.__hone', 4000);
      assert.equal(await text(p, 'h1.hero-title'), ORIGINAL_HEADING, 'then the server\'s');
      const answers = await p.eval<Array<{ variant: string; changes: unknown[] }>>('window.__answers');
      assert.deepEqual(answers.map((a) => [a.variant, a.changes.length]), [['original', 0]]);
    });
    await withSlowServer(1500, async () => {
      await p.goto(`${siteUrl}/`);
      assert.equal(await text(p, 'h1.hero-title'), ORIGINAL_HEADING, 'the newer saved answer beats the older cookie');
      await p.waitFor('window.__hone', 4000);
    });
  });

  await t.test('a cookie answer that is old, for someone else, for another page or damaged is ignored: the page waits for the server as for a new visitor', async () => {
    const id = fresh('v1', 'edge-c');
    const bad: Record<string, string> = {
      old: encodeURIComponent(savedAnswer(id, 'v1', v1Changes, { t: Date.now() - 7 * 3600000 })),
      'someone else': encodeURIComponent(savedAnswer(id, 'v1', v1Changes, { i: 'somebody-else-0000' })),
      'another page': encodeURIComponent(savedAnswer(id, 'v1', v1Changes, { p: '/other' })),
      damaged: '%7Bnot-json',
    };
    for (const [what, value] of Object.entries(bad)) {
      await withSlowServer(1200, async () => {
        const p = await lookEarly(async () => {
          const q = await open({});
          await setCookie(q, 'hone_vid', id);
          await setCookie(q, STORE, value);
          return q;
        }, `${siteUrl}/`, async (q) => {
          assert.equal(await visible(q, 'h1.hero-title'), false, `${what}: hidden while the server thinks`);
          assert.equal(await rawText(q, 'h1.hero-title'), ORIGINAL_RAW, `${what}: nothing was applied from the cookie`);
        });
        await p.waitFor('window.__hone', 4000);
        assert.equal(await text(p, 'h1.hero-title'), V1_HEADING, what);
      });
    }
  });

  await t.test('the kill switch, for a visitor whose answer came in a cookie: back to the original, and the cookie is taken away', async () => {
    const id = fresh('v1', 'edge-k');
    await handleAdmin(adminReq('POST', `/experiments/${EXP}/kill`, { reason: 'browser test, cookie answer' }), ctx);
    try {
      const p = await open({});
      await setCookie(p, 'hone_vid', id);
      await setCookie(p, STORE, encodeURIComponent(savedAnswer(id, 'v1', v1Changes)));
      await withSlowServer(600, async () => {
        await p.goto(`${siteUrl}/`);
        assert.equal(await text(p, 'h1.hero-title'), V1_HEADING, 'shown from the cookie until the server says otherwise');
        await p.waitFor('window.__hone', 4000);
        assert.deepEqual([(await hone(p))?.variant, (await hone(p))?.track], ['original', false]);
        assert.equal(await text(p, 'h1.hero-title'), ORIGINAL_HEADING);
        assert.equal(await p.eval(`document.cookie.indexOf(${JSON.stringify(STORE)}) >= 0`), false, 'the cookie is taken away');
      });
    } finally {
      await handleAdmin(adminReq('POST', `/experiments/${EXP}/resume`, { reason: 'done' }), ctx);
    }
  });

  await t.test('the kill switch, for a visitor with a saved answer: the page goes back to the original, the answer is forgotten, nothing is reported', async () => {
    const id = fresh('v1', 'rem-k');
    const p = await open({ visitor: id });
    await p.goto(`${siteUrl}/`);
    await p.waitFor('window.__hone');
    assert.equal((await stored(p))?.a.variant, 'v1');
    await sleep(400); // this visit's own view arrives first
    const before = (await measure()).variants.v1.views;
    await handleAdmin(adminReq('POST', `/experiments/${EXP}/kill`, { reason: 'browser test, saved answer' }), ctx);
    try {
      await withSlowServer(2000, async () => {
        await p.goto(`${siteUrl}/`);
        assert.equal(await text(p, 'h1.hero-title'), V1_HEADING, 'shown from memory until the server says otherwise');
        await p.waitFor('window.__hone', 4000);
        const h = await hone(p);
        assert.deepEqual([h?.variant, h?.track], ['original', false]);
        assert.equal(await text(p, 'h1.hero-title'), ORIGINAL_HEADING);
        assert.equal(await stored(p), null, 'forgotten');
      });
      await sleep(400);
      assert.equal((await measure()).variants.v1.views, before);
      // A goal click is not reported either: the server ignores it, and the page has stopped watching.
      await p.eval('document.querySelector("a.hero-cta").addEventListener("click", e => e.preventDefault()); document.querySelector("a.hero-cta").click()');
      await sleep(300);
      assert.equal((await ctx.store.getVisitor(EXP, id))?.convertedAt ?? null, null);
    } finally {
      await handleAdmin(adminReq('POST', `/experiments/${EXP}/resume`, { reason: 'done' }), ctx);
    }
  });

});

/*!
 * Hone browser script. One small file, no dependencies, no personal data.
 *
 *   <script src="https://YOUR-HONE-HOST/agent.js" data-experiment="exp_xxxxxxxx" data-hide=".hero-title,.hero-cta" async></script>
 *
 * What it does on each page:
 *  1. Skips everything if the visitor sent Global Privacy Control or Do Not Track.
 *  2. Keeps a random visitor id in this site's own storage (no name, no email, nothing from other sites).
 *  3. Shows the version this visitor should see. A visitor who was here before gets the answer they were given last
 *     time straight away, without waiting for the network; the server is asked again every time, and if it says
 *     something different the page switches to that. A visitor who is new waits for the server's answer (the parts
 *     in data-hide stay hidden until then, at most data-timeout ms). If the server is slow or down, the page simply
 *     shows as it is.
 *  4. Reports: that the page was seen, how healthy it was (errors, load speed), and whether the goal happened.
 *
 * Attributes: data-experiment (required), data-api (default: the host this file came from),
 *             data-hide (selectors to hide until the answer arrives, at most data-timeout ms; default 700),
 *             data-remember (hours to keep the last answer in this site's own storage; default 6; 0 = never).
 *
 * For a site whose server can ask Hone before it sends the page (edge/hone-edge.mjs), the answer arrives in a cookie and
 * this file can load with async: nothing is hidden and nothing waits. When the server's answer comes, the page gets a
 * "hone:answer" event (detail: variant, changes, track, assigned).
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-experiment');
  if (!key) return;

  // 1. Privacy signals: do nothing at all.
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

  var api = (script.getAttribute('data-api') || new URL(script.src, location.href).origin).replace(/\/+$/, '');
  var hideSelectors = script.getAttribute('data-hide') || '';
  var timeoutMs = Number(script.getAttribute('data-timeout')) || 700;
  var rememberHours = script.getAttribute('data-remember');
  var rememberMs = (rememberHours === null || rememberHours === '' || isNaN(Number(rememberHours)) ? 6 : Math.min(Math.max(Number(rememberHours), 0), 720)) * 3600000;
  var path = location.pathname;

  // Hide the parts that may change until the answer arrives, so the visitor never sees one text turn into another.
  var hideStyle = null;
  if (hideSelectors) {
    hideStyle = document.createElement('style');
    hideStyle.textContent = hideSelectors + '{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(hideStyle);
  }
  function reveal() {
    if (hideStyle && hideStyle.parentNode) hideStyle.parentNode.removeChild(hideStyle);
    hideStyle = null;
  }
  setTimeout(reveal, timeoutMs);

  // 2. The visitor id.
  var COOKIE = 'hone_vid';
  function readId() {
    try {
      var v = localStorage.getItem(COOKIE);
      if (v && /^[A-Za-z0-9_-]{8,64}$/.test(v)) return v;
    } catch (e) {}
    var m = document.cookie.match(/(?:^|; )hone_vid=([A-Za-z0-9_-]{8,64})/);
    return m ? m[1] : null;
  }
  function writeId(v) {
    try { localStorage.setItem(COOKIE, v); } catch (e) {}
    try { document.cookie = COOKIE + '=' + v + '; max-age=31536000; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : ''); } catch (e) {}
  }
  function makeId() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var id = readId();
  if (!id) {
    id = makeId();
    writeId(id);
    // If nothing could be stored, the same person would get a new id each time and see random versions. Do nothing instead.
    if (readId() !== id) return reveal();
  }

  // 3. Show a version.
  var errored = false;
  var applyFailed = false;
  var goal = null; // what to watch for; set from the remembered answer first, then from the server's
  var goalFired = false;
  var goalListening = false;

  function cleanPath(p) {
    p = p.split(/[?#]/)[0];
    return p.length > 1 ? p.replace(/\/+$/, '') : p || '/';
  }

  // Each of these changes one thing on the page and gives back a function that puts it back as it was (or null if it could not be done).
  function setText(el, text) {
    var before = Array.prototype.slice.call(el.childNodes);
    while (el.firstChild) el.removeChild(el.firstChild);
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(lines[i]));
    }
    return function () {
      while (el.firstChild) el.removeChild(el.firstChild);
      before.forEach(function (n) { el.appendChild(n); });
    };
  }

  var STYLE_PROPS = { color: 'color', background: 'backgroundColor', fontFamily: 'fontFamily', fontSizePx: 'fontSize' };
  function setStyle(el, style) {
    var before = {};
    Object.keys(style).forEach(function (k) {
      var prop = STYLE_PROPS[k];
      if (!prop) return;
      before[prop] = el.style[prop];
      var v = style[k];
      el.style[prop] = k === 'fontSizePx' ? v + 'px' : k === 'fontFamily' ? '"' + String(v).replace(/"/g, '') + '"' : v;
    });
    return function () {
      Object.keys(before).forEach(function (prop) { el.style[prop] = before[prop]; });
    };
  }

  function setOrder(container, order) {
    var kids = Array.prototype.slice.call(container.children);
    var items = {};
    kids.forEach(function (c) {
      var k = c.getAttribute('data-hone-key');
      if (k) items[k] = c;
    });
    for (var i = 0; i < order.length; i++) if (!items[order[i]]) return null;
    order.forEach(function (k) { container.appendChild(items[k]); });
    return function () {
      kids.forEach(function (c) { container.appendChild(c); });
    };
  }

  // Only data- attributes with plain values: nothing that loads, runs or links can be switched this way.
  function setAttr(el, name, value) {
    if (!/^data-[a-z][a-z0-9-]{0,40}$/.test(String(name)) || !/^[A-Za-z0-9_-]{1,32}$/.test(String(value))) return null;
    var had = el.hasAttribute(name);
    var before = el.getAttribute(name);
    el.setAttribute(name, value);
    return function () {
      if (had) el.setAttribute(name, before);
      else el.removeAttribute(name);
    };
  }

  function applyOne(c, el) {
    try {
      if (c.kind === 'text') return setText(el, c.text);
      if (c.kind === 'style') return setStyle(el, c.style || {});
      if (c.kind === 'order') return setOrder(el, c.order || []);
      if (c.kind === 'attr') return setAttr(el, c.attr, c.value);
    } catch (e) {}
    return null;
  }

  // What the page shows right now: one set of changes, applied element by element so that it can be taken back.
  // While the page is still being read in, a change waits for its element to be complete. Text and order need that
  // (the browser is still adding to them); a style or a data- attribute can be set the moment the element exists.
  var shown = null; // { json, items: [{ change, done: [element], failed }], undo: [function], state: 'pending' | 'settled' | 'dead', waiting: [function] }
  var watcher = null;
  var listening = false;

  function complete(el, kind) {
    if (document.readyState !== 'loading') return true;
    if (kind === 'attr' || kind === 'style') return true;
    for (var n = el; n; n = n.parentNode) if (n.nextSibling) return true; // something comes after it, so the browser is done with it
    return false;
  }

  function step() {
    var s = shown;
    if (!s || s.state !== 'pending') return;
    var all = true;
    s.items.forEach(function (it) {
      var els;
      try { els = document.querySelectorAll(it.change.selector); } catch (e) { els = []; }
      Array.prototype.forEach.call(els, function (el) {
        if (it.done.indexOf(el) >= 0 || !complete(el, it.change.kind)) return;
        it.done.push(el);
        var undo = applyOne(it.change, el);
        if (undo) s.undo.push(undo);
        else it.failed = true;
      });
      if (!it.done.length) all = false;
    });
    // Once the page is fully read in, whatever did not match is not coming.
    if (!all && document.readyState === 'loading') return;
    s.state = 'settled';
    s.failed = s.items.some(function (it) { return it.failed || !it.done.length; });
    if (watcher) { watcher.disconnect(); watcher = null; }
    var w = s.waiting;
    s.waiting = [];
    w.forEach(function (f) { f(); });
  }

  function takeBack(s) {
    if (!s) return;
    s.state = 'dead';
    s.waiting = [];
    for (var i = s.undo.length - 1; i >= 0; i--) {
      try { s.undo[i](); } catch (e) {}
    }
  }

  /** Makes the page show these changes (and only these). Does nothing if it already does. */
  function show(changes) {
    var json = JSON.stringify(changes);
    if (shown && shown.state !== 'dead' && shown.json === json) return shown;
    takeBack(shown);
    shown = { json: json, items: changes.map(function (c) { return { change: c, done: [], failed: false }; }), undo: [], state: 'pending', failed: false, waiting: [] };
    step();
    if (shown.state === 'pending') {
      if (!watcher && window.MutationObserver) {
        watcher = new MutationObserver(step);
        watcher.observe(document.documentElement, { childList: true, subtree: true });
      }
      if (!listening) {
        listening = true;
        document.addEventListener('DOMContentLoaded', step);
      }
    }
    return shown;
  }

  function whenShown(s, fn) {
    if (s.state === 'settled') fn();
    else if (s.state === 'pending') s.waiting.push(fn);
  }

  // The last answer for this page, kept in this site's own storage next to the visitor id.
  var STORE = 'hone_ans_' + key;

  function validChanges(a) {
    if (!Array.isArray(a) || a.length > 50) return false;
    for (var i = 0; i < a.length; i++) {
      var c = a[i];
      if (!c || typeof c !== 'object' || typeof c.selector !== 'string' || c.selector.length > 300) return false;
      if (c.kind !== 'text' && c.kind !== 'style' && c.kind !== 'order' && c.kind !== 'attr') return false;
    }
    return true;
  }
  function validGoal(g) {
    return !g || (typeof g === 'object' && ((g.type === 'click' && typeof g.selector === 'string') || (g.type === 'pageview' && typeof g.path === 'string')));
  }

  /** The saved answer: from this site's storage, or from the cookie a server-side helper (edge/hone-edge.mjs) set before the page was sent. The newer one wins. */
  function saved() {
    var best = null;
    function take(raw) {
      try {
        var x = JSON.parse(raw);
        if (x && typeof x.t === 'number' && (!best || x.t > best.t)) best = x;
      } catch (e) {}
    }
    try { take(localStorage.getItem(STORE)); } catch (e) {}
    var m = document.cookie.match(new RegExp('(?:^|; )' + STORE + '=([^;]*)'));
    if (m) { try { take(decodeURIComponent(m[1])); } catch (e) {} }
    return best;
  }

  function recall() {
    if (!rememberMs) return null;
    try {
      var x = saved();
      if (!x || x.v !== 1 || x.i !== id || x.p !== cleanPath(path) || typeof x.t !== 'number') return null;
      var age = Date.now() - x.t;
      if (age < 0 || age > rememberMs) return null;
      var a = x.a;
      if (!a || a.track !== true || typeof a.variant !== 'string' || !validChanges(a.changes) || !validGoal(a.goal)) return null;
      return a;
    } catch (e) {
      return null;
    }
  }

  /** Only a page the test is about, and only while the visitor is in a running test. Anything else forgets it. */
  function remember(d) {
    if (!rememberMs || !d.target) return;
    try {
      if (d.track && d.variant) {
        localStorage.setItem(STORE, JSON.stringify({ v: 1, t: Date.now(), i: id, p: cleanPath(path), a: { variant: d.variant, track: true, changes: Array.isArray(d.changes) ? d.changes : [], goal: d.goal || null } }));
      } else {
        localStorage.removeItem(STORE);
        if (document.cookie.indexOf(STORE + '=') >= 0) document.cookie = STORE + '=; max-age=0; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
      }
    } catch (e) {}
  }

  function markVariant(variant) {
    if (variant) document.documentElement.setAttribute('data-hone-variant', variant);
    else document.documentElement.removeAttribute('data-hone-variant');
  }

  function revealUnlessWaiting() {
    if (!shown || shown.state !== 'pending') reveal();
  }

  function onAnswer(d) {
    if (!d || d.v !== 1) return revealUnlessWaiting();
    var s = show(Array.isArray(d.changes) ? d.changes : []);
    markVariant(d.variant);
    remember(d);
    whenShown(s, function () {
      reveal();
      applyFailed = s.failed;
      window.__hone = { variant: d.variant, visitorId: id, assigned: d.assigned, track: d.track, applyFailed: applyFailed };
      // The server's word is final: a page that keeps its own copy of the version (to paint it before this file arrives) can follow it.
      try { document.dispatchEvent(new CustomEvent('hone:answer', { detail: { variant: d.variant, changes: Array.isArray(d.changes) ? d.changes : [], track: !!d.track, assigned: !!d.assigned } })); } catch (e) {}
      if (!d.track) {
        goal = null;
        return;
      }
      if (d.target) {
        send('view', applyFailed ? 1 : 0);
        watchHealth();
      }
      watchGoal(d.goal);
    });
  }

  // Always ask, even when the page already shows the remembered answer.
  var url = api + '/api/decide?e=' + encodeURIComponent(key) + '&v=' + encodeURIComponent(id) + '&p=' + encodeURIComponent(path);
  try {
    fetch(url, { credentials: 'omit', cache: 'no-store', mode: 'cors' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(onAnswer)
      .catch(revealUnlessWaiting);
  } catch (e) {
    revealUnlessWaiting();
  }

  var remembered = recall();
  if (remembered) {
    var first = show(remembered.changes);
    markVariant(remembered.variant);
    whenShown(first, reveal);
    // A click that comes before the server has answered still counts: the server checks the visitor and the test itself.
    watchGoal(remembered.goal);
  }

  // 4. Reporting.
  function send(type, err, lcpMs) {
    var body = { e: key, v: id, t: type, p: path, err: err ? 1 : 0 };
    if (lcpMs !== undefined && lcpMs !== null) body.lcp = Math.round(lcpMs);
    var text = JSON.stringify(body);
    var target = api + '/api/event';
    try {
      // text/plain keeps this a "simple" request, so browsers send it without a preflight.
      if (navigator.sendBeacon && navigator.sendBeacon(target, new Blob([text], { type: 'text/plain' }))) return;
    } catch (e) {}
    try { fetch(target, { method: 'POST', body: text, keepalive: true, credentials: 'omit', headers: { 'content-type': 'text/plain' } }); } catch (e) {}
  }

  function watchHealth() {
    window.addEventListener('error', function () { errored = true; });
    window.addEventListener('unhandledrejection', function () { errored = true; });
    var lcp = null;
    try {
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        if (entries.length) lcp = entries[entries.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}
    var sent = false;
    function flush() {
      if (sent) return;
      sent = true;
      // A change that failed to apply was already reported with the view. Do not count the same page twice.
      send('health', errored && !applyFailed, lcp);
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  }

  // The goal is watched once per page. The server's answer replaces the remembered one, and can switch it off.
  function fireGoal() {
    if (goalFired) return;
    goalFired = true;
    send('goal', 0);
  }

  function watchGoal(g) {
    goal = g || null;
    if (!goal) return;
    if (goal.type === 'pageview') {
      if (cleanPath(goal.path) === cleanPath(path)) fireGoal();
    } else if (goal.type === 'click' && !goalListening) {
      goalListening = true;
      document.addEventListener('click', function (ev) {
        if (!goal || goal.type !== 'click') return;
        try { if (ev.target && ev.target.closest && ev.target.closest(goal.selector)) fireGoal(); } catch (e) {}
      }, true);
    }
  }
})();

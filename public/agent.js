/*!
 * Hone browser script. One small file, no dependencies, no personal data.
 *
 *   <script src="https://YOUR-HONE-HOST/agent.js" data-experiment="exp_xxxxxxxx" data-hide=".hero-title,.hero-cta" async></script>
 *
 * What it does on each page:
 *  1. Skips everything if the visitor sent Global Privacy Control or Do Not Track.
 *  2. Keeps a random visitor id in this site's own storage (no name, no email, nothing from other sites).
 *  3. Asks the Hone server which version of the page this visitor should see, and applies the changes.
 *     If the server is slow or down, the page simply shows as it is.
 *  4. Reports: that the page was seen, how healthy it was (errors, load speed), and whether the goal happened.
 *
 * Attributes: data-experiment (required), data-api (default: the host this file came from),
 *             data-hide (selectors to hide until the answer arrives, at most data-timeout ms; default 700).
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

  // 3. Ask, then apply.
  var errored = false;
  var applyFailed = false;

  function cleanPath(p) {
    p = p.split(/[?#]/)[0];
    return p.length > 1 ? p.replace(/\/+$/, '') : p || '/';
  }

  function setText(el, text) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(lines[i]));
    }
  }

  var STYLE_PROPS = { color: 'color', background: 'backgroundColor', fontFamily: 'fontFamily', fontSizePx: 'fontSize' };
  function setStyle(el, style) {
    Object.keys(style).forEach(function (k) {
      var prop = STYLE_PROPS[k];
      if (!prop) return;
      var v = style[k];
      el.style[prop] = k === 'fontSizePx' ? v + 'px' : k === 'fontFamily' ? '"' + String(v).replace(/"/g, '') + '"' : v;
    });
  }

  function setOrder(container, order) {
    var items = {};
    Array.prototype.forEach.call(container.children, function (c) {
      var k = c.getAttribute('data-hone-key');
      if (k) items[k] = c;
    });
    for (var i = 0; i < order.length; i++) if (!items[order[i]]) return false;
    order.forEach(function (k) { container.appendChild(items[k]); });
    return true;
  }

  // Only data- attributes with plain values: nothing that loads, runs or links can be switched this way.
  function setAttr(el, name, value) {
    if (!/^data-[a-z][a-z0-9-]{0,40}$/.test(String(name)) || !/^[A-Za-z0-9_-]{1,32}$/.test(String(value))) return false;
    el.setAttribute(name, value);
    return true;
  }

  /** Returns false if any change could not be applied (a selector that matches nothing, say). */
  function applyChanges(changes) {
    var ok = true;
    changes.forEach(function (c) {
      var els;
      try { els = document.querySelectorAll(c.selector); } catch (e) { els = []; }
      if (!els.length) { ok = false; return; }
      Array.prototype.forEach.call(els, function (el) {
        if (c.kind === 'text') setText(el, c.text);
        else if (c.kind === 'style') setStyle(el, c.style || {});
        else if (c.kind === 'order') { if (!setOrder(el, c.order || [])) ok = false; }
        else if (c.kind === 'attr') { if (!setAttr(el, c.attr, c.value)) ok = false; }
      });
    });
    return ok;
  }

  function onAnswer(d) {
    if (!d || d.v !== 1) return reveal();
    if (d.changes && d.changes.length) applyFailed = !applyChanges(d.changes);
    reveal();
    window.__hone = { variant: d.variant, visitorId: id, assigned: d.assigned, track: d.track, applyFailed: applyFailed };
    if (d.variant) document.documentElement.setAttribute('data-hone-variant', d.variant);
    if (!d.track) return;
    if (d.target) {
      send('view', applyFailed ? 1 : 0);
      watchHealth();
    }
    watchGoal(d.goal);
  }

  var url = api + '/api/decide?e=' + encodeURIComponent(key) + '&v=' + encodeURIComponent(id) + '&p=' + encodeURIComponent(path);
  try {
    fetch(url, { credentials: 'omit', cache: 'no-store', mode: 'cors' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(onAnswer)
      .catch(reveal);
  } catch (e) {
    reveal();
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

  function watchGoal(goal) {
    if (!goal) return;
    var fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      send('goal', 0);
    }
    if (goal.type === 'pageview') {
      if (cleanPath(goal.path) === cleanPath(path)) fire();
    } else if (goal.type === 'click') {
      document.addEventListener('click', function (ev) {
        try { if (ev.target && ev.target.closest && ev.target.closest(goal.selector)) fire(); } catch (e) {}
      }, true);
    }
  }
})();

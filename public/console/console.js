/*
 * Hone console: sign in, see every test, stop or resume one, and create a new one.
 * Plain JavaScript, no libraries. It only talks to this server's /api/admin endpoints.
 * Everything that comes from the server is written into the page as text, never as markup.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'hone_admin_token';
  var view = document.getElementById('view');
  var nav = document.getElementById('nav');
  var gen = 0; // each screen takes a number; a slow answer for an old screen is dropped

  // ------------------------------------------------------------------ small helpers

  /** h('div', {class: 'x', onclick: fn}, 'text', childNode, [more]) builds an element. Text is always text. */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }
  function show(node) {
    clear(view);
    view.appendChild(node);
    window.scrollTo(0, 0);
  }

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return memoryToken; }
  }
  var memoryToken = '';
  function setToken(t) {
    memoryToken = t;
    try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { authorization: 'Bearer ' + getToken() }, cache: 'no-store' };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch('/api/admin/' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) signOut('That token was refused. Sign in again.');
        return { status: r.status, data: data };
      });
    });
  }

  function signOut(message) {
    setToken('');
    sessionMessage = message || '';
    gen++;
    route();
  }
  var sessionMessage = '';

  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return new Date(ms).toISOString(); }
  }
  function fmtDay(ms) {
    try { return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' }); } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtPct(x, digits) { return x === null || x === undefined || !isFinite(x) ? '–' : (x * 100).toFixed(digits === undefined ? 1 : digits) + '%'; }
  function fmtSec(ms) { return ms === null || ms === undefined ? '–' : (ms / 1000).toFixed(1) + ' s'; }

  var STAGES = {
    canary: ['Safety trial', 'Each new version gets its starting share of visitors while Hone checks only for errors and slow pages.'],
    warmup: ['Warm-up', 'An equal split while enough visitors arrive.'],
    bandit: ['Learning', 'Traffic shifts toward what works.'],
    confirm: ['Confirming', 'A fixed even split between the leader and the original.'],
    promoted: ['Winner chosen', 'The winner now goes to everyone.'],
    stopped: ['Stopped', 'A safety check stopped the test.'],
  };
  function stageLabel(s) { return (STAGES[s] || [s])[0]; }
  function isRunning(e) { return !e.killed && ['canary', 'warmup', 'bandit', 'confirm'].indexOf(e.stage) >= 0; }

  function copyText(text, button) {
    function done() {
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = old; }, 1500);
    }
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch (e) {
      fallback();
    }
    function fallback() {
      var ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  function scriptTag(id, hide) {
    return '<script src="' + location.origin + '/agent.js" data-experiment="' + id + '"' + (hide ? ' data-hide="' + hide + '"' : '') + '></script>';
  }
  function codeBox(text) {
    var btn = h('button', { type: 'button' }, 'Copy');
    btn.addEventListener('click', function () { copyText(text, btn); });
    return h('div', { class: 'code' }, h('pre', null, text), btn);
  }

  function describeChange(c) {
    if (c.kind === 'text') return 'Text of ' + c.selector + ' becomes “' + String(c.text).replace(/\n/g, ' / ') + '”';
    if (c.kind === 'attr') return 'Sets ' + c.attr + ' to “' + c.value + '” on ' + c.selector;
    if (c.kind === 'style') return 'Changes the look of ' + c.selector;
    if (c.kind === 'order') return 'Reorders the items in ' + c.selector;
    return c.kind + ' on ' + c.selector;
  }

  // ------------------------------------------------------------------ sign in

  function renderSignIn() {
    nav.hidden = true;
    var input = h('input', { type: 'password', id: 'token', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'token-hint' });
    var error = h('p', { class: 'err', role: 'alert' }, sessionMessage);
    sessionMessage = '';
    var button = h('button', { type: 'submit', class: 'btn btn--solid' }, 'Sign in');
    var form = h('form', { class: 'stack', onsubmit: submit },
      h('div', { class: 'field' },
        h('label', { for: 'token' }, 'Admin token'),
        input,
        h('span', { class: 'hint', id: 'token-hint' }, 'The secret saved as ADMIN_TOKEN on the server. It stays in this browser tab and is forgotten when you close the tab.')),
      error,
      h('div', null, button));
    show(h('div', { class: 'page page--narrow' },
      h('h1', null, 'Sign in'),
      h('p', { class: 'lead' }, 'Hone tests changes to your website and keeps the ones that work. Paste your admin token to see and manage your tests.'),
      h('div', { style: 'margin-top:32px' }, form)));
    input.focus();

    function submit(ev) {
      ev.preventDefault();
      var t = input.value.trim();
      if (!t) { error.textContent = 'Paste the token first.'; return; }
      button.disabled = true;
      error.textContent = '';
      setToken(t);
      fetch('/api/admin/experiments', { headers: { authorization: 'Bearer ' + t }, cache: 'no-store' }).then(function (r) {
        button.disabled = false;
        if (r.status === 200) { location.hash = '#/'; route(); return; }
        setToken('');
        error.textContent = r.status === 401 ? 'That token does not match the one on the server.'
          : r.status === 503 ? 'The admin side is switched off: ADMIN_TOKEN is not set on the server.'
          : 'The server answered ' + r.status + '. Try again in a moment.';
      }).catch(function () {
        button.disabled = false;
        setToken('');
        error.textContent = 'Could not reach the server. Check your connection.';
      });
    }
  }

  // ------------------------------------------------------------------ activity

  function renderActivity() {
    var my = ++gen;
    show(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading your tests…')));
    api('GET', 'experiments').then(function (res) {
      if (my !== gen) return;
      if (res.status !== 200) return failed(res);
      var list = (res.data.experiments || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 40);
      if (!list.length) return show(page(h('div', { class: 'empty' },
        h('h2', null, 'No tests yet'),
        h('p', { class: 'muted' }, 'A test shows some visitors a different version of one thing on your page and counts what they do.'),
        h('p', null, h('a', { class: 'btn btn--solid', href: '#/new' }, 'Create your first test')))));
      return Promise.all(list.map(function (e) {
        return api('GET', 'experiments/' + encodeURIComponent(e.id)).then(function (r) { return r.status === 200 ? r.data : { id: e.id, name: e.name, stage: e.stage, killed: e.killed, createdAt: e.createdAt, progress: {} }; });
      })).then(function (all) {
        if (my !== gen) return;
        show(page(activityBody(all)));
      });
    }).catch(function () { if (my === gen) failed(null); });

    function page(body) {
      return h('div', { class: 'page' },
        h('div', { class: 'titlebar' },
          h('div', null, h('h1', null, 'Activity'), h('p', { class: 'lead' }, 'Every test you have made, newest first.')),
          h('a', { class: 'btn btn--solid', href: '#/new' }, 'New test')),
        body);
    }
  }

  function totals(e) {
    var visitors = 0;
    var goals = 0;
    var p = e.progress || {};
    Object.keys(p).forEach(function (k) { visitors += p[k].visitors || 0; goals += p[k].converted || 0; });
    return { visitors: visitors, goals: goals };
  }

  function activityBody(all) {
    var running = all.filter(isRunning).length;
    var paused = all.filter(function (e) { return e.killed; }).length;
    var done = all.filter(function (e) { return e.stage === 'promoted' || e.stage === 'stopped'; }).length;
    var rows = all.map(function (e) {
      var t = totals(e);
      var go = function () { location.hash = '#/test/' + e.id; };
      return h('tr', { class: 'clickable', onclick: go },
        h('td', null,
          h('a', { href: '#/test/' + e.id, onclick: function (ev) { ev.stopPropagation(); } }, e.name),
          h('div', { class: 'mono muted small' }, e.id)),
        h('td', null,
          e.killed ? h('span', { class: 'chip chip--red' }, 'Paused') : h('span', { class: 'chip chip--ink', title: (STAGES[e.stage] || [])[1] || '' }, stageLabel(e.stage))),
        h('td', { class: 'num', 'data-label': 'Visitors' }, fmtInt(t.visitors)),
        h('td', { class: 'num', 'data-label': 'Goals' }, fmtInt(t.goals)),
        h('td', { class: 'num', 'data-label': 'Started' }, fmtDay(e.createdAt)));
    });
    return [
      h('div', { class: 'figures' },
        fig(running, 'Tests running now', 'Counting visitors and clicks'),
        fig(paused, 'Paused by the kill switch', 'Everyone sees the original'),
        fig(done, 'Finished', 'A winner was chosen, or a safety check stopped it')),
      h('table', { class: 'tests', style: 'margin-top:36px' },
        h('thead', null, h('tr', null,
          h('th', null, 'Test'), h('th', null, 'Stage'),
          h('th', { class: 'num' }, 'Visitors'), h('th', { class: 'num' }, 'Goals'), h('th', { class: 'num' }, 'Started'))),
        h('tbody', null, rows)),
    ];
  }

  function fig(n, title, sub) {
    return h('div', { class: 'fig' }, h('div', { class: 'fig__n' }, String(n)), h('div', { class: 'fig__t' }, title), h('div', { class: 'fig__s' }, sub));
  }

  function failed(res) {
    var msg = !res ? 'Could not reach the server. Check your connection and reload.'
      : res.status === 404 ? 'That test does not exist.'
      : 'The server answered ' + res.status + ' (' + (res.data && res.data.error ? res.data.error : 'no details') + ').';
    show(h('div', { class: 'page' }, h('div', { class: 'note note--warn', role: 'alert' }, h('strong', null, 'Something went wrong'), msg), h('p', null, h('a', { href: '#/' }, 'Back to Activity'))));
  }

  // ------------------------------------------------------------------ one test

  function renderTest(id, fresh) {
    var my = ++gen;
    show(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
    api('GET', 'experiments/' + encodeURIComponent(id)).then(function (res) {
      if (my !== gen) return;
      if (res.status !== 200) return failed(res);
      show(testPage(res.data, fresh, function () { renderTest(id, false); }));
    }).catch(function () { if (my === gen) failed(null); });
  }

  function testPage(e, fresh, reload) {
    var t = totals(e);
    var site = (e.allowedOrigins || []).filter(function (o) { return !/localhost|127\.0\.0\.1/.test(o); })[0] || (e.allowedOrigins || [])[0] || '';
    var progress = e.progress || {};
    var weights = e.weights || {};
    var orig = progress.original || {};

    // The kill switch asks first, in the page, so nobody stops a test by accident.
    var killBox = h('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:flex-start' });
    function drawKill(step) {
      clear(killBox);
      if (step === 'ask') {
        var reason = h('input', { type: 'text', 'aria-label': 'Why are you stopping it? (optional)', placeholder: 'Why? (optional)', maxlength: '200' });
        var go = h('button', { type: 'button', class: 'btn btn--redsolid' }, e.killed ? 'Yes, resume the test' : 'Yes, show the original to everyone');
        go.addEventListener('click', function () {
          go.disabled = true;
          api('POST', 'experiments/' + encodeURIComponent(e.id) + '/' + (e.killed ? 'resume' : 'kill'), { reason: reason.value.trim() || 'from the console' })
            .then(function (r) { if (r.status === 200) reload(); else { go.disabled = false; killBox.appendChild(h('p', { class: 'err', role: 'alert' }, 'The server answered ' + r.status + '.')); } })
            .catch(function () { go.disabled = false; killBox.appendChild(h('p', { class: 'err', role: 'alert' }, 'Could not reach the server.')); });
        });
        add(killBox, [reason, h('div', { style: 'display:flex;gap:12px;align-items:center' }, go, h('button', { type: 'button', class: 'link', onclick: function () { drawKill('idle'); } }, 'Cancel'))]);
        reason.focus();
        return;
      }
      if (e.killed) {
        add(killBox, [h('button', { type: 'button', class: 'btn', onclick: function () { drawKill('ask'); } }, 'Resume the test'), h('div', { class: 'small muted' }, 'Brings back the same versions for the same visitors.')]);
      } else if (e.stage === 'promoted' || e.stage === 'stopped') {
        add(killBox, h('div', { class: 'small muted' }, 'This test is finished.'));
      } else {
        add(killBox, [h('button', { type: 'button', class: 'btn btn--red', onclick: function () { drawKill('ask'); } }, 'Show the original to everyone'), h('div', { class: 'small muted' }, 'Kill switch. Takes effect on the next page load.')]);
      }
    }
    drawKill('idle');

    var notes = [];
    if (fresh) {
      notes.push(h('div', { class: 'note note--ok' },
        h('strong', null, 'The test is created. It changes nothing on your site yet.'),
        'Add this line in the head of the page, before your other scripts, without async or defer. Then open the page in a private window to see a version.'));
      notes.push(codeBox(scriptTag(e.id, e.hide)));
    }
    if (e.killed) notes.push(h('div', { class: 'note note--warn' }, h('strong', null, 'The kill switch is on'), 'Everyone sees the original page, and nothing is being recorded.'));
    if (e.frozen) notes.push(h('div', { class: 'note' }, h('strong', null, 'Traffic shifts are frozen'), typeof e.frozen === 'object' && e.frozen && e.frozen.reason ? String(e.frozen.reason) : 'The numbers look unusual, so Hone is waiting.'));
    if (e.outcome) {
      var o = e.outcome;
      var win = o.winnerId && (e.variants || []).filter(function (v) { return v.id === o.winnerId; })[0];
      notes.push(h('div', { class: 'note note--ok' }, h('strong', null, o.kind === 'promoted' ? 'A winner was chosen' : 'Outcome'), (win ? win.label + '. ' : '') + (o.reason ? String(o.reason) : '')));
    }

    var rows = (e.variants || []).map(function (v) {
      var p = progress[v.id] || {};
      var share = weights[v.id] || 0;
      var isOrig = v.id === 'original';
      var changes = (v.changes || []).map(function (c) { return h('div', { class: 'vdesc' }, describeChange(c)); });
      return h('tr', null,
        h('td', null,
          h('div', { class: 'vname' }, v.label, ' ', v.status && v.status !== 'live' ? h('span', { class: 'chip chip--red' }, v.status.replace('_', ' ')) : null),
          isOrig ? h('div', { class: 'vdesc' }, 'The page as it is') : changes,
          v.reason && v.status !== 'live' ? h('div', { class: 'small muted' }, v.reason) : null),
        h('td', { 'data-label': 'Share' }, h('div', { class: 'bar' + (isOrig ? ' bar--orig' : '') }, h('div', { class: 'bar__track' }, h('div', { class: 'bar__fill', style: 'width:' + Math.round(share * 100) + '%' })), h('div', { class: 'bar__pct' }, Math.round(share * 100) + '%'))),
        h('td', { class: 'num', 'data-label': 'Visitors' }, fmtInt(p.visitors)),
        h('td', { class: 'num', 'data-label': 'Goals' }, fmtInt(p.converted)),
        h('td', { class: 'num', 'data-label': 'Rate' }, p.visitors ? fmtPct(p.converted / p.visitors) : '–'));
    });

    var guards = (e.variants || []).filter(function (v) { return v.id !== 'original'; }).map(function (v) {
      var p = progress[v.id] || {};
      var ratio = '–';
      if (p.views) ratio = fmtInt(p.errors) + ' of ' + fmtInt(p.views) + ' views';
      var delta = '–';
      if (p.avgLcpMs != null && orig.avgLcpMs != null) delta = (p.avgLcpMs - orig.avgLcpMs >= 0 ? '+' : '') + Math.round(p.avgLcpMs - orig.avgLcpMs) + ' ms';
      return [
        h('div', { class: 'guard' }, h('div', null, h('b', null, 'Page errors: ' + v.label), h('span', { class: 'small muted' }, 'Stops a version above 2 times the original’s error rate, once it has 200 views')), h('span', { class: 'mono small' }, ratio)),
        h('div', { class: 'guard' }, h('div', null, h('b', null, 'Page speed: ' + v.label), h('span', { class: 'small muted' }, 'Stops a version more than 200 ms slower than the original, once it has 200 samples')), h('span', { class: 'mono small' }, delta)),
      ];
    });

    var audit = (e.audit || []).slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 12).map(function (a) {
      return h('li', null, h('div', { class: 'when' }, fmtDate(a.at) + ' · ' + (a.actor === 'person' ? 'you' : a.actor === 'safety' ? 'safety check' : 'Hone')),
        h('div', { class: 'vname' }, describeAudit(a, e)), a.reason ? h('div', { class: 'small muted' }, a.reason) : null);
    });

    var goal = e.goal && e.goal.type === 'click' ? 'A click on ' + e.goal.selector : e.goal ? 'A visit to ' + e.goal.path : '–';

    return h('div', { class: 'page' },
      h('div', { class: 'titlebar' },
        h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
          h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;font-size:14px' },
            h('span', { style: 'font-weight:600' }, h('span', { class: 'dot' + (e.killed ? ' dot--paused' : e.stage === 'promoted' ? ' dot--done' : '') }), e.killed ? 'Paused' : stageLabel(e.stage)),
            site ? h('span', { class: 'muted' }, site.replace(/^https?:\/\//, '')) : null,
            h('span', { class: 'chip' }, e.id)),
          h('h1', null, e.name),
          h('p', { class: 'small muted', style: 'margin:0;max-width:640px' }, (STAGES[e.stage] || [])[1] || '')),
        killBox),
      notes.length ? h('div', { class: 'stack', style: 'margin-top:28px' }, notes) : null,
      h('div', { class: 'figures' },
        fig(fmtInt(t.visitors), 'Visitors counted', 'Across all versions'),
        fig(fmtInt(t.goals), 'Goals reached', t.visitors ? fmtPct(t.goals / t.visitors) + ' of visitors' : 'None yet'),
        fig(fmtDay(e.createdAt), 'Started', 'Last checked ' + fmtDate(e.tickedAt))),
      h('div', { class: 'cols' },
        h('div', { class: 'cols__main' },
          h('section', { class: 'sec' },
            h('h2', null, 'Versions', h('small', null, 'Counts so far')),
            h('table', { class: 'versions' },
              h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Share of new visitors'), h('th', { class: 'num' }, 'Visitors'), h('th', { class: 'num' }, 'Goals'), h('th', { class: 'num' }, 'Rate'))),
              h('tbody', null, rows)),
            h('p', { class: 'small muted' }, 'Early numbers move a lot. Hone judges each visitor after a 7-day window, so a real result needs real traffic and about a week.')),
          h('section', { class: 'sec' },
            h('h2', null, 'What Hone decided'),
            audit.length ? h('ul', { class: 'list' }, audit) : h('p', { class: 'muted' }, 'Nothing yet.'))),
        h('div', { class: 'cols__side side' },
          h('section', null, h('h2', null, 'Guardrails'), guards.length ? guards : h('p', { class: 'muted' }, 'No other versions.')),
          fresh ? null : h('section', { class: 'stack' }, h('h2', null, 'Install'),
            h('p', { class: 'small muted', style: 'margin:0' }, 'In the head of the page, before your other scripts, without async or defer.'),
            codeBox(scriptTag(e.id, e.hide)),
            e.hide ? null : h('p', { class: 'small muted', style: 'margin:0' }, 'This test has no hide list saved. Add data-hide with the selectors to hold back, if you need it.')),
          h('section', null, h('h2', null, 'About this test'),
            h('dl', { class: 'kv', style: 'margin-top:14px' },
              h('dt', null, 'Goal'), h('dd', null, goal),
              h('dt', null, 'Page'), h('dd', null, (e.target ? e.target.path : '/') + (e.target && e.target.match === 'prefix' ? ' and below' : ' only')),
              h('dt', null, 'Sites'), h('dd', null, (e.allowedOrigins || []).join(', '))))
        )));
  }

  function describeAudit(a, e) {
    var label = a.variantId && (e.variants || []).filter(function (v) { return v.id === a.variantId; })[0];
    var name = label ? label.label : a.variantId || '';
    var map = {
      experiment_started: 'Test started',
      kill_switch_on: 'Kill switch on: everyone sees the original',
      kill_switch_off: 'Test resumed',
      stopped: 'Stopped a version: ' + name,
      rolled_back: 'Rolled back a version: ' + name,
      retired: 'Retired a version: ' + name,
      data_health_freeze: 'Froze traffic shifts',
      data_health_clear: 'Unfroze traffic shifts',
      bandit_result: 'Learning stage finished',
    };
    if (map[a.action]) return map[a.action];
    if (/^stage_/.test(a.action)) return 'Moved to: ' + stageLabel(a.action.slice(6));
    return a.action.replace(/_/g, ' ');
  }

  // ------------------------------------------------------------------ new test

  function newChange(kind) {
    return kind === 'attr'
      ? { kind: 'attr', selector: 'html', attr: '', value: '' }
      : { kind: 'text', selector: '', text: '', color: '', bg: '', size: '', bold: false };
  }

  function slug(s) {
    var x = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return 'exp_' + (x || 'test') + '_1';
  }

  function renderNew() {
    var my = ++gen;
    var f = {
      name: '', id: '', idEdited: false, origins: 'https://', path: '/', match: 'exact', hide: '',
      goalType: 'click', goalSelector: '', goalPath: '',
      variants: [{ label: '', changes: [newChange('text')] }],
      neverChange: 'price, legal, consent, form, checkout, cookie, payment',
      numbers: '', claims: '', forbidden: '',
      share: 10,
    };
    var serverErrors = h('div', { 'aria-live': 'polite' });
    var problems = h('div', { 'aria-live': 'polite' });
    var tagBox = h('div');
    var variantsBox = h('div', { class: 'stack' });
    var idInput;

    function bound(label, key, opts) {
      opts = opts || {};
      var id = 'f_' + key;
      var input = opts.area ? h('textarea', { id: id, class: opts.mono ? 'mono' : '', rows: opts.rows || 3, placeholder: opts.placeholder || '' })
        : h('input', { id: id, type: opts.type || 'text', class: opts.mono ? 'mono' : '', placeholder: opts.placeholder || '', min: opts.min, max: opts.max, autocomplete: 'off', spellcheck: 'false' });
      input.value = f[key];
      input.addEventListener('input', function () {
        f[key] = opts.type === 'number' ? Number(input.value) : input.value;
        if (key === 'name' && !f.idEdited) { f.id = slug(f.name); if (idInput) idInput.value = f.id; }
        if (key === 'id') f.idEdited = true;
        refreshTag();
      });
      if (key === 'id') idInput = input;
      return h('div', { class: 'field' }, h('label', { for: id }, label), input, opts.hint ? h('span', { class: 'hint' }, opts.hint) : null);
    }

    function refreshTag() {
      clear(tagBox);
      tagBox.appendChild(codeBox(scriptTag(f.id || 'exp_…', f.hide.trim())));
    }

    function drawVariants() {
      clear(variantsBox);
      variantsBox.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card__head' }, h('div', null, h('div', { class: 'vname' }, 'Original'), h('div', { class: 'vdesc' }, 'The page as it is. Always part of the test.')), h('span', { class: 'chip' }, 'control'))));
      f.variants.forEach(function (v, vi) {
        var label = h('input', { type: 'text', id: 'v' + vi + '_label', placeholder: 'For example: Hero A', maxlength: '80', autocomplete: 'off' });
        label.value = v.label;
        label.addEventListener('input', function () { v.label = label.value; });
        var changesBox = h('div', { class: 'stack' });
        v.changes.forEach(function (c, ci) { changesBox.appendChild(changeCard(v, vi, c, ci)); });
        variantsBox.appendChild(h('div', { class: 'card' },
          h('div', { class: 'card__head' },
            h('div', { class: 'field', style: 'flex:1' }, h('label', { for: 'v' + vi + '_label' }, 'Version ' + (vi + 1) + ' name'), label),
            f.variants.length > 1 ? h('button', { type: 'button', class: 'link link--red', onclick: function () { f.variants.splice(vi, 1); drawVariants(); } }, 'Remove version') : null),
          changesBox,
          h('div', null, h('button', { type: 'button', class: 'link', onclick: function () { v.changes.push(newChange('text')); drawVariants(); } }, '+ Add another change to this version'))));
      });
      variantsBox.appendChild(h('div', null, f.variants.length < 6 ? h('button', { type: 'button', class: 'btn btn--small', onclick: function () { f.variants.push({ label: '', changes: [newChange('text')] }); drawVariants(); } }, 'Add a version') : null));
    }

    function changeCard(v, vi, c, ci) {
      var kind = h('select', { 'aria-label': 'What kind of change' },
        h('option', { value: 'text' }, 'Change some text'),
        h('option', { value: 'attr' }, 'Switch a page version (a data- attribute)'));
      kind.value = c.kind;
      kind.addEventListener('change', function () { v.changes[ci] = newChange(kind.value); drawVariants(); });
      function inp(label, key, opts) {
        opts = opts || {};
        var id = 'v' + vi + 'c' + ci + key;
        var el = opts.area ? h('textarea', { id: id, rows: 2 }) : h('input', { id: id, type: opts.type || 'text', placeholder: opts.placeholder || '', class: opts.mono ? 'mono' : '', autocomplete: 'off', spellcheck: 'false' });
        el.value = c[key];
        el.addEventListener('input', function () { c[key] = el.value; });
        return h('div', { class: 'field' }, h('label', { for: id }, label), el, opts.hint ? h('span', { class: 'hint' }, opts.hint) : null);
      }
      var body;
      if (c.kind === 'attr') {
        body = [
          h('div', { class: 'row' },
            inp('Where', 'selector', { mono: true, placeholder: 'html' }),
            inp('Attribute', 'attr', { mono: true, placeholder: 'data-hero' }),
            inp('Set it to', 'value', { mono: true, placeholder: 'a' })),
          h('p', { class: 'hint', style: 'margin:0' }, 'Where is the element that carries the attribute, often html. Use this when your page already contains both versions and a data- attribute decides which one shows. The test can only set this one attribute to the value you give here.'),
        ];
      } else {
        var bold = h('input', { type: 'checkbox', id: 'v' + vi + 'c' + ci + 'bold' });
        bold.checked = c.bold;
        bold.addEventListener('change', function () { c.bold = bold.checked; });
        body = [
          inp('Where on the page (a CSS selector)', 'selector', { mono: true, placeholder: 'h1.hero-title' }),
          inp('New text', 'text', { area: true, hint: 'A new line in the box becomes a line break on the page.' }),
          h('div', { class: 'label' }, 'How it looks today'),
          h('div', { class: 'row' },
            inp('Text colour', 'color', { mono: true, placeholder: '#FFFFFF' }),
            inp('Background', 'bg', { mono: true, placeholder: '#000000' }),
            inp('Size in px', 'size', { type: 'number', placeholder: '48' }),
            h('label', { class: 'check', for: 'v' + vi + 'c' + ci + 'bold', style: 'padding-bottom:10px' }, bold, 'Bold')),
          h('p', { class: 'hint', style: 'margin:0' }, 'Copy these from the page. Hone uses them to check that the new words stay easy to read.'),
        ];
      }
      return h('div', { class: 'change' },
        h('div', { class: 'card__head' }, h('div', { style: 'flex:1' }, kind), v.changes.length > 1 ? h('button', { type: 'button', class: 'link link--red', onclick: function () { v.changes.splice(ci, 1); drawVariants(); } }, 'Remove change') : null),
        body);
    }

    // ---- turning the form into an experiment
    function listOf(s) { return String(s).split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }

    function build() {
      var errs = [];
      var name = f.name.trim();
      if (!name) errs.push('Give the test a name.');
      var id = f.id.trim();
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) errs.push('The test id must be 3 to 64 letters, digits, - or _.');
      var origins = String(f.origins).split(/[\s,]+/).filter(Boolean).map(function (o) { return o.replace(/\/+$/, ''); });
      if (!origins.length || origins.some(function (o) { return !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o); })) errs.push('Site addresses must look like https://example.com, one per line, with no page path.');
      var path = f.path.trim();
      if (path.charAt(0) !== '/') errs.push('The page must start with /, for example /.');
      var goal;
      if (f.goalType === 'click') {
        if (!f.goalSelector.trim()) errs.push('Say which button counts: give its selector.');
        goal = { type: 'click', selector: f.goalSelector.trim() };
      } else {
        if (f.goalPath.trim().charAt(0) !== '/') errs.push('The goal page must start with /.');
        goal = { type: 'pageview', path: f.goalPath.trim() };
      }
      if (f.hide.trim() && /["'<>{};\\]/.test(f.hide)) errs.push('The hide list can only hold plain selectors separated by commas (no quotes or brackets).');
      var share = Number(f.share);
      if (!(share >= 1 && share <= 50)) errs.push('The starting share must be between 1% and 50%.');

      var slots = {};
      var variants = {};
      var used = {};
      f.variants.forEach(function (v, vi) {
        var label = v.label.trim();
        if (!label) errs.push('Version ' + (vi + 1) + ' needs a name.');
        var vid = (label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'v' + (vi + 1));
        if (vid === 'original') vid = 'original-2';
        while (used[vid]) vid += '-' + (vi + 1);
        used[vid] = true;
        var changes = [];
        v.changes.forEach(function (c, ci) {
          var where = 'Version ' + (vi + 1) + ', change ' + (ci + 1) + ': ';
          var sel = c.selector.trim();
          if (!sel) { errs.push(where + 'say where on the page.'); return; }
          var slot = slots[sel] || (slots[sel] = { kinds: [] });
          if (c.kind === 'attr') {
            var attr = c.attr.trim();
            var value = c.value.trim();
            if (!/^data-[a-z][a-z0-9-]*$/.test(attr)) errs.push(where + 'the attribute must start with data- (lower case).');
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) errs.push(where + 'the value must be plain letters or digits.');
            if (slot.kinds.indexOf('attr') < 0) { slot.kinds.push('attr'); slot.attrs = {}; }
            slot.attrs[attr] = slot.attrs[attr] || [];
            if (slot.attrs[attr].indexOf(value) < 0) slot.attrs[attr].push(value);
            changes.push({ selector: sel, kind: 'attr', attr: attr, value: value });
          } else {
            var text = c.text.replace(/\r/g, '');
            var hex = /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/;
            if (!text.trim()) errs.push(where + 'write the new text.');
            if (!hex.test(c.color.trim()) || !hex.test(c.bg.trim())) errs.push(where + 'give the text colour and background as hex colours, like #FFFFFF.');
            if (!(Number(c.size) > 0)) errs.push(where + 'give the text size in px.');
            if (slot.kinds.indexOf('text') < 0) slot.kinds.push('text');
            slot.maxChars = Math.max(slot.maxChars || 0, text.length + 20);
            changes.push({ selector: sel, kind: 'text', text: text, context: { color: c.color.trim(), background: c.bg.trim(), fontSizePx: Number(c.size), bold: !!c.bold } });
          }
        });
        if (!changes.length) errs.push('Version ' + (vi + 1) + ' needs at least one change.');
        variants[vid] = { label: label, changes: changes };
      });

      var body = {
        id: id,
        name: name,
        allowedOrigins: origins,
        target: { path: path, match: f.match },
        goal: goal,
        policy: {
          slots: slots,
          neverChange: listOf(f.neverChange),
          facts: { numbers: listOf(f.numbers), claims: listOf(f.claims) },
          brand: { colors: [], fonts: [], minFontPx: 12, maxFontPx: 200, forbiddenWords: listOf(f.forbidden) },
        },
        variants: variants,
        config: { canaryShare: Math.round(share) / 100 },
      };
      if (f.hide.trim()) body.hide = f.hide.trim();
      return { body: body, errors: errs };
    }

    function submit(body, button) {
      clear(serverErrors);
      button.disabled = true;
      api('POST', 'experiments', body).then(function (res) {
        button.disabled = false;
        if (my !== gen) return;
        if (res.status === 201) { location.hash = '#/test/' + res.data.id + '?new=1'; return; }
        var list = res.data && res.data.errors ? res.data.errors : [res.status === 409 ? 'A test with this id already exists. Change the test id.' : 'The server answered ' + res.status + '.'];
        serverErrors.appendChild(h('div', { class: 'note note--warn', role: 'alert' },
          h('strong', null, res.status === 422 ? 'The safety checks did not accept this test' : 'The test was not created'),
          h('ul', null, list.map(function (m) { return h('li', null, m); })),
          res.status === 422 ? h('p', { class: 'small', style: 'margin:8px 0 0' }, 'Numbers and claims in new text must be listed under “Facts the new text may mention” in step 5.') : null));
        serverErrors.scrollIntoView({ block: 'center' });
      }).catch(function () {
        button.disabled = false;
        serverErrors.appendChild(h('div', { class: 'note note--warn', role: 'alert' }, 'Could not reach the server.'));
      });
    }

    // ---- the screen
    var create = h('button', { type: 'button', class: 'btn btn--redsolid' }, 'Create test');
    create.addEventListener('click', function () {
      clear(problems);
      var r = build();
      if (r.errors.length) {
        problems.appendChild(h('div', { class: 'note note--warn', role: 'alert' }, h('strong', null, 'Not yet'), h('ul', null, r.errors.map(function (m) { return h('li', null, m); }))));
        problems.scrollIntoView({ block: 'center' });
        return;
      }
      submit(r.body, create);
    });

    var pasteArea = h('textarea', { class: 'mono', rows: 8, 'aria-label': 'Experiment file', placeholder: '{ "id": "exp_…", "name": "…", … }' });
    var pasteGo = h('button', { type: 'button', class: 'btn btn--small' }, 'Create from this file');
    var pasteErr = h('p', { class: 'err', role: 'alert' });
    pasteGo.addEventListener('click', function () {
      pasteErr.textContent = '';
      var parsed;
      try { parsed = JSON.parse(pasteArea.value); } catch (e) { pasteErr.textContent = 'That is not valid JSON: ' + e.message; return; }
      submit(parsed, pasteGo);
    });

    function step(n, title, help, content) {
      return h('section', { class: 'step' },
        h('div', null, h('div', { class: 'step__n' }, String(n)), h('h2', { class: 'step__t' }, title), h('p', { class: 'step__h' }, help)),
        h('div', { class: 'stack' }, content));
    }

    var matchSel = h('select', { id: 'f_match', 'aria-label': 'Which pages' }, h('option', { value: 'exact' }, 'Only this page'), h('option', { value: 'prefix' }, 'This page and everything below it'));
    matchSel.addEventListener('change', function () { f.match = matchSel.value; });

    var goalClick = h('input', { type: 'radio', name: 'goal', id: 'goal_click', checked: true });
    var goalView = h('input', { type: 'radio', name: 'goal', id: 'goal_view' });
    var goalSel = bound('Selector of the button or link', 'goalSelector', { mono: true, placeholder: '.hero__actions .btn', hint: 'You can list several, separated by commas.' });
    var goalPathField = bound('Page that counts', 'goalPath', { mono: true, placeholder: '/thank-you' });
    goalPathField.hidden = true;
    function goalChanged() {
      f.goalType = goalView.checked ? 'pageview' : 'click';
      goalSel.hidden = f.goalType !== 'click';
      goalPathField.hidden = f.goalType !== 'pageview';
    }
    goalClick.addEventListener('change', goalChanged);
    goalView.addEventListener('change', goalChanged);

    var node = h('div', { class: 'page' },
      h('h1', null, 'New test'),
      h('p', { class: 'lead' }, 'Say where, what counts as success, and what to try. Hone shows each new version to some visitors, counts what they do, and can stop a version that does harm.'),
      h('details', { class: 'paste' },
        h('summary', null, 'I already have an experiment file'),
        h('div', { class: 'stack' }, h('p', { class: 'small muted', style: 'margin:0' }, 'Paste the file’s contents. It goes through the same safety checks.'), pasteArea, pasteErr, h('div', null, pasteGo))),
      h('div', { class: 'steps' },
        step(1, 'Test', 'What you call it, where it runs, and which page.', [
          bound('Test name', 'name', { placeholder: 'Hero A vs Hero B' }),
          bound('Site addresses', 'origins', { area: true, rows: 2, mono: true, placeholder: 'https://www.example.com', hint: 'One per line. Only these sites may use the test. Add http://localhost:4000 to try it on your own computer.' }),
          h('div', { class: 'row' }, bound('Page (/ is the home page)', 'path', { mono: true }), h('div', { class: 'field' }, h('label', { for: 'f_match' }, 'Which pages'), matchSel)),
        ]),
        step(2, 'Install', 'One line in the head of the page. Add it after you create the test.', [
          bound('Test id', 'id', { mono: true, hint: 'Made from the name. It goes into the line below.' }),
          bound('Hide while it decides', 'hide', { mono: true, placeholder: '.hero,.story-hero', hint: 'Selectors to hold back for a moment (0.7 seconds at most) so visitors never see one version flash into another. Optional.' }),
          tagBox,
          h('p', { class: 'hint', style: 'margin:0' }, 'Put it in the head, before your other scripts. Leave out async and defer, so the hiding starts before the first paint.'),
        ]),
        step(3, 'Goal', 'What counts as success.', [
          h('div', { class: 'seg' },
            h('label', { class: 'check', for: 'goal_click' }, goalClick, 'Someone clicks a button or link'),
            h('label', { class: 'check', for: 'goal_view' }, goalView, 'Someone reaches a page')),
          goalSel, goalPathField,
        ]),
        step(4, 'Versions', 'What to try. The original is always included.', [variantsBox]),
        step(5, 'Rules', 'Set once. Hone can read these but never change them.', [
          bound('Never touch anything whose selector contains', 'neverChange', { mono: true, hint: 'Words, separated by commas. Prices, legal and consent text are safe by default.' }),
          bound('Facts the new text may mention: numbers', 'numbers', { mono: true, placeholder: '19,500, 3 MacBook', hint: 'Until you list a number, no new text can contain it. Separated by commas.' }),
          bound('Facts the new text may mention: claims', 'claims', { mono: true, placeholder: 'free, thousands of learners', hint: 'Words like free, certified, best need to be listed too.' }),
          bound('Words the brand avoids', 'forbidden', { mono: true, hint: 'Optional.' }),
        ]),
        step(6, 'Traffic', 'How many visitors get each new version at the start.', [
          bound('Share for each new version (1% to 50%)', 'share', { type: 'number', min: '1', max: '50', hint: 'With one new version, 50 splits visitors evenly. Start small (5 to 10) when a version could be wrong; use 50 when both versions are your own finished designs.' }),
        ])),
      serverErrors,
      problems,
      h('div', { class: 'footer' },
        h('p', { class: 'small muted', style: 'margin:0;max-width:560px' }, 'Creating a test does not change your site. A test cannot be edited afterwards: to change something, create a new one with a new id.'),
        h('div', { style: 'display:flex;gap:12px;align-items:center' }, h('a', { class: 'btn', href: '#/' }, 'Cancel'), create)));

    show(node);
    drawVariants();
    refreshTag();
    function stale() { clear(problems); clear(serverErrors); }
    node.addEventListener('input', stale);
    node.addEventListener('change', stale);
  }

  // ------------------------------------------------------------------ routing

  function route() {
    if (!getToken()) return renderSignIn();
    nav.hidden = false;
    var parts = (location.hash.replace(/^#/, '') || '/').split('?');
    var path = parts[0];
    var fresh = /(^|&)new=1(&|$)/.test(parts[1] || '');
    Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) {
      var on = (a.getAttribute('data-nav') === 'new' && path === '/new') || (a.getAttribute('data-nav') === 'activity' && path !== '/new');
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (path === '/' || path === '') return renderActivity();
    if (path === '/new') return renderNew();
    var m = path.match(/^\/test\/([A-Za-z0-9_-]{3,64})$/);
    if (m) return renderTest(m[1], fresh);
    location.hash = '#/';
  }

  document.getElementById('signout').addEventListener('click', function () { signOut(''); });
  window.addEventListener('hashchange', route);
  route();
})();

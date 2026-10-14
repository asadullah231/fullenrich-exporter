// FE Export — content script (isolated world) for app.fullenrich.com/app/search/people.
//
// Jobs:
//   1. Keep the last few SearchContacts captures that main-world.js hands over
//      (raw bytes, base64) in chrome.storage.local for the debug file.
//   2. Read the people table and, on request, each row's side panel (full
//      employment history, education, skills, languages).
//   3. Queue mode (v0.2): a HeyReach CSV is loaded in the popup; for every candidate
//      the "Person Name" filter is set to the name, the results are scanned for the
//      row whose LinkedIn link matches the CSV URL, that row's panel is read, and the
//      result is saved to chrome.storage.local (resume-safe). The queue keeps running
//      while the popup is closed, as long as this tab stays on the search page.
//
// Read only: the only things clicked are filter controls, table rows, "Show N more",
// section headers and the pager. Never any "Enrich" / "Find" / "Add to list" button.
//
// Selectors come from the 08 Oct 2026 recon. Table body cells have no data-*
// attributes; columns are mapped by the inline `order:` value (1 name, 2 jobTitle,
// 3 company, 4 location, 5 companyHeadcount, 6 companyIndustry). The filter panel
// was not in the recon, so that part is label-driven and dumps the panel HTML into
// the debug log the first time it cannot find what it needs.
(() => {
  if (window.__feExportContentReady) return;
  window.__feExportContentReady = true;

  const log = [];
  let logTimer = null;
  const flushLog = () => { logTimer = null; try { chrome.storage.local.set({ logTail: log.slice(-1500) }); } catch (e) { /* ignore */ } };
  const dbg = (line) => { log.push(new Date().toISOString().slice(11, 19) + ' ' + line); if (log.length > 3000) log.shift(); if (!logTimer) logTimer = setTimeout(flushLog, 1500); };
  let cancelled = false;
  let queueRunning = false;

  // ---- captures from main-world.js -------------------------------------------------
  document.addEventListener('feexport:capture', (ev) => {
    let p = null; try { p = JSON.parse(ev.detail); } catch (e) { return; }
    if (queueRunning) { delete p.reqB64; delete p.resB64; p.rawSkipped = 'list running'; }
    chrome.storage.local.get({ captures: [] }, (st) => {
      const caps = st.captures || [];
      caps.push(p);
      while (caps.length > 3) caps.shift();
      if (p.resB64) { while (caps.length > 1 && JSON.stringify(caps).length > 12e6) caps.shift(); }
      chrome.storage.local.set({ captures: caps });
    });
    if (p.error && /aborted/i.test(p.error)) abortedSeen++; else dbg('capture ' + p.url + ' ' + (p.resBytes || 0) + ' bytes' + (p.error ? ' ERROR ' + p.error : ''));
  });

  // ---- decoded contacts from the page's own search responses (main-world.js) -------
  // Every SearchContacts response the page receives is decoded there and handed over here.
  // It carries the full profile of each row (history with dates and role descriptions,
  // skills, languages, education, company data), more than the side panel shows.
  const contactsBySlug = new Map();
  let contactsSeen = 0;
  const slugKey = (u) => { const m = String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').match(/linkedin\.com\/in\/([^/]+)/); return m ? decodeURIComponent(m[1]) : ''; };
  document.addEventListener('feexport:contacts', (ev) => {
    let p = null; try { p = JSON.parse(ev.detail); } catch (e) { return; }
    for (const c of (p.contacts || [])) {
      const k = (c.social_profiles && c.social_profiles.professional_network && (c.social_profiles.professional_network.slug || slugKey(c.social_profiles.professional_network.url))) || '';
      if (k) contactsBySlug.set(k.toLowerCase(), c);
      contactsSeen++;
    }
    if (contactsBySlug.size > 3000) { const keys = Array.from(contactsBySlug.keys()).slice(0, 1000); keys.forEach((k) => contactsBySlug.delete(k)); }
    responsesSeen++;
    if (p.errors) dbg('search response: ' + p.errors + ' frame(s) failed to decode');
  });
  let responsesSeen = 0;
  // rate limit: set by the fetch hook (429 / grpc message) or by FullEnrich's toast; the batch loop waits and retries
  let rateLimitHits = 0, rateLimitedAt = 0, chipGap = 700, cleanBatches = 0, abortedSeen = 0;
  const GAP_MIN = 400, GAP_MAX = 2000;
  const noteRateLimit = (src) => { rateLimitHits++; rateLimitedAt = Date.now(); dbg('RATE LIMIT (' + src + '), hit #' + rateLimitHits); setPhase('FullEnrich rate limit (hit ' + rateLimitHits + ')'); };
  document.addEventListener('feexport:ratelimit', (ev) => { let p = null; try { p = JSON.parse(ev.detail); } catch (e) { p = {}; } noteRateLimit('response ' + (p.status || '') + ' ' + (p.message || '')); });
  // ---- direct search: main-world.js replays the page's own search request with other names (see the note there) ----
  let directReady = false, directInfo = null, lastDirectAt = 0, directGap = 1500, searchSeq = 0;
  const searchWaiters = new Map();
  document.addEventListener('feexport:template', (ev) => { let p = null; try { p = JSON.parse(ev.detail); } catch (e) { return; } directReady = !!p.ok; directInfo = p; dbg(p.ok ? 'direct search ready (name field ' + p.nameField + (p.companyField ? ', company field ' + p.companyField : '') + ', page size ' + p.pageSize + ', exact flag bytes ' + p.exactBytes + ')' : 'direct search template dropped'); });
  document.addEventListener('feexport:searchresult', (ev) => { let p = null; try { p = JSON.parse(ev.detail); } catch (e) { return; } const w = searchWaiters.get(p.id); if (w) { searchWaiters.delete(p.id); w(p); } });
  const tellNames = (names, companies) => { try { document.dispatchEvent(new CustomEvent('feexport:names', { detail: JSON.stringify({ names: names || [], companies: companies || [] }) })); } catch (e) { /* ignore */ } };
  // one search, paced like a person: at most one every directGap ms; resolves with the decoded result or { ok:false, error }
  const directSearch = async (names, exact) => {
    const wait = directGap - (Date.now() - lastDirectAt); if (wait > 0) await sleep(wait);
    const id = ++searchSeq; lastDirectAt = Date.now(); lastRequestAt = Date.now();
    const result = new Promise((resolve) => searchWaiters.set(id, resolve));
    try { document.dispatchEvent(new CustomEvent('feexport:search', { detail: JSON.stringify({ id, names, exact: exact !== false }) })); } catch (e) { searchWaiters.delete(id); return { ok: false, error: String(e && e.message || e) }; }
    const r = await Promise.race([result, sleep(45000).then(() => ({ ok: false, error: 'timeout' }))]);
    searchWaiters.delete(id);
    return r;
  };
  document.addEventListener('visibilitychange', () => dbg('tab ' + document.visibilityState + (queueRunning ? ' while running' : '')));
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && /rate limit exceeded/i.test(n.textContent || '') && (n.textContent || '').length < 300 && Date.now() - rateLimitedAt > 2000) { noteRateLimit('toast'); return; }
    }
  }).observe(document.body, { childList: true, subtree: true });
  const contactFor = (url) => { const k = slugKey(url).toLowerCase(); return k ? contactsBySlug.get(k) || null : null; };
  const profileFromContact = (c, row) => Object.assign({}, c, {
    description: c.description || '',
    social_profiles: { professional_network: { url: (c.social_profiles && c.social_profiles.professional_network.url) || (row && row.linkedinUrl) || '' } },
    current_company_lines: [], collected_at: new Date().toISOString(), source: 'fe-export/0.6.0 search-response',
  });
  const rowFromContact = (c) => { const cur = (c.employment && c.employment.current) || {}; const co = cur.company || {}; return { name: c.full_name, linkedinUrl: c.social_profiles.professional_network.url, jobTitle: cur.title || c.headline, company: co.name || '', companyLinkedinUrl: co.linkedin_url || '', companyWebsite: co.domain ? 'https://' + co.domain : '', location: c.location.raw, companyHeadcount: co.headcount != null ? String(co.headcount) : '', companyIndustry: (co.industry && co.industry.main_industry) || '' }; };

  // ---- helpers ----------------------------------------------------------------------
  // Waits that keep working while the tab is in the background (Chrome throttles page timers there):
  //  - sleep() asks the service worker to answer after N ms; the worker's timers are not throttled
  //  - waitFor() reacts to DOM mutations through a MutationObserver and only uses the worker for its deadline
  const bgSleep = (ms) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { chrome.runtime.sendMessage({ type: 'sleep', ms }, () => { void chrome.runtime.lastError; finish(); }); } catch (e) { finish(); }
    setTimeout(finish, ms + 65000); // page-timer fallback only if the worker never answers (a throttled page timer may take a minute)
  });
  // every wait goes through the service worker, even 30 ms ones: a hidden tab's own timers run once per minute after
  // five minutes in the background (Chrome's intensive throttling), which is exactly the "it stops when I switch tabs" symptom
  const sleep = async (ms) => {
    ms = Math.max(0, Number(ms) || 0);
    while (ms > 0) { const part = Math.min(ms, 20000); await bgSleep(part); ms -= part; }
  };
  // a long wait that stops early when the user presses Pause and keeps the popup informed
  const pause = async (ms, label) => {
    const t0 = Date.now();
    while (!cancelled && Date.now() - t0 < ms) {
      const left = Math.ceil((ms - (Date.now() - t0)) / 1000);
      if (label) setPhase(label + ' · ' + left + ' s');
      await sleep(Math.min(1000, ms - (Date.now() - t0)));
    }
  };
  // live status for the popup: small record, written at most twice a second (the full queue is big and is saved per batch)
  let phaseTimer = null, phaseLast = '';
  // ---- in-page status pill: live counts + Pause / Resume without opening the popup --------------
  let pill = null, lastOpts = null;
  const pillCounts = (q) => { const n = q.items.length, done = q.items.filter((i) => i.status === 'done').length, nf = q.items.filter((i) => i.status === 'not_found' || i.status === 'error').length; return { n, done, nf, pend: n - done - nf }; };
  const ensurePill = () => {
    if (pill && pill.host.isConnected) return pill;
    const host = document.createElement('div'); host.id = 'feexport-pill'; host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483646;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `<style>
      .p{font-family:"Inter",-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;font-size:12.5px;line-height:1.3;color:#0A0A0A;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:9999px;box-shadow:0 6px 20px rgba(10,10,10,.12);padding:8px 10px 8px 12px;display:flex;align-items:center;gap:10px;letter-spacing:-0.006em;user-select:none;max-width:460px}
      .dot{width:8px;height:8px;border-radius:50%;background:#9CA3AF;flex:0 0 auto}.dot.run{background:#1CA7FD;box-shadow:0 0 0 4px rgba(28,167,253,.18)}.dot.done{background:#16A34A}.dot.warn{background:#F59E0B}
      .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.t b{font-weight:600}.sub{color:#6B7280;margin-left:6px}
      button{all:unset;cursor:pointer;font:inherit;font-weight:500;color:#148CFC;background:#DEF2FE;border-radius:9999px;padding:4px 10px;flex:0 0 auto}button:hover{background:#BFE6FD}button.x{background:transparent;color:#6B7280;padding:4px 6px}
    </style><div class="p"><span class="dot"></span><span class="t"></span><button class="act" hidden></button><button class="x" title="Hide">x</button></div>`;
    document.documentElement.appendChild(host);
    pill = { host, dot: sh.querySelector('.dot'), t: sh.querySelector('.t'), act: sh.querySelector('.act'), x: sh.querySelector('.x') };
    pill.x.addEventListener('click', () => { host.remove(); pill = null; pillHidden = true; });
    pill.act.addEventListener('click', () => {
      if (queueRunning) { cancelled = true; setPhase('Pausing'); }
      else if (lastOpts) runQueue(lastOpts);
    });
    return pill;
  };
  let pillHidden = false;
  const renderPill = async () => {
    if (pillHidden) return;
    const q = await loadQueue();
    if (!q || !q.items) { if (pill) { pill.host.remove(); pill = null; } return; }
    const p = ensurePill(); const k = pillCounts(q);
    const state = queueRunning ? 'Running' : (q.state === 'finished' ? 'Finished' : (k.done || k.nf ? 'Paused' : 'Ready'));
    p.dot.className = 'dot ' + (queueRunning ? 'run' : (q.state === 'finished' ? 'done' : (rateLimitHits && queueRunning ? 'warn' : '')));
    p.t.innerHTML = '<b>FE Export</b> ' + state + (queueRunning && directReady ? ' (background ok)' : '') + ' · ' + k.done + ' found' + (k.nf ? ' · ' + k.nf + ' missing' : '') + (k.pend ? ' · ' + k.pend + ' left' : '') + ' / ' + k.n + (queueRunning && phaseLast ? '<span class="sub">' + phaseLast.replace(/</g, '&lt;') + '</span>' : '');
    p.act.hidden = !(queueRunning || (k.pend && lastOpts));
    p.act.textContent = queueRunning ? 'Pause' : 'Resume';
  };
  const setPhase = (text) => {
    phaseLast = text;
    renderPill().catch(() => {});
    if (phaseTimer) return;
    phaseTimer = setTimeout(() => { phaseTimer = null; try { chrome.storage.local.set({ queueStatus: { phase: phaseLast, at: Date.now(), rateLimitHits, chipGap } }); } catch (e) { /* ignore */ } }, 400);
  };
  const txt = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const attrTitle = (el) => (el ? String(el.getAttribute('title') || '').trim() : '');
  const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const slugOf = (u) => { const m = normUrl(u).match(/linkedin\.com\/in\/([^/]+)/); return m ? decodeURIComponent(m[1]) : ''; };
  const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(dr|prof|mba|phd|msc|bsc|ing|dipl)\b\.?/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const waitFor = (fn, ms = 4000, step = 100) => new Promise((resolve) => {
    const check = () => { try { return fn(); } catch (e) { return null; } };
    const first = check(); if (first) { resolve(first); return; }
    let settled = false; const t0 = Date.now();
    const obs = new MutationObserver(() => { if (settled) return; const v = check(); if (v) { settled = true; obs.disconnect(); resolve(v); } });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const tick = async () => {
      while (!settled) {
        await sleep(Math.max(step, 250));
        if (settled) return;
        const v = check(); if (v) { settled = true; obs.disconnect(); resolve(v); return; }
        if (Date.now() - t0 >= ms) { settled = true; obs.disconnect(); resolve(null); return; }
      }
    };
    tick();
  });
  const isVisible = (el) => !!(el && el.getClientRects().length);

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const parseRange = (s) => {
    const parts = String(s || '').split(/\s*[-–]\s*/);
    const one = (p) => {
      if (!p) return null; p = p.trim();
      if (/^(today|present|now|current)$/i.test(p)) return 'present';
      const m = p.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/); if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? m[2] + '-' + String(mo).padStart(2, '0') + '-01' : m[2] + '-01-01'; }
      const y = p.match(/^(\d{4})$/); if (y) return y[1] + '-01-01';
      const iso = p.match(/^(\d{4})-(\d{2})/); if (iso) return iso[1] + '-' + iso[2] + '-01';
      return null;
    };
    const a = one(parts[0]), b = one(parts[1]);
    return { start_at: a === 'present' ? null : a, end_at: b === 'present' ? null : b, is_current: b === 'present' };
  };

  // ---- table rows -------------------------------------------------------------------
  const table = () => document.querySelector('#people-tabpanel table') || document.querySelector('table');
  const rowEls = () => Array.from((table() || document).querySelectorAll('tbody tr'));
  const cellByOrder = (tr, n) => Array.from(tr.querySelectorAll('td')).find((td) => String(td.style.order) === String(n)) || null;
  const busy = () => { const tb = document.querySelector('tbody'); return !!(tb && tb.getAttribute('aria-busy') === 'true'); };

  const readRow = (tr) => {
    const c1 = cellByOrder(tr, 1), c2 = cellByOrder(tr, 2), c3 = cellByOrder(tr, 3), c4 = cellByOrder(tr, 4), c5 = cellByOrder(tr, 5), c6 = cellByOrder(tr, 6);
    const nameEl = c1 && (c1.querySelector('span[title]') || c1.querySelector('span'));
    const cb = tr.querySelector('input[type="checkbox"][aria-label^="Select "]');
    const name = attrTitle(nameEl) || txt(nameEl) || (cb ? cb.getAttribute('aria-label').replace(/^Select\s+/, '') : '');
    const li = tr.querySelector('a[href*="linkedin.com/in/"]');
    const coLi = c3 && c3.querySelector('a[href*="linkedin.com/company/"]');
    const site = c3 && Array.from(c3.querySelectorAll('a[href]')).find((a) => !/linkedin\.com/i.test(a.href));
    const row = {
      name, linkedinUrl: li ? li.href : '',
      jobTitle: c2 ? (attrTitle(c2.querySelector('[title]')) || txt(c2)) : '',
      company: c3 ? (attrTitle(c3.querySelector('span[title]')) || txt(c3.querySelector('span'))) : '',
      companyLinkedinUrl: coLi ? coLi.href : '', companyWebsite: site ? site.href : '',
      location: c4 ? (attrTitle(c4.querySelector('[title]')) || txt(c4)) : '',
      companyHeadcount: c5 ? (attrTitle(c5.querySelector('[title]')) || txt(c5)) : '',
      companyIndustry: c6 ? (attrTitle(c6.querySelector('[title]')) || txt(c6)) : '',
    };
    if (!row.name || !row.linkedinUrl) dbg('row missing ' + (!row.name ? 'name ' : '') + (!row.linkedinUrl ? 'linkedinUrl ' : '') + '| cells=' + tr.querySelectorAll('td').length + ' | text=' + txt(tr).slice(0, 120));
    return row;
  };

  const counterText = () => Array.from(document.querySelectorAll('span,div,p')).map(txt).find((t) => /^[\d,.]+ (people|person)$/.test(t) || /^\d+ selected \/ /.test(t)) || '';
  const pageInfo = () => { const cur = document.querySelector('[aria-current="page"]'); return { page: cur ? txt(cur) : '', counter: counterText(), rows: rowEls().length, onSearch: /\/app\/search\/people/.test(location.pathname) }; };

  // ---- side panel -------------------------------------------------------------------
  const findPanel = (name) => {
    const h1s = Array.from(document.querySelectorAll('h1')).filter(isVisible);
    const h1 = h1s.find((h) => txt(h) === name) || h1s.find((h) => name && normName(txt(h)) === normName(name)) || null;
    if (!h1) return null;
    let el = h1, best = null;
    while (el && el !== document.body) { if (el.querySelector('button.section-trigger')) return el; if (!best && /\bPrevious\b/.test(el.textContent || '') && /\bNext\b/.test(el.textContent || '')) best = el; el = el.parentElement; }
    return best || h1.parentElement;
  };
  const sectionList = (panel, label) => {
    const btn = Array.from(panel.querySelectorAll('button.section-trigger')).find((b) => txt(b).toLowerCase().includes(label.toLowerCase()));
    if (!btn) return { btn: null, ul: null };
    let ul = btn.nextElementSibling;
    while (ul && ul.tagName !== 'UL') ul = ul.nextElementSibling;
    if (!ul) { const wrap = btn.parentElement; ul = wrap ? wrap.querySelector('ul') : null; }
    return { btn, ul };
  };
  const expandSection = async (panel, label) => {
    let s = sectionList(panel, label);
    if (!s.btn) { dbg('section not found: ' + label); return null; }
    if (s.btn.getAttribute('aria-expanded') === 'false') { s.btn.click(); await waitFor(() => sectionList(panel, label).ul, 2000); s = sectionList(panel, label); }
    if (!s.ul) { dbg('section has no list: ' + label); return null; }
    for (let i = 0; i < 5; i++) {
      const more = Array.from(s.ul.querySelectorAll('button')).find((b) => /^show\s+\d+\s+more/i.test(txt(b)));
      if (!more) break;
      const before = s.ul.querySelectorAll('li').length;
      more.click();
      await waitFor(() => s.ul.querySelectorAll('li').length > before, 2500);
    }
    return s.ul;
  };
  const readEmployment = (ul) => Array.from(ul.querySelectorAll('li')).map((li) => {
    const title = txt(li.querySelector('h4'));
    const coEl = li.querySelector('.company-name') || li.querySelector('[title]');
    const company = attrTitle(coEl) || txt(coEl);
    const spans = Array.from(li.querySelectorAll('span')).map(txt);
    const when = spans.find((t) => /\d{4}/.test(t) && /[-–]/.test(t)) || spans.find((t) => /\d{4}/.test(t)) || '';
    const current = spans.some((t) => /^current$/i.test(t)) || /today|present/i.test(when);
    if (!title && !company) return null;
    const r = parseRange(when);
    return { title, company: { name: company }, start_at: r.start_at, end_at: r.end_at, is_current: current || r.is_current, when_text: when, description: '' };
  }).filter(Boolean);
  const readEducation = (ul) => Array.from(ul.querySelectorAll('li')).map((li) => {
    const degree = txt(li.querySelector('h4'));
    const spans = Array.from(li.querySelectorAll('span')).map(txt).filter(Boolean);
    const years = spans.find((t) => /^\d{4}(\s*[-–]\s*(\d{4}|today|present))?$/i.test(t)) || '';
    const school = spans.find((t) => t !== years && t !== degree && t.length > 2) || '';
    if (!degree && !school) return null;
    const r = parseRange(years);
    return { degree, school_name: school, start_at: r.start_at, end_at: r.end_at, when_text: years };
  }).filter(Boolean);
  // Languages and skills are chip rows introduced by a material icon (panel text reads "translate english german"),
  // not by a text label. Find the icon, then collect the short texts in its row container.
  const ICONS = { Languages: ['translate', 'language'], Skills: ['psychology', 'lightbulb', 'star', 'build', 'handyman', 'school', 'verified', 'bolt'] };
  const readChips = (panel, label) => {
    const icons = Array.from(panel.querySelectorAll('span.material-icons, span.material-icons-round, span.material-icons-outlined')).filter((e) => (ICONS[label] || []).includes(txt(e).toLowerCase()));
    let lab = icons[0] || Array.from(panel.querySelectorAll('p,span,h3,h4,div')).find((e) => txt(e).toLowerCase() === label.toLowerCase() && e.children.length === 0);
    if (!lab) { dbg('chip anchor not found: ' + label); return []; }
    let box = lab.parentElement, tries = 0;
    while (box && tries < 4) {
      const chips = Array.from(box.querySelectorAll('span')).filter((e) => e !== lab && !/material-icons/.test(e.className)).map(txt).filter((t) => t && t.length <= 60 && !/^\+\d+$/.test(t) && !/^(translate|language|psychology|lightbulb|star|build|handyman|school|verified|bolt)$/i.test(t));
      const uniq = Array.from(new Set(chips));
      if (uniq.length >= 1 && uniq.length < 400) return uniq;
      box = box.parentElement; tries++;
    }
    return [];
  };
  const readHeader = (panel, row) => {
    const h1 = panel.querySelector('h1');
    const li = Array.from(panel.querySelectorAll('a[href*="linkedin.com/in/"]'))[0];
    const ps = Array.from(panel.querySelectorAll('p')).map(txt).filter(Boolean);
    const location = ps.find((t) => t.split(',').length >= 2 && t.length < 120 && !/\d{4}/.test(t)) || row.location;
    return { full_name: txt(h1) || row.name, linkedinUrl: li ? li.href : row.linkedinUrl, location };
  };
  const readCurrentCompany = (ul) => {
    const lines = Array.from(ul.querySelectorAll('li, p, span, div')).map(txt).filter((t) => t && t.length < 200);
    const uniq = Array.from(new Set(lines));
    const pick = (re) => { const i = uniq.findIndex((t) => re.test(t)); return i >= 0 ? (uniq[i + 1] || '') : ''; };
    return { lines: uniq.slice(0, 40), headcount: pick(/^(headcount|employees|company size|size)$/i), industry: pick(/^industry$/i), website: (ul.querySelector('a[href]:not([href*="linkedin.com"])') || {}).href || '', founded: pick(/^founded/i), hq: pick(/^(headquarters|hq)$/i) };
  };
  const readPanelFor = async (tr, row) => {
    tr.click();
    const panel = await waitFor(() => findPanel(row.name), 5000);
    if (!panel) { dbg('panel did not open for ' + row.name); return null; }
    await waitFor(() => panel.querySelector('button.section-trigger'), 3000, 100);
    dumpOnce('sidepanel', panel, panel.querySelector('button.section-trigger') ? 'first panel' : 'no section-trigger after 3 s');
    await sleep(150);
    const header = readHeader(panel, row);
    const langs = readChips(panel, 'Languages');
    const skills = readChips(panel, 'Skills');
    const empUl = await expandSection(panel, 'Employment history');
    const eduUl = await expandSection(panel, 'Education');
    const curUl = await expandSection(panel, 'Current company');
    const employment = empUl ? readEmployment(empUl) : [];
    const educations = eduUl ? readEducation(eduUl) : [];
    const current = curUl ? readCurrentCompany(curUl) : null;
    if (!employment.length) dbg('no employment items for ' + row.name + ' | panel text=' + txt(panel).slice(0, 200));
    return { header, languages: langs, skills, employment, educations, currentCompany: current };
  };
  const closePanel = () => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === 'Close' || /^close$/i.test(txt(x))); if (b && isVisible(b)) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); };

  // ---- FullEnrich-shaped profile ----------------------------------------------------
  const hostOf = (u) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch (e) { return ''; } };
  const numOr = (s) => { const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };
  const CC = { germany: 'DE', deutschland: 'DE', switzerland: 'CH', austria: 'AT', 'united kingdom': 'GB', uk: 'GB', england: 'GB', scotland: 'GB', 'united states': 'US', usa: 'US', france: 'FR', netherlands: 'NL', belgium: 'BE', spain: 'ES', italy: 'IT', poland: 'PL', sweden: 'SE', denmark: 'DK', norway: 'NO', finland: 'FI', ireland: 'IE', portugal: 'PT', 'czech republic': 'CZ', czechia: 'CZ', hungary: 'HU', romania: 'RO', luxembourg: 'LU', india: 'IN', 'united arab emirates': 'AE', australia: 'AU', canada: 'CA', turkey: 'TR', türkiye: 'TR', greece: 'GR', liechtenstein: 'LI' };
  const countryCode = (c) => CC[String(c || '').toLowerCase()] || '';
  const toProfile = (row, p) => {
    const loc = (p && p.header.location) || row.location || '';
    const parts = loc.split(',').map((s) => s.trim()).filter(Boolean);
    const CONT = /^(europe|asia|africa|north america|south america|oceania|antarctica)$/i;
    const core = parts.filter((x) => !CONT.test(x));
    const known = core.find((x) => CC[x.toLowerCase()]);
    const country = known || (core.length >= 3 ? core[2] : (core[core.length - 1] || ''));
    const city = core[0] || '';
    const region = core.length >= 3 ? core[1] : '';
    const all = (p && p.employment) || [];
    const cur = all.find((e) => e.is_current) || all[0] || null;
    const curCompany = { name: (cur && cur.company.name) || row.company, domain: hostOf(row.companyWebsite || (p && p.currentCompany && p.currentCompany.website) || ''), industry: row.companyIndustry || (p && p.currentCompany && p.currentCompany.industry) || '', headcount: numOr(row.companyHeadcount || (p && p.currentCompany && p.currentCompany.headcount) || ''), linkedin_url: row.companyLinkedinUrl };
    return {
      full_name: (p && p.header.full_name) || row.name, headline: row.jobTitle, description: '',
      location: { city, region, country, country_code: countryCode(country), raw: loc },
      employment: { current: cur ? { title: cur.title || row.jobTitle, company: curCompany, start_at: cur.start_at, is_current: true, seniority: '' } : { title: row.jobTitle, company: curCompany, start_at: null, is_current: true, seniority: '' }, all: all.map((e) => ({ title: e.title, company: e.company.name === curCompany.name ? Object.assign({}, curCompany) : e.company, start_at: e.start_at, end_at: e.end_at, is_current: e.is_current, description: e.description || '', when_text: e.when_text })) },
      educations: (p && p.educations) || [], languages: ((p && p.languages) || []).map((l) => ({ language: l, proficiency: '' })), skills: (p && p.skills) || [],
      social_profiles: { professional_network: { url: (p && p.header.linkedinUrl) || row.linkedinUrl } },
      current_company_lines: p && p.currentCompany ? p.currentCompany.lines : [],
      collected_at: new Date().toISOString(), source: 'fe-export/0.3.2',
    };
  };

  // ---- pager ------------------------------------------------------------------------
  const nextPage = async () => {
    const cur = document.querySelector('[aria-current="page"]');
    if (!cur) return false;
    const firstName = rowEls()[0] ? readRow(rowEls()[0]).name : '';
    let nxt = cur.nextElementSibling;
    while (nxt && !/^\d+$/.test(txt(nxt))) nxt = nxt.nextElementSibling;
    if (!nxt) return false;
    nxt.click();
    const ok = await waitFor(() => { const r = rowEls()[0]; return r && readRow(r).name !== firstName && !busy(); }, 15000, 200);
    await sleep(400);
    return !!ok;
  };

  // ---- export current search (v0.1) --------------------------------------------------
  const run = async (opts, send) => {
    cancelled = false;
    const out = []; let page = 0; const seen = new Set();
    while (!cancelled) {
      page++;
      const trs = rowEls();
      if (!trs.length) { dbg('no rows on page ' + page); break; }
      for (let i = 0; i < trs.length && !cancelled; i++) {
        const tr = rowEls()[i] || trs[i];
        const row = readRow(tr);
        const key = normUrl(row.linkedinUrl) || (row.name + '|' + row.company);
        if (seen.has(key)) continue;
        seen.add(key);
        const c = contactFor(row.linkedinUrl);
        let panel = null;
        if (!c && opts.panels) { try { panel = await readPanelFor(tr, row); } catch (e) { dbg('panel error ' + row.name + ': ' + (e && e.message)); } }
        out.push({ row, profile: c ? profileFromContact(c, row) : toProfile(row, panel), panelOk: !!(c || panel) });
        send({ type: 'progress', count: out.length, page, name: row.name });
        if (opts.panels) await sleep(opts.delayMs || 250);
      }
      if (!opts.allPages || cancelled) break;
      const moved = await nextPage();
      if (!moved) { dbg('no next page after page ' + page); break; }
    }
    return out;
  };

  // ---- filters (debug dump 09 Oct 2026) ----------------------------------------------
  // <div class="relative"><button class="filter-item ... has-chips" aria-expanded aria-controls="contactfullname-panel">Person Name <span class="material-icons">add|remove</span></button>
  //   <div class="flex flex-wrap ..."> chips: <div class="chip"><span title="NAME">NAME</span><button class="close-chip-icon" aria-label="Remove NAME">close</button></div> ... <button class="others-chip">30 others</button></div>
  //   <div id="contactfullname-panel" role="region"><input type="text" class="search-input" placeholder="Search" name="contactfullname-search"> ... Exact match <input type="checkbox"></div></div>
  // Chips accumulate (OR search), so every chip is removed before each person. The Company Name filter is assumed to
  // have the same shape; its panel is dumped once so a difference shows up in the debug file.
  const dumped = {};
  const dumpOnce = (key, el, why) => { if (dumped[key]) return; dumped[key] = true; dbg('DUMP ' + key + ' (' + why + '): ' + (el ? el.outerHTML.replace(/\s+/g, ' ').slice(0, 15000) : 'null')); };
  const filterButton = (label) => {
    const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const els = Array.from(document.querySelectorAll('button.filter-item, button')).filter((e) => isVisible(e) && re.test(txt(e)));
    return els.sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0] || null;
  };
  const filterRoot = (btn) => btn.parentElement;
  const filterPanelOf = (btn) => { const id = btn.getAttribute('aria-controls'); return (id && document.getElementById(id)) || filterRoot(btn).querySelector('[role="region"]'); };
  const openFilter = async (label) => {
    const btn = filterButton(label);
    if (!btn) { dumpOnce('filters', document.querySelector('aside') || document.body, 'no "' + label + '" button'); return null; }
    if (btn.getAttribute('aria-expanded') !== 'true') { btn.click(); await waitFor(() => btn.getAttribute('aria-expanded') === 'true', 2000); }
    const panel = await waitFor(() => { const p = filterPanelOf(btn); return p && p.querySelector('input') ? p : null; }, 2500);
    if (!panel) { dumpOnce('panel:' + label, filterRoot(btn), 'panel or input not found'); return null; }
    return { btn, root: filterRoot(btn), panel, input: Array.from(panel.querySelectorAll('input:not([type="checkbox"]):not([type="radio"])')).find(isVisible) || panel.querySelector('input') };
  };
  const setExactMatch = async (label, on) => {
    const f = await openFilter(label);
    if (!f) return false;
    const row = Array.from(f.panel.querySelectorAll('div, label')).filter((e) => isVisible(e) && /^exact match$/i.test(txt(e).replace(/\s+/g, ' ').trim()) || (/exact match/i.test(txt(e)) && txt(e).length < 20)).sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0];
    const box = (row && (row.querySelector('input[type="checkbox"]') || (row.parentElement && row.parentElement.querySelector('input[type="checkbox"]')))) || f.panel.querySelector('input[type="checkbox"]');
    if (!box) { dumpOnce('exact:' + label, f.panel, 'no Exact match checkbox'); return false; }
    if (!!box.checked === !!on) return true;
    await paceRequest();
    (box.closest('label') || box).click(); lastRequestAt = Date.now();
    await sleep(150);
    if (!!box.checked !== !!on) { box.checked = !!on; box.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); }
    dbg('exact match ' + (on ? 'on' : 'off') + ' for ' + label + ': ' + box.checked);
    return !!box.checked === !!on;
  };
  const chipsOf = (root) => Array.from(root.querySelectorAll('.chip span[title]')).map((s) => s.getAttribute('title'));
  const chipCount = (root) => {
    const shown = root.querySelectorAll('.chip span[title]').length;
    const more = root.querySelector('button[aria-label^="Show all"]');
    const m = more && (more.getAttribute('aria-label').match(/(\d+)/) || txt(more).match(/(\d+)\s*other/i));
    return m ? Math.max(shown, parseInt(m[1], 10)) : shown;
  };
  const clearChips = async (root) => {
    let removed = 0;
    for (let i = 0; i < 200; i++) {
      const x = Array.from(root.querySelectorAll('button.close-chip-icon, button[aria-label^="Remove "]')).filter(isVisible)[0];
      if (!x) break;
      await paceRequest();
      x.click(); removed++; lastRequestAt = Date.now();
      await sleep(60);
    }
    if (removed) { dbg('removed ' + removed + ' chip(s) one by one'); await sleep(120); }
    return removed;
  };
  const filtersCount = () => { const t = Array.from(document.querySelectorAll('span, div, button')).map(txt).find((x) => /^\d+ filters?$/i.test(x)); return t ? parseInt(t, 10) : 0; };
  const ourChipCount = () => ['Person Name', 'Company Name'].reduce((n, l) => { const b = filterButton(l); return n + (b ? chipCount(filterRoot(b)) : 0); }, 0);
  // all chips at once: the "Clear" button next to "N FILTERS" is a single request. Used only when every active filter is ours.
  const clearAllFilters = async () => {
    const ours = ourChipCount();
    if (!ours) return 0;
    const total = filtersCount();
    const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((b) => isVisible(b) && /^clear( all)?$/i.test(txt(b))).sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0];
    if (btn) {
      await paceRequest();
      btn.click(); lastRequestAt = Date.now();
      const gone = await waitFor(() => ourChipCount() === 0, 4000, 100);
      if (gone) { dbg('cleared ' + ours + ' chip(s) with the Clear button (filters counter said ' + total + ')'); await sleep(150); return ours; }
      dbg('Clear button did not clear (filters counter ' + total + ', ours ' + ours + '), falling back to one by one');
    } else dumpOnce('clearbtn', document.querySelector('aside') || document.body, 'no Clear button (filters ' + total + ', ours ' + ours + ')');
    let n = 0;
    for (const l of ['Person Name', 'Company Name']) n += await clearFilter(l);
    return n;
  };
  const setNative = (input, value) => {
    input.focus();
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const pressEnter = (input) => { for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); };
  // Adds one chip to a filter: type, Enter; if no chip appeared, click the first suggestion in the panel list that matches.
  // per-batch chip timing: how long each chip took and which path added it (Enter, or a click on the suggestion list)
  let chipStats = { n: 0, ms: 0, enter: 0, suggest: 0, fail: 0, open: 0 };
  const chipStatsLine = () => chipStats.n ? (Math.round(chipStats.ms / chipStats.n) + ' ms/chip (enter ' + chipStats.enter + ', suggest ' + chipStats.suggest + ', fail ' + chipStats.fail + ', open ' + chipStats.open + ' ms)') : 'no chips';
  const suggestionFor = (panel, value) => {
    const key = normName(value).slice(0, 12);
    const items = Array.from(panel.querySelectorAll('li, button, label, [role="option"], div')).filter((e) => isVisible(e) && e.children.length <= 3 && !e.querySelector('input') && normName(txt(e)) && normName(txt(e)).includes(key));
    return items.sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0] || null;
  };
  let lastRequestAt = 0;
  // keep ~one filter request per chipGap ms (adds and removes both count on the server)
  const paceRequest = async () => { const wait = chipGap - (Date.now() - lastRequestAt); if (wait > 0) await sleep(wait); };
  const filterStillOpen = (f) => !!(f && f.btn && f.btn.isConnected && f.btn.getAttribute('aria-expanded') === 'true' && f.input && f.input.isConnected && isVisible(f.input));
  const addChip = async (label, value, fCached) => {
    const t0 = Date.now();
    await paceRequest();
    const f = filterStillOpen(fCached) ? fCached : await openFilter(label);
    if (f && fCached) Object.assign(fCached, f);
    chipStats.open += Date.now() - t0;
    if (!f || !f.input) return { ok: false, reason: 'filter "' + label + '" not usable' };
    const before = chipCount(f.root);
    const hasChip = () => chipCount(f.root) > before;
    setNative(f.input, '');
    await sleep(30);
    setNative(f.input, value);
    await sleep(80);
    pressEnter(f.input);
    lastRequestAt = Date.now();
    let how = 'enter';
    // the chip normally shows at once; if the app offers its suggestion list instead, click the entry as soon as it appears
    let got = await waitFor(() => (hasChip() ? 'chip' : (suggestionFor(f.panel, value) ? 'suggest' : null)), 1500, 100);
    if (got === 'suggest') {
      got = await waitFor(hasChip, 250, 50);
      if (!got) { const pick = suggestionFor(f.panel, value); if (pick) { pick.click(); how = 'suggest'; got = await waitFor(hasChip, 1500, 100); } }
    }
    if (!got) dumpOnce('nochip:' + label, f.root, 'typed "' + value + '", no chip appeared');
    chipStats.n++; chipStats.ms += Date.now() - t0; if (got) chipStats[how]++; else chipStats.fail++;
    return { ok: !!got, chips: chipsOf(f.root) };
  };
  const tableSignature = () => rowEls().slice(0, 3).map((tr) => readRow(tr).linkedinUrl || txt(tr).slice(0, 40)).join('|') + '#' + rowEls().length + '#' + counterText();
  const waitTable = async (sig) => { const changed = await waitFor(() => busy() || tableSignature() !== sig, 5000, 150); await waitFor(() => !busy(), 15000, 150); await sleep(250); return !!changed; };
  const clearFilter = async (label) => { const btn = filterButton(label); if (!btn) return 0; return clearChips(filterRoot(btn)); };

  const TITLE_RE = /^(dr|prof|mr|mrs|ms|dipl|ing|dipl\.-ing|herr|frau)\.?\s+/i;
  const SUFFIX_RE = /\s+(mba|phd|pmp|msc|bsc|ma|ba|llm|cfa|cpa|md|dds|jr|sr|ii|iii)\.?$/i;
  const searchNames = (cand) => {
    const out = [];
    const push = (n) => { n = String(n || '').replace(/\s+/g, ' ').trim(); if (n && n.split(' ').length >= 2 && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n); };
    let base = String(cand.name || '').replace(/\([^)]*\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim();
    push(cand.name);
    let cleaned = base.replace(TITLE_RE, '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) cleaned = cleaned.replace(SUFFIX_RE, '').trim();
    push(cleaned);
    if (cand.firstName && cand.lastName) push(cand.firstName.replace(TITLE_RE, '') + ' ' + cand.lastName.replace(SUFFIX_RE, ''));
    const slug = slugOf(cand.linkedinUrl).replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '').replace(/-/g, ' ').trim();
    if (slug && !/\d/.test(slug)) push(slug.replace(/\b\w/g, (c) => c.toUpperCase()));
    return out;
  };

  // One candidate: Person Name (+ Company Name when the CSV has one). If nothing matches with the company,
  // the company chip is removed and the name alone is tried once more.
  const searchCandidate = async (cand) => {
    const names = searchNames(cand);
    let last = { ok: false, reason: 'no usable name' };
    for (let ni = 0; ni < names.length; ni++) {
      const name = names[ni];
      const sig = tableSignature();
      await clearFilter('Person Name');
      await clearFilter('Company Name');
      const n = await addChip('Person Name', name);
      if (!n.ok) { last = { ok: false, reason: 'could not set Person Name' }; continue; }
      let usedCompany = false;
      if (cand.company && ni === 0) { const c = await addChip('Company Name', cand.company); usedCompany = c.ok; if (!c.ok) dbg('company chip not added for "' + cand.company + '"'); }
      const changed = await waitTable(sig);
      let f = findCandidateRow(cand);
      if (!f.hit && !contactFor(cand.linkedinUrl) && usedCompany) {
        dbg('no match with company for ' + name + ', retrying name only');
        const sig2 = tableSignature();
        await clearFilter('Company Name');
        await waitTable(sig2);
        f = findCandidateRow(cand);
      }
      last = { ok: true, changed, rows: rowEls().length, found: f, nameUsed: name };
      if (f.hit || contactFor(cand.linkedinUrl)) return last;
      if (ni < names.length - 1) dbg('"' + name + '" gave no match, trying "' + names[ni + 1] + '"');
    }
    return last;
  };
  const findCandidateRow = (cand) => {
    const want = slugOf(cand.linkedinUrl);
    const trs = rowEls();
    const rows = trs.map((tr) => ({ tr, row: readRow(tr) }));
    let hit = want ? rows.find((r) => slugOf(r.row.linkedinUrl) === want) : null;
    if (hit) return { hit, matchedBy: 'linkedin_url' };
    const nn = normName(cand.name), nc = normName(cand.company);
    const byName = rows.filter((r) => normName(r.row.name) === nn);
    if (byName.length === 1 && !want) return { hit: byName[0], matchedBy: 'name_only' };
    const byBoth = byName.find((r) => nc && normName(r.row.company) === nc);
    if (byBoth) return { hit: byBoth, matchedBy: 'name_company' };
    return { hit: null, matchedBy: '', seen: rows.map((r) => r.row.name + ' @ ' + r.row.company + ' <' + slugOf(r.row.linkedinUrl) + '>').slice(0, 10) };
  };

  // ---- queue runner (v0.2) ----------------------------------------------------------
  const loadQueue = () => new Promise((r) => chrome.storage.local.get({ queue: null }, (st) => r(st.queue)));
  const saveQueue = (q) => new Promise((r) => chrome.storage.local.set({ queue: q }, r));
  try { chrome.storage.local.get({ lastOpts: null }, (st) => { lastOpts = st.lastOpts || null; renderPill().catch(() => {}); }); } catch (e) { /* ignore */ }
  // page reloaded while a run was going: nothing is running any more, so the saved list goes back to "paused" (Resume works again)
  loadQueue().then((q) => { if (q && q.state === 'running') { q.state = 'paused'; q.note = 'page reloaded'; saveQueue(q); dbg('queue was running when the page reloaded: set to paused'); } });
  // ---- page size (50 by default; options 50 / 100 / 200 in a dropdown at the pager) ----
  let pageSizeSet = false, pageSizeValue = 50;
  const setPageSize = async (n) => {
    if (pageSizeSet) return true;
    // the control sits at the bottom right: "Rows per page  50 v". Prefer the element right after that label.
    const label = Array.from(document.querySelectorAll('span, div, p, label')).filter((e) => isVisible(e) && /^rows per page\b/i.test(txt(e)) && txt(e).length <= 24).sort((a, b) => b.outerHTML.length - a.outerHTML.length)[0];
    let ctl = null;
    if (label) {
      const box = label;
      ctl = box && Array.from(box.querySelectorAll('button, select, [role="combobox"], [role="button"], [aria-haspopup]')).filter(isVisible).sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0];
      if (!ctl && box) { const sib = label.nextElementSibling; if (sib && isVisible(sib)) ctl = sib.matches('button, select, [role="combobox"]') ? sib : sib.querySelector('button, select, [role="combobox"]') || sib; }
      if (!ctl) dumpOnce('pagerlabel', box, 'Rows per page label found, control not recognised');
    }
    if (!ctl) {
      const cands = Array.from(document.querySelectorAll('button, [role="combobox"], [role="listbox"], select, [aria-haspopup]')).filter((e) => isVisible(e) && /^\s*50\b/.test(txt(e)) && txt(e).length <= 20 || (e.tagName === 'SELECT' && Array.from(e.options).some((o) => o.value === String(n) || txt(o) === String(n))));
      ctl = cands.sort((x, y) => x.outerHTML.length - y.outerHTML.length)[0];
    }
    if (!ctl) {
      const cur = document.querySelector('[aria-current="page"]');
      const foot = (cur && (cur.closest('nav') || cur.parentElement && cur.parentElement.parentElement && cur.parentElement.parentElement.parentElement)) || Array.from(document.querySelectorAll('div, footer, nav')).filter((e) => isVisible(e) && /\bof\b\s*[\d,.]+/.test(txt(e)) && txt(e).length < 200).sort((a, b) => a.outerHTML.length - b.outerHTML.length)[0] || null;
      dumpOnce('pager', foot, 'no rows-per-page control found (counter "' + counterText() + '")');
      return false;
    }
    if (ctl.tagName === 'SELECT') { ctl.value = String(n); ctl.dispatchEvent(new Event('change', { bubbles: true })); pageSizeSet = true; return true; }
    const before = new Set(Array.from(document.querySelectorAll('li, [role="option"], button, div')).filter(isVisible));
    ctl.click();
    let opt = await waitFor(() => Array.from(document.querySelectorAll('li, [role="option"], button, div, span')).filter((e) => isVisible(e) && !before.has(e) && e.children.length <= 1 && txt(e) === String(n))[0], 2000, 100);
    if (!opt) {
      const nums = Array.from(document.querySelectorAll('li, [role="option"], button, div, span')).filter((e) => isVisible(e) && !before.has(e) && e.children.length <= 1 && /^\d+$/.test(txt(e))).sort((a, b) => parseInt(txt(b), 10) - parseInt(txt(a), 10));
      opt = nums[0] || null;
      if (opt) { n = parseInt(txt(opt), 10); dbg('rows per page: no 200 option, taking ' + n); }
    }
    if (!opt) { dumpOnce('pager', ctl.parentElement, 'opened rows-per-page, no "' + n + '" option'); document.body.click(); return false; }
    pageSizeValue = n;
    opt.click();
    await sleep(300);
    pageSizeSet = true;
    dbg('rows per page set to ' + n);
    return true;
  };

  // ---- batch: N names + their companies in one search (OR within a filter, AND across filters) ----
  const finishItem = (it, f, source) => {
    const c = contactFor(it.linkedinUrl);
    if (c) { it.status = 'done'; it.matchedBy = source; it.row = f && f.hit ? f.hit.row : rowFromContact(c); it.profile = profileFromContact(c, it.row); it.panelOk = true; it.dataSource = 'search_response'; it.note = ''; return true; }
    return false;
  };
  const totalCount = () => { const m = counterText().replace(/^\d+ selected \/ /, '').match(/^([\d,.]+) /); return m ? parseInt(m[1].replace(/[,.]/g, ''), 10) : null; };
  const PAGE = 200;
  let exactSet = false;
  // the name as FullEnrich stores it: no titles, no suffixes, no brackets (Exact match would otherwise miss "Astha Gupta, PhD, PMP")
  const cleanName = (it) => { const names = searchNames(it); return names[1] || names[0] || it.name; };
  // ---- batch without the filter UI: one request per batch; a page that overflows is split in halves ----
  let batchSettled = false; // true when the last batch ended with a clean response (the queue loop must not treat earlier limit hits as "still limited")
  const runBatchDirect = async (items, opts, depth) => {
    depth = depth || 0;
    const label = opts._label || 'Batch';
    const names = items.map(cleanName);
    const tB = Date.now();
    let r = null;
    for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
      setPhase(label + ' · searching ' + names.length + ' names' + (attempt ? ' (retry ' + attempt + ')' : ''));
      r = await directSearch(names, opts.exact !== false);
      if (r.ok) break;
      if (r.limited) { directGap = Math.min(4000, directGap + 500); await pause(15000 + 15000 * attempt, 'Rate limited, waiting'); continue; }
      if (r.error === 'timeout') { dbg('direct search: no answer in 45 s, retrying'); continue; }
      throw new Error((r.status ? 'HTTP ' + r.status + ' ' : '') + (r.message || r.error || 'search failed') + (r.grpcStatus ? ' (grpc ' + r.grpcStatus + ')' : ''));
    }
    if (cancelled) return 0;
    if (!r || !r.ok) throw new Error('search did not succeed after retries');
    let matched = 0;
    for (const it of items) { if (finishItem(it, null, 'direct')) { matched++; it.ms = 0; } }
    const missing = items.filter((it) => it.status !== 'done');
    const overflow = r.total !== null && r.total > (r.count || 0) && r.count >= (r.pageSize || 200) - 1;
    dbg('direct batch of ' + items.length + ': total ' + r.total + ', ' + r.count + ' rows, matched ' + matched + ', ' + (Date.now() - tB) + ' ms' + (overflow ? ', page overflow' : ''));
    if (missing.length && overflow && items.length > 1 && depth < 3) {
      const half = Math.ceil(missing.length / 2);
      matched += await runBatchDirect(missing.slice(0, half), opts, depth + 1);
      if (missing.length > half && !cancelled) matched += await runBatchDirect(missing.slice(half), opts, depth + 1);
    }
    if (!depth) batchSettled = true;
    return matched;
  };
  // one person without the filter UI: each name variant once, exact match off (the variants differ in form, not identity)
  const searchOneDirect = async (cand) => {
    const names = searchNames(cand);
    for (let ni = 0; ni < names.length && !cancelled; ni++) {
      let r = await directSearch([names[ni]], false);
      if (r.limited) { await pause(20000, 'Rate limited, waiting'); r = await directSearch([names[ni]], false); }
      if (!r.ok) throw new Error((r.status ? 'HTTP ' + r.status + ' ' : '') + (r.message || r.error || 'search failed'));
      if (contactFor(cand.linkedinUrl)) return { ok: true, nameUsed: names[ni], rows: r.count };
      if (ni < names.length - 1) dbg('"' + names[ni] + '" gave no match (' + r.count + ' of ' + r.total + ' rows), trying "' + names[ni + 1] + '"');
      else return { ok: true, nameUsed: names[ni], rows: r.count, total: r.total };
    }
    return { ok: false, reason: 'no usable name' };
  };
  const runBatch = async (items, opts) => {
    // people already decoded from an earlier response need no search at all
    const pre = items.filter((it) => contactFor(it.linkedinUrl));
    for (const it of pre) { finishItem(it, null, 'cached'); it.ms = 0; }
    items = items.filter((it) => it.status !== 'done');
    if (!items.length) { dbg('batch: all ' + pre.length + ' already decoded'); return pre.length; }
    if (directReady && opts.direct === true) {
      try { return pre.length + await runBatchDirect(items, opts); }
      catch (e) { dbg('direct search failed (' + (e && e.message) + '): this batch goes through the page filters'); directReady = false; try { document.dispatchEvent(new CustomEvent('feexport:forget')); } catch (x) { /* ignore */ } }
    }
    if (document.visibilityState === 'hidden') dbg('note: page-filter batch while the tab is hidden; this is slow until the direct template exists');
    const sig = tableSignature();
    chipStats = { n: 0, ms: 0, enter: 0, suggest: 0, fail: 0, open: 0 };
    let hitsAtStart = rateLimitHits;
    const tB = Date.now(); const rB = responsesSeen;
    if (opts.direct === true) tellNames(items.map(cleanName), Array.from(new Set(items.map((i) => i.company).filter(Boolean))));
    await clearAllFilters();
    if (!pageSizeSet && rowEls().length) await setPageSize(200);
    if (opts.exact !== false && !exactSet) { exactSet = await setExactMatch('Person Name', true); }
    const tClear = Date.now() - tB;
    let added = 0;
    const fName = await openFilter('Person Name');
    for (let k = 0; k < items.length && !cancelled; k++) { const it = items[k]; setPhase((opts._label || 'Batch') + ' · names ' + (k + 1) + '/' + items.length); const r = await addChip('Person Name', cleanName(it), fName); if (r.ok) added++; else dbg('batch: name chip failed for ' + it.name); }
    setPhase((opts._label || 'Batch') + ' · waiting for results');
    const tChips = Date.now() - tB - tClear; const rChips = responsesSeen - rB;
    await waitTable(sig);
    // two reasons the table can be empty after the chips: the final search was rate limited, or the app never fired a search
    // ("dead" batch, seen 4x in a row on 14 Oct). Either way: wait, then nudge one chip so the search runs again (2 requests, not 40)
    for (let n = 0; n < 2 && !cancelled && (rateLimitHits > hitsAtStart || responsesSeen === rB) && !rowEls().some((tr) => readRow(tr).linkedinUrl); n++) {
      const why = rateLimitHits > hitsAtStart ? 'Rate limited, waiting' : 'No search ran, retrying';
      hitsAtStart = rateLimitHits;
      await pause(why.startsWith('Rate') ? 15000 + 15000 * n : 3000, why);
      const last = items[items.length - 1];
      const f = await openFilter('Person Name');
      const x = f && Array.from(f.root.querySelectorAll('button[aria-label="Remove ' + last.name.replace(/"/g, '') + '"]')).filter(isVisible)[0];
      const sig3 = tableSignature();
      if (x) { await paceRequest(); x.click(); lastRequestAt = Date.now(); await sleep(400); }
      await addChip('Person Name', cleanName(last));
      await waitTable(sig3);
      dbg('re-ran the batch search (' + why + ', try ' + (n + 1) + ')');
    }
    if (!cancelled && responsesSeen === rB) { dbg('batch: no search response at all, leaving these ' + items.length + ' people pending for a retry'); throw new Error('no search response'); }
    const tWait = Date.now() - tB - tClear - tChips;
    // company chips only when the name search returned more than one page (otherwise every match is already here)
    const total = totalCount();
    const companies = Array.from(new Set(items.map((i) => i.company).filter(Boolean)));
    let coAdded = 0;
    const missingBefore = items.filter((it) => !contactFor(it.linkedinUrl)).length;
    if (missingBefore && (total === null || total > (pageSizeSet ? pageSizeValue : 50)) && companies.length) {
      const sig2 = tableSignature();
      const fCo = await openFilter('Company Name');
      for (let k = 0; k < companies.length && !cancelled; k++) { setPhase((opts._label || 'Batch') + ' · companies ' + (k + 1) + '/' + companies.length); const r = await addChip('Company Name', companies[k], fCo); if (r.ok) coAdded++; }
      await waitTable(sig2);
    }
    await sleep(300);
    // rows on the page by slug (for matchedBy / row data); the decoded response is the real source
    const rows = rowEls().map((tr) => ({ tr, row: readRow(tr) }));
    const bySlug = new Map(rows.map((r) => [slugOf(r.row.linkedinUrl), r]));
    let matched = 0;
    for (const it of items) {
      const hit = bySlug.get(slugOf(it.linkedinUrl)) || null;
      if (finishItem(it, hit ? { hit, matchedBy: 'batch' } : null, 'batch')) { matched++; it.ms = 0; }
    }
    dbg('batch of ' + items.length + ': ' + added + ' name chips, ' + coAdded + '/' + companies.length + ' company chips, total ' + total + ', ' + rowEls().length + ' rows, matched ' + matched + (pre.length ? ', ' + pre.length + ' cached' : '') + ' | clear ' + tClear + ' ms, chips ' + tChips + ' ms (' + chipStatsLine() + ', ' + rChips + ' searches fired), table wait ' + tWait + ' ms, total ' + (Date.now() - tB) + ' ms, ' + (responsesSeen - rB) + ' responses');
    return matched + pre.length;
  };

  const runQueue = async (opts) => {
    if (queueRunning) return;
    lastOpts = opts; try { chrome.storage.local.set({ lastOpts: opts }); } catch (e) { /* ignore */ }
    queueRunning = true; cancelled = false;
    const q = await loadQueue();
    if (!q || !q.items) { queueRunning = false; return; }
    q.state = 'running'; q.startedAt = q.startedAt || new Date().toISOString(); await saveQueue(q);
    const runT0 = Date.now(); exactSet = false;
    setPhase('Starting');
    const todo = (it) => opts._onlyErrors ? it.status === 'error' : (it.status === 'pending' || (opts.retryNotFound && (it.status === 'not_found' || it.status === 'error')));
    dbg('queue start: ' + q.items.length + ' items, to do ' + q.items.filter(todo).length + ', batch size ' + (opts.batchSize || 0));
    const batchSize = Math.max(0, Number(opts.batchSize) || 0);
    if (batchSize > 1) { const ok = await setPageSize(200); if (!ok) dbg('page size stays at 50; batches still run, misses go to the one-by-one pass'); }
    // pass 1: batches
    if (batchSize > 1) {
      const pend = q.items.filter(todo);
      for (let i = 0; i < pend.length && !cancelled; i += batchSize) {
        const items = pend.slice(i, i + batchSize);
        const t0 = Date.now();
        const label = 'Batch ' + (Math.floor(i / batchSize) + 1) + '/' + Math.ceil(pend.length / batchSize);
        for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
          const hitsBefore = rateLimitHits; batchSettled = false;
          try { await runBatch(items, Object.assign({}, opts, { _label: label })); } catch (e) { dbg('batch error: ' + (e && e.message)); setPhase(label + ' · error: ' + (e && e.message)); }
          if (rateLimitHits === hitsBefore || batchSettled) { cleanBatches++; if (cleanBatches >= 4 && chipGap > GAP_MIN) { chipGap = Math.max(GAP_MIN, chipGap - 100); cleanBatches = 0; dbg('4 clean batches: chip gap down to ' + chipGap + ' ms'); } break; }
          if (items.every((it) => it.status === 'done' || contactFor(it.linkedinUrl))) break; // limited, but the nudge recovered it
          // FullEnrich limited this batch and the nudge did not recover it: slow down and redo the people still open
          cleanBatches = 0;
          chipGap = Math.min(chipGap + 300, GAP_MAX);
          const wait = 20000 + 25000 * attempt;
          dbg('rate limited during batch: waiting ' + wait / 1000 + ' s, chip gap now ' + chipGap + ' ms, attempt ' + (attempt + 2));
          await pause(wait, 'Rate limited, waiting');
          items.forEach((it) => { if (it.status !== 'done') { it.status = 'pending'; it.note = ''; } });
        }
        setPhase(label + ' · done, ' + items.filter((it) => it.status === 'done').length + '/' + items.length + ' found');
        const ms = Date.now() - t0; items.forEach((it) => { if (it.status === 'done' && !it.ms) it.ms = Math.round(ms / items.length); });
        q.cursor = Math.min(q.items.length, q.items.indexOf(items[items.length - 1]) + 1); q.updatedAt = new Date().toISOString();
        q.rate = Math.round((q.items.filter((x) => x.status === 'done').length / Math.max(1, (Date.now() - runT0) / 60000)) * 10) / 10;
        await saveQueue(q);
        // after repeated limits, leave more room between batches as well
        await pause(Math.max(opts.delayMs || 500, rateLimitHits >= 2 ? 3000 : 0), null);
      }
    }
    if (exactSet) { await setExactMatch('Person Name', false); exactSet = false; }
    // pass 2: one by one for everything still open (name + company, then name only)
    for (let idx = 0; idx < q.items.length && !cancelled; idx++) {
      const it = q.items[idx];
      if (!todo(it)) continue;
      const t0 = Date.now();
      const hitsBefore = rateLimitHits;
      setPhase('One by one · ' + it.name);
      try {
        if (directReady && opts.direct === true) {
          let d = null;
          try { d = await searchOneDirect(it); } catch (e) { dbg('direct one-by-one failed for ' + it.name + ' (' + (e && e.message) + '): page filters from here'); directReady = false; try { document.dispatchEvent(new CustomEvent('feexport:forget')); } catch (x) { /* ignore */ } }
          if (d) {
            if (!d.ok) { it.status = 'error'; it.note = d.reason; }
            else if (finishItem(it, null, 'direct')) { if (d.nameUsed && d.nameUsed !== it.name) it.note = 'found as "' + d.nameUsed + '"'; }
            else { it.status = 'not_found'; it.note = 'no matching person among ' + d.rows + (d.total && d.total > d.rows ? ' of ' + d.total : '') + ' results for "' + d.nameUsed + '"'; }
            it.ms = Date.now() - t0;
            q.cursor = idx + 1; q.updatedAt = new Date().toISOString();
            await saveQueue(q);
            await sleep(opts.delayMs || 500);
            continue;
          }
        }
        const s = await searchCandidate(it);
        if (rateLimitHits > hitsBefore && !it._rl) {
          it._rl = true; it.status = 'pending'; it.note = '';
          dbg('rate limited while searching ' + it.name + ': waiting, then retrying once');
          await pause(20000, 'Rate limited, waiting');
          idx--; continue;
        }
        if (!s.ok) { it.status = 'error'; it.note = s.reason; }
        else {
          const f = s.found;
          if (finishItem(it, f, f.hit ? f.matchedBy : 'search_response')) { if (s.nameUsed && s.nameUsed !== it.name) it.note = 'found as "' + s.nameUsed + '"'; }
          else if (!f.hit) { it.status = 'not_found'; it.note = s.changed ? ('no matching row among ' + s.rows + (f.seen && f.seen.length ? ': ' + f.seen.join(' ; ') : '')) : 'table did not change'; }
          else {
            let panel = null;
            if (opts.panels !== false) { try { panel = await readPanelFor(f.hit.tr, f.hit.row); } catch (e) { dbg('panel error ' + it.name + ': ' + (e && e.message)); } }
            it.status = 'done'; it.matchedBy = f.matchedBy; it.row = f.hit.row; it.profile = toProfile(f.hit.row, panel); it.panelOk = !!panel; it.dataSource = 'panel'; it.note = '';
            closePanel();
          }
        }
      } catch (e) { it.status = 'error'; it.note = String(e && e.message || e); dbg('queue error ' + it.name + ': ' + it.note); }
      it.ms = Date.now() - t0;
      q.cursor = idx + 1; q.updatedAt = new Date().toISOString();
      await saveQueue(q);
      await sleep(opts.delayMs || 500);
    }
    if (!cancelled && !opts._second && q.items.some((i) => i.status === 'error')) {
      dbg('second attempt for ' + q.items.filter((i) => i.status === 'error').length + ' error item(s)');
      queueRunning = false;
      return runQueue(Object.assign({}, opts, { retryNotFound: false, batchSize: 1, _second: true, _onlyErrors: true }));
    }
    q.state = cancelled ? 'paused' : 'finished';
    await saveQueue(q);
    setPhase(q.state === 'finished' ? 'Finished' : 'Paused');
    queueRunning = false; renderPill().catch(() => {});
    dbg('queue ' + q.state + ': done ' + q.items.filter((i) => i.status === 'done').length + ', not found ' + q.items.filter((i) => i.status === 'not_found').length + ', error ' + q.items.filter((i) => i.status === 'error').length);
    queueRunning = false;
  };

  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.queue) renderPill().catch(() => {}); }); } catch (e) { /* ignore */ }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') { sendResponse({ ok: true, info: pageInfo(), url: location.href, queueRunning, contacts: contactsBySlug.size, direct: directReady }); return; }
    if (msg.type === 'cancel') { cancelled = true; sendResponse({ ok: true }); return; }
    if (msg.type === 'log') { chrome.storage.local.get({ logTail: [] }, (st) => { const prev = (st.logTail || []).filter((l) => !log.includes(l)); sendResponse({ log: prev.concat(log) }); }); return true; }
    if (msg.type === 'dumpFilters') { const b = filterButton('Person Name'); dumped.manual = false; dumpOnce('manual', b ? filterRoot(b) : null, 'manual'); sendResponse({ ok: true }); return; }
    if (msg.type === 'startQueue') { runQueue(msg.opts || {}); sendResponse({ ok: true }); return; }
    if (msg.type === 'run') {
      run(msg.opts || {}, (m) => chrome.runtime.sendMessage(Object.assign({ scope: 'feexport' }, m)).catch(() => {}))
        .then((people) => sendResponse({ ok: true, people, log, info: pageInfo() }))
        .catch((e) => { dbg('run error ' + (e && e.message)); sendResponse({ ok: false, error: String(e && e.message || e), log }); });
      return true;
    }
  });
})();

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), qstatus = $('qstatus'), qbar = $('qbar'), capInfo = $('capInfo');
const exportBtn = $('exportBtn'), cancelBtn = $('cancelBtn'), debugBtn = $('debugBtn'), clearBtn = $('clearBtn');
const panelsToggle = $('panelsToggle'), allPagesToggle = $('allPagesToggle');
const csvFile = $('csvFile'), qStart = $('qStart'), qPause = $('qPause'), qExport = $('qExport'), qClear = $('qClear'), qPanels = $('qPanels'), qDelay = $('qDelay'), qBatch = $('qBatch');

let tabId = null, onSearchPage = false, running = false, queueLive = false, lastLog = [];

const setStatus = (el, t, kind) => { el.textContent = t; el.className = 'status-line' + (kind ? ' ' + kind : ''); };
const csvEscape = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const splitName = (name) => { const c = String(name || '').replace(/\([^)]*\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim(); if (!c) return { first: '', last: '' }; const p = c.split(' '); return { first: p[0], last: p.slice(1).join(' ') }; };
const ym = (d) => (d ? String(d).slice(0, 7) : '');
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
const today = () => new Date().toISOString().slice(0, 10);

// Minimal RFC 4180 CSV parser (from JB Export).
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) { if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// HeyReach export: First Name, Last Name, Full Name, Profile URL, Location, Job Title, Company, Company URL, Email, Headline / Summary, Tags, Auto-tag
function itemsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], items: [] };
  const header = rows[0].map((h) => h.trim());
  const low = header.map((h) => h.toLowerCase());
  const idx = (...labels) => { for (const l of labels) { const i = low.indexOf(l.toLowerCase()); if (i >= 0) return i; } return -1; };
  const iUrl = idx('Profile URL', 'LinkedIn Profile URL', 'linkedin url', 'linkedin', 'profile_url', 'url');
  const iName = idx('Full Name', 'Name', 'fullName');
  const iFirst = idx('First Name', 'firstName'), iLast = idx('Last Name', 'lastName'), iCompany = idx('Company', 'companyName');
  const seen = new Set(), items = [];
  for (const r of rows.slice(1)) {
    const url = iUrl >= 0 ? String(r[iUrl] || '').trim() : '';
    const first = iFirst >= 0 ? String(r[iFirst] || '').trim() : '', last = iLast >= 0 ? String(r[iLast] || '').trim() : '';
    const name = (iName >= 0 ? String(r[iName] || '').trim() : '') || (first + ' ' + last).trim();
    if (!url || !/linkedin\.com\/in\//i.test(url) || !name) continue;
    const key = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (seen.has(key)) continue; seen.add(key);
    const original = {}; header.forEach((h, i) => { original[h] = r[i] == null ? '' : r[i]; });
    items.push({ name, firstName: first, lastName: last, company: iCompany >= 0 ? String(r[iCompany] || '').trim() : '', linkedinUrl: url, original, status: 'pending', note: '' });
  }
  return { header, items };
}

const FE_COLS = ['fe_title', 'fe_company', 'fe_company_domain', 'fe_industry', 'fe_headcount', 'fe_city', 'fe_country', 'fe_years_in_role', 'fe_history', 'fe_skills', 'fe_languages', 'fe_education', 'FE status', 'FE note', 'Matched by', 'Panel read', 'Profile JSON'];
function profileCols(p, status, matchedBy, panelOk, note) {
  if (!p) return ['', '', '', '', '', '', '', '', '', '', '', '', status, note || '', matchedBy || '', '', ''];
  const cur = p.employment.current || {};
  const years = cur.start_at ? Math.round(((Date.now() - Date.parse(cur.start_at)) / 31557600000) * 10) / 10 : '';
  const history = p.employment.all.map((e, i) => (i + 1) + '. ' + e.title + ' | ' + (e.company && e.company.name) + ' | ' + (ym(e.start_at) || '?') + ' to ' + (e.is_current ? 'present' : (ym(e.end_at) || '?'))).join('\n');
  const edu = p.educations.map((e) => [e.degree, e.school_name, e.when_text].filter(Boolean).join(', ')).join(' | ');
  return [cur.title || '', (cur.company && cur.company.name) || '', (cur.company && cur.company.domain) || '', (cur.company && cur.company.industry) || '', (cur.company && cur.company.headcount) || '', p.location.city, p.location.country_code || p.location.country, years, history, p.skills.join(', '), p.languages.map((l) => l.language).join(', '), edu, status, note || '', matchedBy || '', panelOk ? 'yes' : 'no', JSON.stringify(p)];
}

// Queue export: every original HeyReach column first (so the Slack form reads it as before), then the fe_* columns.
function buildQueueCsv(q) {
  const header = q.header.concat(FE_COLS);
  const lines = [header.map(csvEscape).join(',')];
  for (const it of q.items) {
    const base = q.header.map((h) => it.original[h] == null ? '' : it.original[h]);
    lines.push(base.concat(profileCols(it.status === 'done' ? it.profile : null, it.status, it.matchedBy, it.panelOk, it.note)).map(csvEscape).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// Current-search export (v0.1): HeyReach layout from the rows, then fe_* columns.
function buildSearchCsv(people) {
  const H = ['First Name', 'Last Name', 'Full Name', 'Profile URL', 'Location', 'Job Title', 'Company', 'Company URL', 'Email', 'Headline / Summary'];
  const lines = [H.concat(FE_COLS).map(csvEscape).join(',')];
  for (const it of people) {
    const r = it.row, p = it.profile, sp = splitName(p.full_name);
    lines.push([sp.first, sp.last, p.full_name, r.linkedinUrl, p.location.raw, r.jobTitle, r.company, r.companyLinkedinUrl, '', r.jobTitle].concat(profileCols(p, 'done', 'search', it.panelOk, '')).map(csvEscape).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// ---- page state ----
async function ping() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (!tab || !/^https:\/\/app\.fullenrich\.com\//.test(tab.url || '')) { setStatus(statusEl, 'Open FullEnrich → Search → People', 'error'); return false; }
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (!r || !r.ok) throw new Error('no reply');
    const i = r.info;
    if (!i.onSearch) { setStatus(statusEl, 'Go to Search → People', 'error'); return false; }
    onSearchPage = true; queueLive = !!r.queueRunning;
    setStatus(statusEl, 'Ready' + (i.rows ? ' · ' + i.rows + ' rows' : '') + (i.counter ? ' · ' + i.counter.replace(/ people$/, '') : '') + (r.contacts ? ' · ' + r.contacts + ' profiles' : '') + (r.queueRunning ? ' · running' : ''), 'success');
    return true;
  } catch (e) { setStatus(statusEl, 'Reload the FullEnrich tab', 'error'); return false; }
}

async function refreshCaptures() {
  const st = await chrome.storage.local.get({ captures: [] });
  const caps = st.captures || [];
  capInfo.textContent = caps.length ? caps.length + ' captures' : '';
}

async function refreshQueue() {
  const st = await chrome.storage.local.get({ queue: null });
  const q = st.queue;
  // stale 'running' (tab reloaded, content script says nothing runs): treat as paused so Resume is enabled
  if (q && q.items && q.state === 'running' && onSearchPage && !queueLive) { q.state = 'paused'; q.note = 'page reloaded'; await chrome.storage.local.set({ queue: q }); }
  if (!q || !q.items) { setStatus(qstatus, 'No list'); if (fileNameEl) fileNameEl.textContent = 'No file'; qbar.style.width = '0%'; qStart.disabled = true; qPause.disabled = true; qExport.disabled = true; qClear.disabled = true; return; }
  if (fileNameEl && q.fileName) fileNameEl.textContent = q.fileName;
  const n = q.items.length, done = q.items.filter((i) => i.status === 'done').length, nf = q.items.filter((i) => i.status === 'not_found').length + q.items.filter((i) => i.status === 'error').length, err = q.items.filter((i) => i.status === 'error').length, pend = n - done - nf;
  qbar.style.width = Math.round(((n - pend) / Math.max(n, 1)) * 100) + '%';
  const doneItems = q.items.filter((i) => i.status !== 'pending' && i.ms);
  const avg = doneItems.length ? doneItems.reduce((a, i) => a + (i.ms || 0), 0) / doneItems.length : 0;
  const eta = q.state === 'running' && pend && avg ? ' · ~' + Math.max(1, Math.round((pend * (avg + 500)) / 60000)) + ' min' : '';
  const cur = q.state === 'running' && q.cursor < n ? '\n' + ((q.items[q.cursor] || {}).name || '') : '';
  setStatus(qstatus, done + ' found · ' + (nf - err) + ' missing' + (err ? ' · ' + err + ' errors' : '') + (pend ? ' · ' + pend + ' left' : '') + ' / ' + n + (q.state === 'finished' ? ' · done' : (q.state === 'paused' ? ' · paused' : '')) + eta + cur, q.state === 'finished' ? 'success' : '');
  qStart.lastChild.textContent = pend === n ? 'Start' : (pend ? 'Resume' : (nf ? 'Retry' : 'Start'));
  qStart.disabled = !onSearchPage || q.state === 'running' || (!pend && !nf);
  qPause.disabled = q.state !== 'running';
  qExport.disabled = !(done || nf || err);
  qClear.disabled = q.state === 'running';
}

const fileNameEl = $('fileName');
csvFile.addEventListener('change', async () => {
  const f = csvFile.files && csvFile.files[0]; if (!f) return;
  if (fileNameEl) fileNameEl.textContent = f.name;
  const text = await f.text();
  const { header, items } = itemsFromCsv(text);
  if (!items.length) { setStatus(qstatus, 'No LinkedIn URL column', 'error'); return; }
  await chrome.storage.local.set({ queue: { fileName: f.name, header, items, cursor: 0, state: 'ready', loadedAt: new Date().toISOString() } });
  refreshQueue();
});

// Batch / Pause / Panel settings survive closing the popup
const SETTINGS_KEY = 'feexport.queueOpts';
const saveOpts = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ panels: qPanels.checked, delay: qDelay.value, batch: qBatch.value })); } catch (e) { /* ignore */ } };
try { const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); if (o) { qPanels.checked = o.panels !== false; if (o.delay) qDelay.value = o.delay; if (o.batch) qBatch.value = o.batch; } } catch (e) { /* ignore */ }
[qPanels, qDelay, qBatch].forEach((el) => { el.addEventListener('change', saveOpts); el.addEventListener('input', saveOpts); });

qStart.addEventListener('click', async () => {
  const st = await chrome.storage.local.get({ queue: null }); const q = st.queue; if (!q) return;
  const pend = q.items.filter((i) => i.status === 'pending').length;
  saveOpts();
  qStart.disabled = true;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'startQueue', opts: { panels: qPanels.checked, delayMs: Number(qDelay.value) || 500, batchSize: Number(qBatch.value) || 1, retryNotFound: !pend } });
    if (!r || !r.ok) throw new Error('no reply');
    setStatus(qstatus, 'Starting…');
  } catch (e) {
    // the tab has no (current) content script: happens after an extension reload until the FullEnrich tab is reloaded too
    setStatus(qstatus, 'Reload the FullEnrich tab, then press Resume', 'error');
    qStart.disabled = false;
    return;
  }
  setTimeout(refreshQueue, 400);
});
qPause.addEventListener('click', async () => { try { await chrome.tabs.sendMessage(tabId, { type: 'cancel' }); } catch (e) { /* ignore */ } setStatus(qstatus, 'Pausing…'); });
qExport.addEventListener('click', async () => { const st = await chrome.storage.local.get({ queue: null }); if (!st.queue) return; download(st.queue.fileName.replace(/\.csv$/i, '') + ' - fullenrich - ' + today() + '.csv', buildQueueCsv(st.queue), 'text/csv;charset=utf-8'); });
qClear.addEventListener('click', async () => { await chrome.storage.local.remove('queue'); csvFile.value = ''; if (fileNameEl) fileNameEl.textContent = 'No file'; refreshQueue(); });

chrome.runtime.onMessage.addListener((m) => { if (m && m.scope === 'feexport' && m.type === 'progress') setStatus(statusEl, 'Reading… ' + m.count + ' · page ' + m.page); });
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.queue) refreshQueue(); if (area === 'local' && ch.captures) refreshCaptures(); });

exportBtn.addEventListener('click', async () => {
  if (running) return;
  running = true; exportBtn.disabled = true; cancelBtn.style.display = 'block';
  setStatus(statusEl, 'Reading…');
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'run', opts: { panels: panelsToggle.checked, allPages: allPagesToggle.checked, delayMs: 300 } });
    lastLog = (r && r.log) || [];
    if (!r || !r.ok) throw new Error((r && r.error) || 'no reply');
    const people = r.people || [];
    if (!people.length) throw new Error('Nothing read');
    download('fullenrich-search-' + today() + '.csv', buildSearchCsv(people), 'text/csv;charset=utf-8');
    const noPanel = people.filter((p) => !p.panelOk).length;
    setStatus(statusEl, people.length + ' exported' + (noPanel ? ' · ' + noPanel + ' partial' : ''), noPanel ? '' : 'success');
  } catch (e) { setStatus(statusEl, 'Failed: ' + (e && e.message), 'error'); }
  running = false; exportBtn.disabled = false; cancelBtn.style.display = 'none';
});
cancelBtn.addEventListener('click', async () => { try { await chrome.tabs.sendMessage(tabId, { type: 'cancel' }); } catch (e) { /* ignore */ } setStatus(statusEl, 'Cancelling…'); });

// settings (Search export + debug) live behind the gear; the open state is remembered per browser
const settingsBtn = document.getElementById('settingsBtn'), settingsEl = document.getElementById('settings');
const showSettings = (on) => { settingsEl.hidden = !on; settingsBtn.setAttribute('aria-expanded', on ? 'true' : 'false'); try { localStorage.setItem('feexport.settings', on ? '1' : '0'); } catch (e) { /* ignore */ } };
settingsBtn.addEventListener('click', () => showSettings(settingsEl.hidden));
try { if (localStorage.getItem('feexport.settings') === '1') showSettings(true); } catch (e) { /* ignore */ }
debugBtn.addEventListener('click', async () => {
  const st = await chrome.storage.local.get({ captures: [], queue: null, logTail: [] });
  let log = (st.logTail || []).concat(lastLog);
  try { await chrome.tabs.sendMessage(tabId, { type: 'dumpFilters' }); const r = await chrome.tabs.sendMessage(tabId, { type: 'log' }); if (r && r.log) log = r.log; } catch (e) { /* tab may not be on FullEnrich */ }
  const q = st.queue ? { fileName: st.queue.fileName, state: st.queue.state, counts: { total: st.queue.items.length, done: st.queue.items.filter((i) => i.status === 'done').length, not_found: st.queue.items.filter((i) => i.status === 'not_found').length, error: st.queue.items.filter((i) => i.status === 'error').length }, samples: st.queue.items.filter((i) => i.status !== 'pending').slice(0, 8).map((i) => ({ name: i.name, status: i.status, note: i.note, matchedBy: i.matchedBy, panelOk: i.panelOk, dataSource: i.dataSource, ms: i.ms, history: i.profile ? i.profile.employment.all.length : 0, skills: i.profile ? i.profile.skills.length : 0 })) } : null;
  download('fe-export-debug-' + today() + '.json', JSON.stringify({ version: chrome.runtime.getManifest().version, at: new Date().toISOString(), log, queue: q, captures: st.captures || [] }), 'application/json');
  setStatus(statusEl, 'Debug file saved', 'success');
});
clearBtn.addEventListener('click', async () => { await chrome.storage.local.set({ captures: [] }); refreshCaptures(); });

ping().then((ok) => { exportBtn.disabled = !ok; refreshQueue(); });
refreshCaptures();

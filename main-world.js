// FE Export — main-world helper (runs in the page's own JS world at document_start).
//
// FullEnrich keeps its own reference to window.fetch, so the hook has to be installed
// before the app bundle runs. We watch the people search call the page itself makes
// when a filter chip is added:
//   POST /grpc-web/listing.Listing/SearchContacts   (application/grpc-web+proto)
// and decode its response, which already carries the full profile of every row on
// the page (the side panel opens with no further request). Decoded contacts go to
// content.js as JSON ('feexport:contacts'); the raw bytes of the last few calls go
// along too for the debug file ('feexport:capture'). Nothing is sent anywhere, no
// credits are involved.
//
// Direct search (v0.9.0): once the page has made one search with the list's names
// (the first batch goes through the filters as before), that request is kept in memory
// as a template: same URL, same headers, same session, same page size. Later batches
// only swap the names in it and send it from here with the page's own fetch, paced
// like a person clicking. No filter UI is touched, so the run keeps going while the
// FullEnrich tab is in the background (Chrome stops a hidden tab's rendering and
// timers; it does not stop its network calls). The template never leaves the page:
// it is not written to storage.
//
// Request layout (captures of 09 Oct 2026): { 2: pageSize, 11: repeated nameFilter { 1 name, 2 flag, 3 flag }, 21: workspace id }.
// The name field is found from the names the content script says it typed, so a
// renumbered field still works; 11 is only the fallback.
//
// Response layout (worked out from captures on 09 Oct 2026 with a generic protobuf walk):
//   grpc-web stream, one frame per contact: { 1: contact, 2: totalCount }
//   contact = { 1 id, 2 first, 3 last, 4 fullName, 5 locationLower,
//               6: { 1: current job, 2: repeated past job }, 7: repeated education,
//               8: repeated language { 1 name, 2 proficiency }, 9: { 1: { 1 linkedinUrl, 2 slug } },
//               14 headline, 15: { 1 country, 2 cc, 3 city, 4 region, 7 full }, 16: repeated skill }
//   job     = { 1 title, 2 seniority, 3 company, 4 isCurrent, 5 description, 6 start, 7 end }
//   company = { 1 id, 3 name, 4 domain, 5 description, 7 founded, 8 headcount, 9 headcountRange,
//               10 type, 12: { 1: { 1 linkedinUrl, 2 slug } }, 13 industry, 14 hq, 15 repeated specialty }
//   education = { 1 school, 2 degree, 4 start, 5 end, 6 slug }
(() => {
  if (window.__feExportMainWorldReady) return;
  window.__feExportMainWorldReady = true;

  const WATCH = /\/grpc-web\/listing\.Listing\/SearchContacts\b/;

  const toB64 = (buf) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const emit = (name, payload) => { try { document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) })); } catch (e) { /* ignore */ } };
  const bodyToBytes = async (body) => {
    if (body == null) return new Uint8Array(0);
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    try { return new Uint8Array(await new Response(body).arrayBuffer()); } catch (e) { return new Uint8Array(0); }
  };

  // ---- protobuf wire-format reader ----
  const TD = new TextDecoder('utf-8', { fatal: true });
  const readVarint = (b, i) => { let r = 0, s = 0, c; do { c = b[i++]; r += (c & 0x7f) * Math.pow(2, s); s += 7; } while (c & 0x80); return [r, i]; };
  const decodeMsg = (b) => {
    const out = {}; let i = 0;
    while (i < b.length) {
      let k; [k, i] = readVarint(b, i); const f = Math.floor(k / 8), wt = k & 7; let v;
      if (wt === 0) { [v, i] = readVarint(b, i); }
      else if (wt === 1) { v = b.subarray(i, i + 8); i += 8; }
      else if (wt === 5) { v = b.subarray(i, i + 4); i += 4; }
      else if (wt === 2) { let n; [n, i] = readVarint(b, i); v = b.subarray(i, i + n); i += n; }
      else throw new Error('bad wire type ' + wt + ' at ' + i);
      (out[f] = out[f] || []).push({ wt, v });
    }
    return out;
  };
  const str = (m, f) => { const a = m && m[f]; if (!a || !a.length || a[0].wt !== 2) return ''; try { return TD.decode(a[0].v); } catch (e) { return ''; } };
  const strs = (m, f) => ((m && m[f]) || []).filter((x) => x.wt === 2).map((x) => { try { return TD.decode(x.v); } catch (e) { return ''; } }).filter(Boolean);
  const num = (m, f) => { const a = m && m[f]; return a && a.length && a[0].wt === 0 ? a[0].v : null; };
  const sub = (m, f) => { const a = m && m[f]; if (!(a && a.length && a[0].wt === 2)) return null; try { return decodeMsg(a[0].v); } catch (e) { return null; } };
  const subs = (m, f) => ((m && m[f]) || []).filter((x) => x.wt === 2).map((x) => { try { return decodeMsg(x.v); } catch (e) { return null; } }).filter(Boolean);
  const date = (s) => (s ? s.slice(0, 10) : null);
  const hqCountry = (s) => { const p = String(s || '').split(',').map((x) => x.trim()).filter((x) => x && !/^(europe|asia|africa|north america|south america|oceania)$/i.test(x)); return p.length >= 3 ? p[2] : (p[p.length - 1] || ''); };

  const company = (c) => c ? ({
    id: str(c, 1), name: str(c, 3), domain: str(c, 4) || str(c, 6), description: str(c, 5), founded: num(c, 7), headcount: num(c, 8), headcount_range: str(c, 9), company_type: str(c, 10),
    industry: { main_industry: str(c, 13) }, locations: { headquarters: { country: hqCountry(str(c, 14)), raw: str(c, 14) } },
    linkedin_url: str(sub(sub(c, 12), 1), 1), specialties: strs(c, 15),
  }) : null;
  const job = (j) => ({ title: str(j, 1), seniority: str(j, 2), company: company(sub(j, 3)), is_current: num(j, 4) === 1 || !str(j, 7), description: str(j, 5), start_at: date(str(j, 6)), end_at: date(str(j, 7)) });
  const contact = (m) => {
    const emp = sub(m, 6) || {};
    const cur = sub(emp, 1), past = subs(emp, 2);
    const pastJobs = past.map(job);
    const curJob = cur ? job(cur) : null;
    const same = (a, b) => a && b && a.title === b.title && (a.company && a.company.name) === (b.company && b.company.name) && a.start_at === b.start_at;
    const all = curJob && !pastJobs.some((j) => same(j, curJob)) ? [curJob].concat(pastJobs) : pastJobs;
    const loc = sub(m, 15) || {};
    const pn = sub(sub(m, 9), 1);
    return {
      id: str(m, 1), first_name: str(m, 2), last_name: str(m, 3), full_name: str(m, 4), headline: str(m, 14), description: '',
      location: { country: str(loc, 1), country_code: str(loc, 2), city: str(loc, 3), region: str(loc, 4), raw: str(loc, 7) || str(m, 5) },
      employment: { current: curJob || all[0] || null, all },
      educations: subs(m, 7).map((e) => ({ school_name: str(e, 1), degree: str(e, 2), start_at: date(str(e, 4)), end_at: date(str(e, 5)) })),
      languages: subs(m, 8).map((l) => ({ language: str(l, 1), proficiency: str(l, 2) })),
      skills: strs(m, 16),
      social_profiles: { professional_network: { url: pn ? str(pn, 1) : '', slug: pn ? str(pn, 2) : '' } },
    };
  };
  const parseResponse = (buf) => {
    const b = new Uint8Array(buf); let i = 0; const contacts = []; let total = null, trailer = '', errors = 0;
    while (i + 5 <= b.length) {
      const flag = b[i]; const n = new DataView(b.buffer, b.byteOffset + i + 1, 4).getUint32(0, false); const data = b.subarray(i + 5, i + 5 + n); i += 5 + n;
      if (flag & 0x80) { trailer = new TextDecoder().decode(data); continue; }
      try { const m = decodeMsg(data); const c = sub(m, 1); if (c) contacts.push(contact(c)); if (total === null && num(m, 2) !== null) total = num(m, 2); } catch (e) { errors++; }
    }
    return { contacts, total, trailer, errors };
  };

  // ---- protobuf writer + top-level splitter (for the request template) ----
  const encVarint = (n) => { const out = []; n = Math.max(0, Math.floor(Number(n) || 0)); do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0); return out; };
  const encTag = (f, wt) => encVarint(f * 8 + wt);
  const encBytesField = (f, bytes) => encTag(f, 2).concat(encVarint(bytes.length), Array.from(bytes));
  const encStrField = (f, str) => encBytesField(f, new TextEncoder().encode(str));
  const splitTop = (b) => {
    const out = []; let i = 0;
    while (i < b.length) {
      const start = i; let k; [k, i] = readVarint(b, i); const f = Math.floor(k / 8), wt = k & 7; let v;
      if (wt === 0) { [v, i] = readVarint(b, i); }
      else if (wt === 1) { v = b.subarray(i, i + 8); i += 8; }
      else if (wt === 5) { v = b.subarray(i, i + 4); i += 4; }
      else if (wt === 2) { let n; [n, i] = readVarint(b, i); v = b.subarray(i, i + n); i += n; }
      else throw new Error('bad wire type ' + wt + ' at ' + i);
      if (i > b.length) throw new Error('truncated');
      out.push({ f, wt, v, start, end: i });
    }
    return out;
  };
  const concat = (parts) => { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  const frame = (payload) => concat([Uint8Array.from([0, (payload.length >>> 24) & 255, (payload.length >>> 16) & 255, (payload.length >>> 8) & 255, payload.length & 255]), payload]);
  const unframe = (b) => { if (b.length < 5 || b[0] !== 0) return null; const n = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0, false); return b.subarray(5, 5 + n); };

  // ---- the template ----
  let tmpl = null;                       // { url, init, payload, nameField, companyField, restExact, at }
  let recent = { names: [], companies: [] }; // what the content script typed last (lower-cased)
  const lower = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
  document.addEventListener('feexport:names', (ev) => { let p = null; try { p = JSON.parse(ev.detail); } catch (e) { return; } recent = { names: (p.names || []).map(lower), companies: (p.companies || []).map(lower) }; });
  const headersOf = (input, init) => { const out = {}; try { const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined)); h.forEach((v, k) => { out[k] = v; }); } catch (e) { /* ignore */ } return out; };
  const learnTemplate = (url, input, init, reqBytes) => {
    if (!recent.names.length) return;
    const payload = unframe(reqBytes); if (!payload || !payload.length) return;
    let entries; try { entries = splitTop(payload); } catch (e) { return; }
    let nameField = 0, companyField = 0, restExact = null;
    for (const e of entries) {
      if (e.wt !== 2) continue;
      let sub; try { sub = splitTop(e.v); } catch (x) { continue; }
      const first = sub.find((q) => q.f === 1 && q.wt === 2); if (!first) continue;
      let text = ''; try { text = lower(TD.decode(first.v)); } catch (x) { continue; }
      if (!nameField && recent.names.includes(text)) { nameField = e.f; restExact = concat(sub.filter((q) => q.f !== 1).map((q) => e.v.subarray(q.start, q.end))); }
      else if (!companyField && recent.companies.includes(text)) companyField = e.f;
    }
    if (!nameField) return;
    const init2 = {};
    for (const k of ['method', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'keepalive']) { const v = init && init[k] !== undefined ? init[k] : (input instanceof Request ? input[k] : undefined); if (v !== undefined) init2[k] = v; }
    init2.method = init2.method || 'POST';
    init2.headers = headersOf(input, init);
    tmpl = { url, init: init2, payload, nameField, companyField, restExact, at: Date.now() };
    const page = entries.find((e) => e.f === 2 && e.wt === 0);
    emit('feexport:template', { ok: true, nameField, companyField, pageSize: page ? page.v : null, exactBytes: restExact ? restExact.length : 0 });
  };
  const PAGE_FIELD = 2, PAGE_SIZE = 200;
  const buildBody = (names, exact) => {
    const parts = []; let inserted = false;
    const restPlain = tmpl.restExact ? concat(splitTop(tmpl.restExact).map((q) => (q.wt === 0 ? Uint8Array.from(encTag(q.f, 0).concat(encVarint(0))) : tmpl.restExact.subarray(q.start, q.end)))) : new Uint8Array(0);
    const nameEntry = (n) => { const body = concat([Uint8Array.from(encStrField(1, n)), exact ? tmpl.restExact : restPlain]); return Uint8Array.from(encBytesField(tmpl.nameField, body)); };
    for (const e of splitTop(tmpl.payload)) {
      if (e.f === tmpl.nameField) { if (!inserted) { names.forEach((n) => parts.push(nameEntry(n))); inserted = true; } continue; }
      if (tmpl.companyField && e.f === tmpl.companyField) continue;
      if (e.f === PAGE_FIELD && e.wt === 0) { parts.push(Uint8Array.from(encTag(PAGE_FIELD, 0).concat(encVarint(Math.max(e.v, PAGE_SIZE))))); continue; }
      parts.push(tmpl.payload.subarray(e.start, e.end));
    }
    if (!inserted) names.forEach((n) => parts.push(nameEntry(n)));
    return frame(concat(parts));
  };
  // one response, whoever sent the request: decode, tell the content script, keep the raw bytes for the debug file
  const afterResponse = async (url, reqBytes, res, direct) => {
    const resBuf = await res.clone().arrayBuffer();
    const parsed = parseResponse(resBuf);
    const gm = res.headers.get('grpc-message') || '';
    const tr = typeof parsed.trailer === 'string' ? parsed.trailer : JSON.stringify(parsed.trailer || '');
    const limited = res.status === 429 || /rate ?limit/i.test(gm) || /rate ?limit/i.test(tr);
    if (limited) emit('feexport:ratelimit', { at: new Date().toISOString(), status: res.status, message: gm || tr.slice(0, 200) });
    emit('feexport:contacts', { at: new Date().toISOString(), total: parsed.total, errors: parsed.errors, contacts: parsed.contacts });
    emit('feexport:capture', { at: new Date().toISOString(), url, direct: !!direct, status: res.status, resContentType: res.headers.get('content-type') || '', reqB64: toB64(reqBytes), resB64: toB64(resBuf), resBytes: resBuf.byteLength, decoded: parsed.contacts.length, decodeErrors: parsed.errors });
    return { status: res.status, total: parsed.total, count: parsed.contacts.length, limited, message: gm || (tr.match(/grpc-message:\s*([^\r\n]*)/i) || [])[1] || '', grpcStatus: (tr.match(/grpc-status:\s*(\d+)/i) || [])[1] || '' };
  };
  document.addEventListener('feexport:search', async (ev) => {
    let p = null; try { p = JSON.parse(ev.detail); } catch (e) { return; }
    const id = p.id;
    if (!tmpl) { emit('feexport:searchresult', { id, ok: false, error: 'no template yet' }); return; }
    try {
      const body = buildBody((p.names || []).map((n) => String(n).replace(/\s+/g, ' ').trim()).filter(Boolean), p.exact !== false);
      const res = await origFetch(tmpl.url, Object.assign({}, tmpl.init, { body }));
      const r = await afterResponse(tmpl.url, body, res, true);
      emit('feexport:searchresult', Object.assign({ id, ok: res.ok && !r.limited && !(r.grpcStatus && r.grpcStatus !== '0'), pageSize: PAGE_SIZE }, r));
    } catch (e) { emit('feexport:searchresult', { id, ok: false, error: String(e && e.message || e) }); }
  });
  document.addEventListener('feexport:forget', () => { tmpl = null; emit('feexport:template', { ok: false }); });

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await origFetch.apply(this, arguments);
    if (WATCH.test(url)) {
      try {
        const reqBytes = await bodyToBytes(init && init.body !== undefined ? init.body : (input instanceof Request ? await input.clone().arrayBuffer() : null));
        if (res.ok) learnTemplate(url, input, init, reqBytes);
        await afterResponse(url, reqBytes, res, false);
      } catch (e) { emit('feexport:capture', { at: new Date().toISOString(), url, error: String(e && e.message || e) }); }
    }
    return res;
  };
})();

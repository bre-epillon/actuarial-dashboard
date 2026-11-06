'use strict';
/* =====================================================================
   Explorer tool: search anything (policy, claim, broker, reinsured...),
   see premium booking and claim development over time, and browse /
   pivot policies, claims and postings.
   Data: data/explorer_data.js (built by `python recon.py build`).
   ===================================================================== */
const CLAIM_LEVEL = ['Claim', 'Claim Type', 'Claim Status', 'Threshold', 'First Period', 'Last Period'];
const NULLK = -2147483648;

APP = {
  title: 'Explorer',
  lsKey: 'actdash.explorer.v1',
  dataFile: 'data/explorer_data.js',
  omnibox: true,
  tabs: [['overview', 'Overview', (page) => overview(page)], ['policies', 'Policies'], ['claims', 'Claims'], ['postings', 'Postings']],
  tableOf: (tab) => (tab === 'overview' ? 'policies' : tab),
  otherTool: { href: 'reconciliation.html', label: 'Reconciliation', title: 'Actuarial vs finance: discrepancies by measure and policy' },
  openPolicy: (row, t, i) => openPolicy(row, t, i),
  topHtml: () => `<div class="omni"><input class="search" id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search a policy, claim, broker, reinsured…  ( / )"><div class="sugg" id="sugg" hidden></div></div>`,
  onTop: () => { const q = $('#q'); if (q && document.activeElement !== q && q.value !== S.search) q.value = S.search; },
  onLoad: () => {},
  onEscape: () => hideSugg(),
  afterBoot: () => { wireOmnibox(); applyHash(); window.addEventListener('hashchange', () => { applyHash(); renderAll(); }); },
  presets: {
    policies: [
      { name: 'Policy list', view: { mode: 'list', listCols: ['Policy', 'UWY', 'Reserving LOB', 'Branch', 'Office', 'Policy Type', 'Reinsured', 'Broker'], measures: ['GGWP_A', 'GPrmB_A', 'Incurred_A', 'Claims_N'] } },
      { name: 'GWP by Reserving LOB × UWY', view: { mode: 'group', groupBy: ['Reserving LOB'], colDim: 'UWY', measures: ['GGWP_A'] } },
      { name: 'Premium and incurred by UWY', view: { mode: 'group', groupBy: ['UWY'], measures: ['#rows', 'GGWP_A', 'GPrmB_A', 'Incurred_A', 'Claims_N'] } },
      { name: 'Broker league table', view: { mode: 'group', groupBy: ['Broker'], measures: ['#rows', 'GGWP_A', 'GPrmB_A', 'Incurred_A', 'Claims_N'], sort: { id: 'm:GGWP_A', dir: -1 } } },
      { name: 'Premium by Office × Policy Type', view: { mode: 'group', groupBy: ['Office', 'Policy Type'], measures: ['#rows', 'GGWP_A', 'GPrmB_A'] } },
    ],
    claims: [
      { name: 'Claims by UWY', view: { mode: 'group', groupBy: ['UWY'], measures: ['#rows', '#pol', 'Paid', 'Case Reserves', 'Incurred'] } },
      { name: 'Claim list', view: { mode: 'list', listCols: ['Policy', 'Claim', 'Claim Type', 'Claim Status', 'UWY', 'Reserving LOB', 'Last Period'], measures: ['Paid', 'Case Reserves', 'Incurred'], sort: { id: 'm:Incurred', dir: 1 } } },
      { name: 'Large claims', filters: { 'Claim Type': { vals: ['Large'], not: false } }, view: { mode: 'list', listCols: ['Policy', 'Claim', 'Claim Status', 'UWY', 'Reserving LOB', 'Reinsured', 'Last Period'], measures: ['Paid', 'Case Reserves', 'Incurred'], sort: { id: 'm:Incurred', dir: 1 } } },
      { name: 'Open claims by Reserving LOB', filters: { 'Claim Status': { vals: ['Open'], not: false } }, view: { mode: 'group', groupBy: ['Reserving LOB'], measures: ['#rows', 'Case Reserves', 'Incurred'] } },
    ],
    postings: [
      { name: 'Paid triangle (UWY × Dev Year, cumulative)', view: { mode: 'group', groupBy: ['UWY'], colDim: 'Dev Year', cum: true, measures: ['GClmP'] } },
      { name: 'Incurred triangle (cumulative)', view: { mode: 'group', groupBy: ['UWY'], colDim: 'Dev Year', cum: true, measures: ['Incurred'] } },
      { name: 'GWP triangle (cumulative)', view: { mode: 'group', groupBy: ['UWY'], colDim: 'Dev Year', cum: true, measures: ['GGWP'] } },
      { name: 'Movements by quarter', view: { mode: 'group', groupBy: ['Quarter'], measures: ['GClmP', 'GClmO', 'Incurred', 'GPrmB', 'GGWP'] } },
      { name: 'Raw postings', view: { mode: 'list', listCols: ['Policy', 'Claim', 'Measure', 'Period', 'Dev Year', 'Cut-off Date', 'UWY', 'Reserving LOB'], measures: ['_value'] } },
    ],
  },
};

/* -------------------------------------------------------------- jumping */
function jump(filters) {
  pushHist();
  S.filters = filters; S.num = []; S.search = ''; S.tab = 'overview';
  hideSugg();
  const q = $('#q'); if (q) q.value = '';
  renderAll();
  const m = $('#main'); if (m) m.scrollTop = 0;
}
const eq = (v) => ({ vals: [v], not: false });
function policyRef(row) { const c = T.policies.cols.get('Policy'); return c.dict[c.codes[row]]; }
function openPolicy(row, t, i) {
  const f = { Policy: eq(policyRef(row)) };
  if (t && t.name !== 'policies') { const c = t.cols.get('Claim'); const v = c && c.dict[c.codes[i]]; if (v !== null && v !== undefined) f.Claim = eq(v); }
  jump(f);
}
function applyHash() {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  const m = /^(policy|broker|reinsured|q)=(.*)$/.exec(h);
  if (!m || !m[2]) return;
  S.filters = {}; S.num = []; S.search = ''; S.tab = 'overview';
  if (m[1] === 'policy') S.filters.Policy = eq(m[2]);
  else if (m[1] === 'broker') S.filters.Broker = eq(m[2]);
  else if (m[1] === 'reinsured') S.filters.Reinsured = eq(m[2]);
  else S.search = m[2];
}

/* -------------------------------------------------------------- omnibox */
let sugg = { items: [], hl: -1 };
function hideSugg() { const el = $('#sugg'); if (el) el.hidden = true; sugg = { items: [], hl: -1 }; }
function matchRank(s, q) { const i = s.toLowerCase().indexOf(q); return i < 0 ? -1 : i === 0 ? 0 : 1; }
function hilite(s, q) {
  const i = String(s).toLowerCase().indexOf(q);
  if (i < 0 || !q) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
}
function suggestions(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const P = T.policies, C = T.claims, out = [];
  const pick = (c, limit) => {
    const hits = [];
    for (let k = 0; k < c.dict.length; k++) { const d = c.dict[k]; if (d === null) continue; const r = matchRank(String(d), q); if (r >= 0) hits.push([r, k]); }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return hits.slice(0, limit).map((h) => h[1]);
  };
  const countBy = (c, ks) => { const set = new Map(ks.map((k) => [k, 0])); for (let i = 0; i < P.n; i++) { const k = c.codes[i]; if (set.has(k)) set.set(k, set.get(k) + 1); } return set; };
  const val = (name, row) => { const c = P.cols.get(name); return c ? c.dict[c.codes[row]] : null; };
  // policies
  const pc = P.cols.get('Policy');
  for (const k of pick(pc, 6)) {
    const ref = pc.dict[k], row = polRow.get(ref);
    out.push({ g: 'Policies', main: ref, sub: [val('Reinsured', row), val('UWY', row) !== null ? 'UWY ' + val('UWY', row) : null, val('Reserving LOB', row)].filter(Boolean).join(' · '), right: money(P.cols.get('GGWP_A').values[row]), f: { Policy: eq(ref) } });
  }
  // claims (keyed by policy + claim)
  const cc = C.cols.get('Claim'), ok = new Uint8Array(cc.dict.length); let any = false;
  const rank = new Int8Array(cc.dict.length).fill(-1);
  for (let k = 0; k < cc.dict.length; k++) { const d = cc.dict[k]; if (d === null) continue; const r = matchRank(String(d), q); if (r >= 0) { ok[k] = 1; rank[k] = r; any = true; } }
  if (any) {
    const rows = [];
    for (let i = 0; i < C.n; i++) if (ok[cc.codes[i]]) rows.push(i);
    rows.sort((a, b) => rank[cc.codes[a]] - rank[cc.codes[b]] || C.cols.get('Incurred').values[a] - C.cols.get('Incurred').values[b]);
    for (const i of rows.slice(0, 6)) {
      const ref = cc.dict[cc.codes[i]], prow = C.pidx[i], pref = policyRef(prow), st = C.cols.get('Claim Status'), ty = C.cols.get('Claim Type');
      out.push({ g: 'Claims', main: ref, sub: [pref, st && dval(st, st.codes[i]), ty && dval(ty, ty.codes[i])].filter(Boolean).join(' · '), right: money(-C.cols.get('Incurred').values[i]), f: { Policy: eq(pref), Claim: eq(ref) } });
    }
  }
  // brokers, reinsureds, original insureds: filters that select many policies
  for (const [name, g, limit] of [['Broker', 'Brokers', 5], ['Reinsured', 'Reinsured', 5], ['Original Insured', 'Original insureds', 4]]) {
    const c = P.cols.get(name); if (!c) continue;
    const ks = pick(c, limit); if (!ks.length) continue;
    const cnt = countBy(c, ks);
    for (const k of ks) out.push({ g, main: c.dict[k], sub: '', right: `<span class="muted">${cnt.get(k).toLocaleString()} policies</span>`, f: { [name]: eq(c.dict[k]) } });
  }
  out.forEach((o) => { o.q = q; });
  return out;
}
function drawSugg() {
  const el = $('#sugg'), q = $('#q');
  if (!el || !q) return;
  const items = sugg.items;
  if (!items.length) { el.hidden = !q.value.trim(); if (!el.hidden) el.innerHTML = '<div class="empty" style="padding:14px">No policy, claim, broker or reinsured matches - the tables are filtered by the text anyway.</div>'; place(); return; }
  let html = '', g = null;
  items.forEach((it, k) => {
    if (it.g !== g) { g = it.g; html += `<div class="g">${esc(g)}</div>`; }
    html += `<div class="it${k === sugg.hl ? ' hl' : ''}" data-k="${k}"><span class="m">${hilite(it.main, it.q)}</span><span class="s">${esc(it.sub)}</span><span class="r">${it.right}</span></div>`;
  });
  el.innerHTML = html; el.hidden = false; place();
  function place() { const r = q.getBoundingClientRect(); el.style.left = r.left + 'px'; el.style.top = r.bottom + 4 + 'px'; el.style.width = Math.max(r.width, 460) + 'px'; }
}
function wireOmnibox() {
  const q = $('#q'), el = $('#sugg');
  let t = 0;
  q.value = S.search;
  q.addEventListener('input', () => {
    sugg = { items: suggestions(q.value), hl: -1 }; drawSugg();
    clearTimeout(t);
    t = setTimeout(() => { S.search = q.value; renderMain(); refreshSidebarCounts(); save(); }, 160);
  });
  q.addEventListener('focus', () => { if (q.value.trim()) { sugg = { items: suggestions(q.value), hl: -1 }; drawSugg(); } });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && sugg.items.length) { sugg.hl = (sugg.hl + 1) % sugg.items.length; drawSugg(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && sugg.items.length) { sugg.hl = (sugg.hl - 1 + sugg.items.length) % sugg.items.length; drawSugg(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      const it = sugg.items[sugg.hl >= 0 ? sugg.hl : sugg.items.length === 1 ? 0 : -1];
      if (it) jump(it.f); else { hideSugg(); clearTimeout(t); S.search = q.value; if (S.tab !== 'overview') S.tab = 'overview'; renderAll(); }
      e.preventDefault();
    } else if (e.key === 'Escape') { hideSugg(); q.blur(); }
  });
  el.addEventListener('mousedown', (e) => { const it = e.target.closest('.it'); if (it) { e.preventDefault(); jump(sugg.items[+it.dataset.k].f); } });
  document.addEventListener('mousedown', (e) => { if (!el.hidden && e.target !== q && !el.contains(e.target)) hideSugg(); });
}

/* ------------------------------------------------------------- overview */
const AXES = {
  month: { label: 'Month', dim: 'Period', title: 'Posting month',
    parse: (s) => { const m = /^(\d{4})-(\d{2})/.exec(String(s)); return m ? +m[1] * 12 + (+m[2] - 1) : null; },
    fmt: (k) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}` },
  quarter: { label: 'Quarter', dim: 'Quarter', title: 'Posting quarter',
    parse: (s) => { const m = /^(\d{4}) Q(\d)/.exec(String(s)); return m ? +m[1] * 4 + (+m[2] - 1) : null; },
    fmt: (k) => `${Math.floor(k / 4)} Q${(k % 4) + 1}` },
  year: { label: 'Year', dim: 'Year', title: 'Posting year', parse: (v) => (v === null || isNaN(+v) ? null : +v), fmt: String },
  dev: { label: 'Dev year', dim: 'Dev Year', title: 'Development year (since underwriting year)', parse: (v) => (v === null || isNaN(+v) ? null : +v), fmt: String },
};
const axisCache = {};
function axisKeys(axis) {
  if (axisCache[axis]) return axisCache[axis];
  const Q = T.postings, a = AXES[axis], c = Q.cols.get(a.dim), map = c.dict.map((v) => { const k = v === null ? null : a.parse(v); return k === null ? NULLK : k; });
  const out = new Int32Array(Q.n);
  for (let i = 0; i < Q.n; i++) out[i] = map[c.codes[i]];
  return (axisCache[axis] = out);
}

/* Policies in scope: policy-level filters, the free text (policy or any of its claims)
   and - when claim-level filters are active - policies having a matching claim. */
function policyScope() {
  const P = T.policies, C = T.claims, tests = buildTests(P, null, { noSearch: true });
  const claimLevel = Object.entries(S.filters).some(([n, f]) => f.vals.length && C.cols.has(n) && !P.cols.has(n));
  let withClaim = null, hit = null;
  if (claimLevel) { withClaim = new Uint8Array(P.n); for (const i of filtered(C)) withClaim[C.pidx[i]] = 1; }
  const q = S.search.trim().toLowerCase();
  if (q) {
    hit = new Uint8Array(P.n);
    for (const name of SEARCH_DIMS) {
      const c = P.cols.get(name); if (!c) continue;
      const ok = new Uint8Array(c.dict.length); let any = false;
      for (let k = 0; k < c.dict.length; k++) { const d = c.dict[k]; if (d !== null && String(d).toLowerCase().includes(q)) { ok[k] = 1; any = true; } }
      if (any) for (let i = 0; i < P.n; i++) if (ok[c.codes[i]]) hit[i] = 1;
    }
    const cc = C.cols.get('Claim'), ok = new Uint8Array(cc.dict.length);
    for (let k = 0; k < cc.dict.length; k++) { const d = cc.dict[k]; if (d !== null && String(d).toLowerCase().includes(q)) ok[k] = 1; }
    for (let i = 0; i < C.n; i++) if (ok[cc.codes[i]]) hit[C.pidx[i]] = 1;
  }
  const mask = new Uint8Array(P.n); let n = 0;
  outer: for (let i = 0; i < P.n; i++) {
    for (const ts of tests) if (!pass(ts, i)) continue outer;
    if (withClaim && !withClaim[i]) continue;
    if (hit && !hit[i]) continue;
    mask[i] = 1; n++;
  }
  return { mask, n, claimLevel };
}

function overviewData(sc) {
  const Q = T.postings, ax = AXES[S.ov.axis], keys = axisKeys(S.ov.axis), pi = Q.pidx;
  const GG = Q.cols.get('GGWP').values, PB = Q.cols.get('GPrmB').values, PR = Q.cols.get('GPrmR').values, CP = Q.cols.get('GClmP').values, CO = Q.cols.get('GClmO').values;
  const premT = buildTests(Q, CLAIM_LEVEL, { noSearch: true }), clT = buildTests(Q);
  // claim-level filters (status, type, periods...) are resolved on the claims table
  let keep = null;
  if (sc.claimLevel) {
    const C = T.claims, qc = Q.cols.get('Claim'), cc = C.cols.get('Claim'), qmap = new Map(qc.dict.map((v, k) => [v, k])), nq = qc.dict.length;
    keep = new Set();
    for (const j of filtered(C)) { const k = qmap.get(cc.dict[cc.codes[j]]); if (k !== undefined) keep.add(C.pidx[j] * nq + k); }
    keep.nq = nq; keep.codes = qc.codes;
  }
  const tot = { GG: 0, PB: 0, PR: 0, CP: 0, CO: 0 }, byK = new Map();
  let noPeriod = 0;
  const all = (ts, i) => { for (let k = 0; k < ts.length; k++) if (!pass(ts[k], i)) return false; return true; };
  for (let i = 0; i < Q.n; i++) {
    const hasP = GG[i] || PB[i] || PR[i], hasC = CP[i] || CO[i];
    if (!hasP && !hasC) continue;
    const okP = hasP && sc.mask[pi[i]] === 1 && all(premT, i), okC = hasC && all(clT, i) && (!keep || keep.has(pi[i] * keep.nq + keep.codes[i]));
    if (!okP && !okC) continue;
    const k = keys[i]; let e = null;
    if (k !== NULLK) { e = byK.get(k); if (!e) byK.set(k, (e = { GG: 0, PB: 0, PR: 0, CP: 0, CO: 0 })); } else noPeriod++;
    if (okP) { tot.GG += GG[i]; tot.PB += PB[i]; tot.PR += PR[i]; if (e) { e.GG += GG[i]; e.PB += PB[i]; e.PR += PR[i]; } }
    if (okC) { tot.CP += CP[i]; tot.CO += CO[i]; if (e) { e.CP += CP[i]; e.CO += CO[i]; } }
  }
  const ks = [...byK.keys()].sort((a, b) => a - b), xs = [], rows = [];
  if (ks.length) for (let k = ks[0]; k <= ks[ks.length - 1]; k++) { xs.push(ax.fmt(k)); rows.push(byK.get(k) || { GG: 0, PB: 0, PR: 0, CP: 0, CO: 0 }); }
  // finance reference values (policy level)
  const P = T.policies, fv = (n) => (P.cols.get(n) ? P.cols.get(n).values : null), fin = { PB: 0, PIPE: 0, CP: 0, CO: 0 };
  const fPB = fv('GPrmB_F'), fPI = fv('Pipeline_F'), fCP = fv('GClmP_F'), fCO = fv('GClmO_F');
  let finOnly = 0; const src = P.cols.get('Source');
  for (let i = 0; i < P.n; i++) if (sc.mask[i]) {
    if (fPB) fin.PB += fPB[i]; if (fPI) fin.PIPE += fPI[i]; if (fCP) fin.CP += fCP[i]; if (fCO) fin.CO += fCO[i];
    if (src && src.dict[src.codes[i]] === 'Finance only') finOnly++;
  }
  return { tot, rows, xs, noPeriod, fin, finOnly };
}

const amt = (v) => { const [div, d] = scale(), x = Number((v / div).toFixed(d)); return nf(d).format(x === 0 ? 0 : x); };
const cumul = (a) => { let s = 0; return a.map((v) => (s += v)); };
const col = (v) => `var(--s${v})`;

function overview(page) {
  page.className = 'page scroll';
  const P = T.policies, C = T.claims, ov = S.ov, ax = AXES[ov.axis];
  const sc = policyScope(), d = overviewData(sc);
  const cIdx = filtered(C);
  const refsOn = ov.cum && sc.n > 0;
  const T0 = d.tot, F = d.fin;
  const pipe = T0.GG - T0.PB - T0.PR;
  const flip = (a) => a.map((v) => -v);
  const pick = (k) => d.rows.map((r) => r[k]);
  const maybeCum = (a) => (ov.cum ? cumul(a) : a);

  const premSeries = [
    { name: 'Written (GGWP)', color: col(1), vals: maybeCum(pick('GG')) },
    { name: 'Booked (GPrmB)', color: col(2), vals: maybeCum(pick('PB')) },
    { name: 'Pipeline (GGWP − booked − returns)', color: col(3), vals: maybeCum(d.rows.map((r) => r.GG - r.PB - r.PR)) },
  ];
  const premRefs = refsOn ? [
    { name: 'Finance: booked + pipeline', color: col(1), value: F.PB + F.PIPE },
    { name: 'Finance: booked', color: col(2), value: F.PB },
    { name: 'Finance: pipeline', color: col(3), value: F.PIPE },
  ] : [];
  const claimSeries = [
    { name: 'Incurred (paid + case reserves)', color: col(1), vals: maybeCum(d.rows.map((r) => -(r.CP + r.CO))) },
    { name: 'Paid (GClmP)', color: col(2), vals: maybeCum(flip(pick('CP'))) },
    { name: 'Case reserves (GClmO)', color: col(3), vals: maybeCum(flip(pick('CO'))) },
  ];
  const claimRefsOn = refsOn && !sc.claimLevel;
  const claimRefs = claimRefsOn ? [
    { name: 'Finance: incurred', color: col(1), value: -(F.CP + F.CO) },
    { name: 'Finance: paid', color: col(2), value: -F.CP },
    { name: 'Finance: case reserves', color: col(3), value: -F.CO },
  ] : [];

  const f = S.filters, single = f.Policy && f.Policy.vals.length === 1 && !f.Policy.not ? f.Policy.vals[0] : null;
  const chips = Object.entries(f).filter(([, x]) => x.vals.length).map(([name, x]) => `<span class="chip"><span><b>${esc(name)}</b> ${x.not ? '≠' : '='} ${esc(x.vals.slice(0, 3).map((v) => (v === null ? '(blank)' : v)).join(', '))}${x.vals.length > 3 ? ` +${x.vals.length - 3}` : ''}</span><button data-rmf="${esc(name)}" title="Remove">×</button></span>`);
  if (S.search.trim()) chips.push(`<span class="chip"><span><b>Text</b> contains “${esc(S.search.trim())}”</span><button data-rms title="Remove">×</button></span>`);
  S.num.forEach((x, k) => { const c = P.cols.get(x.col) || C.cols.get(x.col); chips.push(`<span class="chip"><span><b>${esc(c ? c.label : x.col)}</b> ${x.op === '!=0' ? '≠ 0' : x.op === '=0' ? '= 0' : x.op.replace('abs>', '|x| >')} ${x.op === '!=0' || x.op === '=0' ? '' : esc(x.x)}</span><button data-rmn="${k}" title="Remove">×</button></span>`); });

  let head;
  if (single && sc.n === 1) {
    const row = polRow.get(single), get = (n) => { const c = P.cols.get(n); return c ? c.dict[c.codes[row]] : null; };
    const attrs = [...P.cols.values()].filter((c) => c.kind === 'dim' && (c.group === 'Actuarial' || c.group === 'Finance')).map((c) => [c.label, c.dict[c.codes[row]]]).filter(([, v]) => v !== null && v !== '');
    head = `<h2>${esc(single)}<span class="tag">${esc(get('Source'))}</span>${f.Claim ? `<span class="tag">claim ${esc(f.Claim.vals.join(', '))}</span>` : ''}</h2>
      <div class="kv kv3">${attrs.map(([k, v]) => `<div><span>${esc(k)}</span><span title="${esc(v)}">${esc(v)}</span></div>`).join('')}</div>`;
  } else {
    head = `<h2>${chips.length ? 'Scope' : 'Whole portfolio'}<span class="muted" style="font-weight:400">${sc.n.toLocaleString()} of ${P.n.toLocaleString()} policies · ${cIdx.length.toLocaleString()} claims</span>${chips.length ? '<span class="r"><button class="iconbtn" id="clr">Clear scope</button></span>' : ''}</h2>`;
  }
  const chipRow = chips.length ? `<div class="chips" style="margin-top:8px">${chips.join('')}</div>` : '';

  const kpi = (label, v, fin, tip) => `<div class="kpi" title="${esc(tip || '')}"><div class="kl">${label}</div><div class="kv0">${amt(v)}</div><div class="kf">${fin === null ? '&nbsp;' : 'Finance ' + amt(fin)}</div></div>`;
  const kpis = `<div class="kpis">
    ${kpi('Written premium', T0.GG, refsOn ? F.PB + F.PIPE : null, 'GGWP. Finance = premium booked + pipeline')}
    ${kpi('Booked premium', T0.PB, refsOn ? F.PB : null, 'GPrmB. Finance = Gross Premium + Premium Portfolio In')}
    ${kpi('Pipeline premium', pipe, refsOn ? F.PIPE : null, 'GGWP − GPrmB − GPrmR. Finance = Pipeline Premium')}
    ${kpi('Paid claims', -T0.CP, claimRefsOn ? -F.CP : null, 'GClmP, shown positive')}
    ${kpi('Case reserves', -T0.CO, claimRefsOn ? -F.CO : null, 'GClmO, shown positive')}
    ${kpi('Incurred', -(T0.CP + T0.CO), claimRefsOn ? -(F.CP + F.CO) : null, 'Paid + case reserves, shown positive')}
  </div>`;

  const seg = Object.entries(AXES).map(([k, a]) => `<button data-axis="${k}" aria-pressed="${ov.axis === k}">${a.label}</button>`).join('');
  const controls = `<div class="toolbar" style="margin-top:2px"><div class="tg"><label>Time axis</label><span class="seg">${seg}</span></div>
    <div class="tg"><label style="display:flex;gap:5px;align-items:center;color:var(--text-2)"><input type="checkbox" id="ovcum" ${ov.cum ? 'checked' : ''}>cumulative</label></div>
    <span class="spacer"></span><span class="muted">${unitLabel()} · ${esc(ax.title)}${d.noPeriod ? ` · ${d.noPeriod.toLocaleString()} postings without a ${ax.label.toLowerCase()} not charted` : ''}</span></div>`;

  const notes = [];
  if (!ov.cum) notes.push('Finance reference lines are shown in the cumulative view (they are totals).');
  else if (sc.claimLevel) notes.push('Finance is policy level: its claim reference lines are hidden while claim-level filters are active.');
  if (d.finOnly) notes.push(`${d.finOnly.toLocaleString()} finance-only ${d.finOnly === 1 ? 'policy is' : 'policies are'} in scope: counted in the Finance reference lines, absent from the actuarial lines.`);

  // largest policies / claims in scope
  const pol = []; for (let i = 0; i < P.n; i++) if (sc.mask[i]) pol.push(i);
  const ggw = P.cols.get('GGWP_A').values, inc = P.cols.get('Incurred_A').values;
  pol.sort((a, b) => ggw[b] - ggw[a]);
  const cl = Array.from(cIdx); const cinc = C.cols.get('Incurred').values;
  cl.sort((a, b) => cinc[a] - cinc[b]);
  const dv = (t, n, i) => { const c = t.cols.get(n); return c ? dval(c, c.codes[i]) : ''; };
  const polTable = single && sc.n === 1 ? '' : `<section class="card"><h2>Largest policies <span class="muted" style="font-weight:400">by written premium · ${Math.min(12, pol.length)} of ${pol.length.toLocaleString()}</span></h2>
    <div class="scrollbox"><table class="t"><thead><tr><th>Policy</th><th>Reinsured</th><th>UWY</th><th class="n">Written</th><th class="n">Incurred</th></tr></thead><tbody>
    ${pol.slice(0, 12).map((i) => `<tr class="click" data-pol="${i}"><td>${esc(policyRef(i))}</td><td>${esc(dv(P, 'Reinsured', i))}</td><td>${esc(dv(P, 'UWY', i))}</td><td class="n">${money(ggw[i])}</td><td class="n">${money(-inc[i])}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No policies in scope</td></tr>'}
    </tbody></table></div></section>`;
  const clTable = `<section class="card"><h2>${single && sc.n === 1 ? 'Claims of this policy' : 'Largest claims'} <span class="muted" style="font-weight:400">by incurred · ${Math.min(single ? 50 : 12, cl.length)} of ${cl.length.toLocaleString()}</span></h2>
    <div class="scrollbox"><table class="t"><thead><tr><th>Claim</th>${single && sc.n === 1 ? '' : '<th>Policy</th>'}<th>Status</th><th>Type</th><th class="n">Paid</th><th class="n">Case res.</th><th class="n">Incurred</th></tr></thead><tbody>
    ${cl.slice(0, single ? 50 : 12).map((i) => `<tr class="click" data-clm="${i}"><td>${esc(dv(C, 'Claim', i))}</td>${single && sc.n === 1 ? '' : `<td>${esc(policyRef(C.pidx[i]))}</td>`}<td>${esc(dv(C, 'Claim Status', i))}</td><td>${esc(dv(C, 'Claim Type', i))}</td><td class="n">${money(-C.cols.get('Paid').values[i])}</td><td class="n">${money(-C.cols.get('Case Reserves').values[i])}</td><td class="n">${money(-cinc[i])}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">No claims in scope</td></tr>`}
    </tbody></table></div></section>`;

  page.innerHTML = `
    <section class="card">${head}${chipRow}</section>
    ${kpis}
    ${controls}
    <div class="charts">
      <section class="card"><h2>Premium booking over time<span class="r"><button class="iconbtn" data-tbl="chP">Table</button></span></h2><div id="chP"></div></section>
      <section class="card"><h2>Claim development over time<span class="r"><button class="iconbtn" data-tbl="chC">Table</button></span></h2><div id="chC"></div></section>
    </div>
    ${notes.length ? `<div class="notes">${notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : ''}
    <div class="${polTable ? 'two-eq' : ''}">${polTable}${clTable}</div>
    <div class="muted" style="font-size:12px">Losses (paid, case reserves, incurred) are shown as positive amounts here; the Policies / Claims / Postings tabs keep the sign of the source data.
      Actuarial lines come from the posting measures (GGWP, GPrmB, GClmP, GClmO) by posting period; finance has no time dimension, so it appears as end-of-period totals.</div>`;

  const spec = (series, refs, label) => ({ xs: d.xs, xTitle: ax.label, series, refs, fmt: amt, ariaLabel: label, empty: 'No postings in scope for this chart.' });
  const hP = $('#chP'), hC = $('#chC');
  hP._mode = S._tblP ? 'table' : 'chart'; hC._mode = S._tblC ? 'table' : 'chart';
  lineChart(hP, spec(premSeries, premRefs, 'Cumulative premium written, booked and in pipeline over time, with finance totals'));
  lineChart(hC, spec(claimSeries, claimRefs, 'Claim development: incurred, paid and case reserves over time, with finance totals'));

  // wiring
  page.querySelectorAll('[data-axis]').forEach((b) => b.onclick = () => { pushHist(); S.ov.axis = b.dataset.axis; renderMain(); save(); });
  $('#ovcum').onchange = (e) => { pushHist(); S.ov.cum = e.target.checked; renderMain(); save(); };
  page.querySelectorAll('[data-tbl]').forEach((b) => b.onclick = () => {
    const h = $('#' + b.dataset.tbl); h._mode = h._mode === 'table' ? 'chart' : 'table';
    S[b.dataset.tbl === 'chP' ? '_tblP' : '_tblC'] = h._mode === 'table';
    b.textContent = h._mode === 'table' ? 'Chart' : 'Table'; h._draw();
  });
  page.querySelectorAll('[data-tbl]').forEach((b) => { if ($('#' + b.dataset.tbl)._mode === 'table') b.textContent = 'Chart'; });
  page.querySelectorAll('[data-rmf]').forEach((b) => b.onclick = () => { pushHist(); delete S.filters[b.dataset.rmf]; update(); });
  page.querySelectorAll('[data-rmn]').forEach((b) => b.onclick = () => { pushHist(); S.num.splice(+b.dataset.rmn, 1); update(); });
  const rs = page.querySelector('[data-rms]'); if (rs) rs.onclick = () => { pushHist(); S.search = ''; const q = $('#q'); if (q) q.value = ''; update(); };
  const clr = $('#clr'); if (clr) clr.onclick = () => { pushHist(); S.filters = {}; S.num = []; S.search = ''; const q = $('#q'); if (q) q.value = ''; update(); };
  page.querySelectorAll('[data-pol]').forEach((tr) => tr.onclick = () => openPolicy(+tr.dataset.pol));
  page.querySelectorAll('[data-clm]').forEach((tr) => tr.onclick = () => { const i = +tr.dataset.clm; openPolicy(C.pidx[i], C, i); });
}

boot();

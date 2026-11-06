'use strict';
/* =====================================================================
   Shared core of the two browser tools (reconciliation + explorer):
   data decoding, filters, aggregation, virtual grid, pivot explorer.
   Each tool defines `APP` (tabs, presets, render hooks) and calls boot().
   ===================================================================== */
const RH = 26;
const SEARCH_DIMS = ['Policy', 'Claim', 'Reinsured', 'Original Insured', 'Broker'];
const GROUP_ORDER = ['Key', 'Reconciliation', 'Actuarial', 'Finance', 'Claim', 'Posting', 'Amounts', 'Delta', 'Counts',
  'Policy · Reconciliation', 'Policy · Actuarial', 'Policy · Finance', 'Finance (all columns)'];
const TABLE_LABEL = { policies: 'policies', claims: 'claims', postings: 'postings' };
let APP = null;   // set by the tool before boot()

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const vk = (x) => (x === null || x === undefined ? '\u0000' : String(x));
const gi = (g) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? 99 : i; };

let D = null, META = null, LABELS = {}, RM = [], MAIN = [];
const T = {};
let polRow = null;     // policy ref -> row in T.policies
let postByPol = null;  // pidx -> posting rows
const BASE_VIEW = { mode: 'group', groupBy: [], listCols: [], colDim: null, cum: false, measures: [], sort: null };

/* --------------------------------------------------------------- state */
const S = {
  tab: '', units: '', tol: 1, sidebar: true,
  filters: {}, num: [], search: '',
  views: {}, open: [],
  recon: { focus: 'any', byDim: 'Reserving LOB', showAll: false, sort: null },
  ov: { axis: 'month', cum: true },
};

function snapshot() { return clone({ tab: S.tab, filters: S.filters, num: S.num, search: S.search, views: S.views, recon: S.recon, ov: S.ov }); }

/* ------------------------------------------------- history + shareable URL
   Every navigation step (pushHist, called before a change) becomes a browser history entry that
   carries the full view state, and the current scope is mirrored in the URL hash, e.g.
   explorer.html#f.Reinsured=ACHEEL+SAS&tab=overview. So the browser's Back / Forward buttons, the
   in-page Back button and copy-pasting the address all work. */
let hi = 0;   // index of the current history entry (0 = first page of this visit)
function encodeHash(sn) {
  const p = new URLSearchParams();
  if (sn.tab && sn.tab !== APP.tabs[0][0]) p.set('tab', sn.tab);
  for (const [name, f] of Object.entries(sn.filters || {})) {
    if (!f.vals.length) continue;
    const one = f.vals.length === 1 && typeof f.vals[0] === 'string' && !f.vals[0].startsWith('[');
    p.set((f.not ? 'x.' : 'f.') + name, one ? f.vals[0] : JSON.stringify(f.vals));
  }
  if (sn.search && sn.search.trim()) p.set('q', sn.search);
  if (sn.num && sn.num.length) p.set('num', JSON.stringify(sn.num));
  if (sn.ov && sn.ov.axis && sn.ov.axis !== 'month') p.set('axis', sn.ov.axis);
  if (sn.ov && sn.ov.cum === false) p.set('cum', '0');
  return p.toString();
}
function decodeHash(h) {
  h = (h || '').replace(/^#/, '');
  if (!h.includes('=')) return null;
  const p = new URLSearchParams(h), filters = {};
  for (const [k, v] of p) {
    const m = /^(f|x)\.(.+)$/.exec(k), legacy = { policy: 'Policy', broker: 'Broker', reinsured: 'Reinsured' }[k];
    if (!m && !legacy) continue;
    let vals = [v];
    if (v.startsWith('[')) { try { const a = JSON.parse(v); if (Array.isArray(a)) vals = a; } catch (e) { /* plain text */ } }
    filters[m ? m[2] : legacy] = { vals, not: m ? m[1] === 'x' : false };
  }
  let num = []; try { num = JSON.parse(p.get('num') || '[]'); } catch (e) { /* ignore */ }
  const tab = APP.tabs.some(([k]) => k === p.get('tab')) ? p.get('tab') : APP.tabs[0][0];
  return { tab, filters, num: Array.isArray(num) ? num : [], search: p.get('q') || '', ov: { axis: p.get('axis') || 'month', cum: p.get('cum') !== '0' } };
}
const urlFor = (sn) => { const h = encodeHash(sn); return location.pathname + location.search + (h ? '#' + h : ''); };
function putState(replace) {
  const sn = snapshot();
  try { history[replace ? 'replaceState' : 'pushState']({ ...sn, i: hi }, '', urlFor(sn)); } catch (e) { /* e.g. history API unavailable */ }
}
let urlTimer = 0;
function syncUrl() { clearTimeout(urlTimer); urlTimer = setTimeout(() => putState(true), 120); }
function pushHist() { clearTimeout(urlTimer); putState(true); hi++; putState(false); }
function back() { if (hi > 0) history.back(); }
window.addEventListener('popstate', (e) => {
  clearTimeout(urlTimer);
  const st = e.state;
  if (st && st.filters !== undefined) { const { i, ...rest } = st; hi = i || 0; Object.assign(S, clone(rest)); }
  else { const d = decodeHash(location.hash); if (d) Object.assign(S, d); }
  if (!APP.tabs.some(([k]) => k === S.tab)) S.tab = APP.tabs[0][0];
  renderAll();
});
let saveTimer = 0;
function save() {
  syncUrl();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(APP.lsKey, JSON.stringify({ ...snapshot(), units: S.units, tol: S.tol, sidebar: S.sidebar, open: S.open, built: META.built_at })); } catch (e) { /* storage unavailable */ }
  }, 200);
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(APP.lsKey) || 'null');
    if (!s) return;
    // Scope (tab, filters, search) lives in the URL; only layout preferences are remembered here.
    for (const k of ['units', 'tol', 'sidebar', 'views', 'recon', 'ov', 'open']) if (s[k] !== undefined) S[k] = s[k];
  } catch (e) { /* ignore */ }
}
function view(t) {
  if (!S.views[t]) S.views[t] = { ...clone(BASE_VIEW), ...clone(APP.presets[t][0].view) };
  return S.views[t];
}

/* -------------------------------------------------------------- decode */
function addCol(t, c) { t.cols.set(c.name, c); }
function buildTable(name, spec) {
  const t = { name, n: spec.n, cols: new Map(), pidx: null };
  for (const c of spec.columns) {
    if (c.kind === 'ref') { t.pidx = Int32Array.from(c.values); continue; }
    if (c.kind === 'dim') {
      addCol(t, { name: c.name, label: c.label, kind: 'dim', group: c.group, numeric: c.numeric, dict: c.dict, codes: Int32Array.from(c.codes) });
    } else {
      const v = new Float64Array(spec.n);
      if (c.sparse) { const [ix, vs] = c.sparse; for (let k = 0; k < ix.length; k++) v[ix[k]] = vs[k]; } else v.set(c.values);
      addCol(t, { name: c.name, label: c.label, kind: 'num', group: c.group, src: c.src, values: v });
    }
  }
  return t;
}
function attachPolicy(t, P) {
  const pi = t.pidx;
  for (const pc of P.cols.values()) {
    if (pc.kind !== 'dim' || t.cols.has(pc.name)) continue;
    const codes = new Int32Array(t.n), pcodes = pc.codes;
    for (let i = 0; i < t.n; i++) codes[i] = pcodes[pi[i]];
    addCol(t, { ...pc, codes, group: pc.name === 'Policy' ? 'Key' : 'Policy · ' + pc.group });
  }
}
function countCols(t, rowsLabel) {
  addCol(t, { name: '#rows', label: rowsLabel, kind: 'count', group: 'Counts' });
  if (t.pidx) {
    const pi = t.pidx;
    addCol(t, { name: '#pol', label: '# policies', kind: 'distinct', group: 'Counts', keyOf: (i) => pi[i] });
  }
}
function decode(data) {
  D = data; META = data.meta; LABELS = data.measureLabels || {};
  RM = META.recon_measures || []; MAIN = RM.filter((m) => m.key !== 'Incurred');
  const P = T.policies = buildTable('policies', data.tables.policies);
  countCols(P, '# policies');
  polRow = new Map(); const pc = P.cols.get('Policy');
  for (let i = 0; i < P.n; i++) polRow.set(pc.dict[pc.codes[i]], i);

  if (!data.tables.claims) return;
  const C = T.claims = buildTable('claims', data.tables.claims);
  attachPolicy(C, P); countCols(C, '# claims');

  const Q = T.postings = buildTable('postings', data.tables.postings);
  attachPolicy(Q, P); countCols(Q, '# postings');
  const mc = Q.cols.get('Measure'), val = Q.cols.get('_value').values;
  mc.labels = LABELS;
  Q.cols.get('_value').label = 'Amount (raw, any measure)';
  Q.cols.get('_value').group = 'Amounts';
  const byCode = {};
  for (const code of ['GClmP', 'GClmO', 'GPrmB', 'GGWP', 'GPrmR', 'GBrok', 'GDed']) {
    const k = mc.dict.indexOf(code), arr = new Float64Array(Q.n);
    if (k >= 0) for (let i = 0; i < Q.n; i++) if (mc.codes[i] === k) arr[i] = val[i];
    byCode[code] = arr;
    addCol(Q, { name: code, label: `${LABELS[code] || code} (${code})`, kind: 'num', group: 'Amounts', values: arr });
  }
  const inc = new Float64Array(Q.n), pipe = new Float64Array(Q.n);
  for (let i = 0; i < Q.n; i++) { inc[i] = byCode.GClmP[i] + byCode.GClmO[i]; pipe[i] = byCode.GGWP[i] - byCode.GPrmB[i] - byCode.GPrmR[i]; }
  addCol(Q, { name: 'Incurred', label: 'Incurred (Paid + OS)', kind: 'num', group: 'Amounts', values: inc });
  addCol(Q, { name: 'Pipeline', label: 'Pipeline (GGWP − GPrmB − GPrmR)', kind: 'num', group: 'Amounts', values: pipe });
  const cl = Q.cols.get('Claim'), cn = cl.dict.length, pi = Q.pidx;
  addCol(Q, { name: '#clm', label: '# claims', kind: 'distinct', group: 'Counts', keyOf: (i) => (cl.dict[cl.codes[i]] === null ? null : pi[i] * cn + cl.codes[i]) });
}

/* ---------------------------------------------------------- formatting */
const NF = {};
const nf = (d) => (NF[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
function scale() { return S.units === 'm' ? [1e6, 2] : S.units === 'k' ? [1e3, 1] : [1, 0]; }
function money(v) {
  if (!v || Math.abs(v) < 0.005) return '<span class="z">–</span>';
  const [div, d] = scale();
  return nf(d).format(v / div);
}
function count(v) { return v ? nf(0).format(v) : '<span class="z">–</span>'; }
function fmtCol(c, v) { return c.kind === 'num' ? money(v) : count(v); }
function dval(c, code) {
  const v = c.dict[code];
  if (v === null || v === undefined) return '(blank)';
  if (c.labels && c.labels[v]) return `${v} · ${c.labels[v]}`;
  return String(v);
}
function unitLabel() { return S.units === 'm' ? 'USD m' : S.units === 'k' ? 'USD k' : 'USD'; }

/* ----------------------------------------------------------- filtering */
function buildTests(t, skip, opts = {}) {
  const tests = [], skipSet = new Set(Array.isArray(skip) ? skip : skip ? [skip] : []);
  for (const [name, f] of Object.entries(S.filters)) {
    if (skipSet.has(name)) continue;
    const c = t.cols.get(name);
    if (!c || c.kind !== 'dim' || !f.vals.length) continue;
    const want = new Set(f.vals.map(vk)), ok = new Uint8Array(c.dict.length);
    for (let k = 0; k < c.dict.length; k++) { const hit = want.has(vk(c.dict[k])); ok[k] = (f.not ? !hit : hit) ? 1 : 0; }
    tests.push({ kind: 'dim', codes: c.codes, ok });
  }
  for (const f of S.num) {
    const c = t.cols.get(f.col);
    if (!c || c.kind !== 'num') continue;
    tests.push({ kind: 'num', vals: c.values, op: f.op, x: Number(f.x) || 0 });
  }
  const q = opts.noSearch ? '' : S.search.trim().toLowerCase();
  if (q) {
    const parts = [];
    for (const name of SEARCH_DIMS) {
      const c = t.cols.get(name); if (!c) continue;
      const ok = new Uint8Array(c.dict.length); let any = false;
      for (let k = 0; k < c.dict.length; k++) { const d = c.dict[k]; if (d !== null && String(d).toLowerCase().includes(q)) { ok[k] = 1; any = true; } }
      if (any) parts.push({ codes: c.codes, ok });
    }
    tests.push({ kind: 'search', parts });
  }
  return tests;
}
function pass(ts, i) {
  if (ts.kind === 'dim') return ts.ok[ts.codes[i]] === 1;
  if (ts.kind === 'num') {
    const v = ts.vals[i];
    switch (ts.op) {
      case '>': return v > ts.x; case '<': return v < ts.x; case '>=': return v >= ts.x; case '<=': return v <= ts.x;
      case 'abs>': return Math.abs(v) > ts.x; case '!=0': return Math.abs(v) > 0.005; case '=0': return Math.abs(v) <= 0.005;
    }
    return true;
  }
  for (const p of ts.parts) if (p.ok[p.codes[i]]) return true;
  return false;
}
const idxCache = new Map();
function filtered(t) {
  const key = t.name + JSON.stringify([S.filters, S.num, S.search]);
  if (idxCache.has(key)) return idxCache.get(key);
  const tests = buildTests(t), out = new Int32Array(t.n); let m = 0;
  outer: for (let i = 0; i < t.n; i++) { for (const ts of tests) if (!pass(ts, i)) continue outer; out[m++] = i; }
  const res = out.subarray(0, m);
  if (idxCache.size > 30) idxCache.clear();
  idxCache.set(key, res);
  return res;
}
function facetCounts(t, name) {
  const c = t.cols.get(name), tests = buildTests(t, name), cnt = new Int32Array(c.dict.length);
  outer: for (let i = 0; i < t.n; i++) { for (const ts of tests) if (!pass(ts, i)) continue outer; cnt[c.codes[i]]++; }
  return cnt;
}

/* ---------------------------------------------------------- aggregation */
function aggregate(t, idx, gb, ms, cd) {
  const M = ms.length;
  const mult = []; let prod = 1;
  for (let k = gb.length - 1; k >= 0; k--) { mult[k] = prod; prod *= gb[k].dict.length; }
  const numeric = prod < 2 ** 52;
  const newAcc = () => ({ s: new Float64Array(M), sets: ms.map((m) => (m.kind === 'distinct' ? new Set() : null)), any: false });
  const add = (a, i) => {
    a.any = true;
    for (let k = 0; k < M; k++) {
      const m = ms[k];
      if (m.kind === 'num') a.s[k] += m.values[i];
      else if (m.kind === 'count') a.s[k] += 1;
      else { const key = m.keyOf(i); if (key !== null) a.sets[k].add(key); }
    }
  };
  const fin = (a) => { for (let k = 0; k < M; k++) if (a.sets[k]) a.s[k] = a.sets[k].size; a.sets = null; };
  const groups = new Map(), total = newAcc(), colTot = cd ? new Map() : null;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    let key;
    if (numeric) { key = 0; for (let k = 0; k < gb.length; k++) key += gb[k].codes[i] * mult[k]; }
    else { key = ''; for (let k = 0; k < gb.length; k++) key += gb[k].codes[i] + '|'; }
    let g = groups.get(key);
    if (!g) { g = { codes: gb.map((c) => c.codes[i]), acc: newAcc(), cells: cd ? new Map() : null }; groups.set(key, g); }
    add(g.acc, i); add(total, i);
    if (cd) {
      const cc = cd.codes[i];
      let cell = g.cells.get(cc); if (!cell) g.cells.set(cc, (cell = newAcc()));
      add(cell, i);
      let ct = colTot.get(cc); if (!ct) colTot.set(cc, (ct = newAcc()));
      add(ct, i);
    }
  }
  const rows = [...groups.values()];
  for (const g of rows) { fin(g.acc); if (g.cells) for (const c of g.cells.values()) fin(c); }
  fin(total); if (colTot) for (const c of colTot.values()) fin(c);
  return { rows, total, colTot };
}

/* ----------------------------------------------------------------- grid */
class Grid {
  constructor(host, opts = {}) {
    this.host = host; this.opts = opts;
    host.innerHTML = '<div class="gw"><div class="gh"></div><div class="gt"></div><div class="gb"></div></div>';
    this.wrap = host.firstChild; this.head = this.wrap.children[0]; this.tot = this.wrap.children[1]; this.body = this.wrap.children[2];
    this.rows = []; this.cols = []; this.raf = 0;
    this.wrap.addEventListener('scroll', () => { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.paint()); });
    this.head.addEventListener('click', (e) => { const el = e.target.closest('[data-c]'); if (el && this.onSort) this.onSort(this.cols[+el.dataset.c].id); });
    this.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-c]'); if (!el) return;
      const col = this.cols[+el.dataset.c], row = this.rows[+el.parentNode.dataset.r];
      if (col.onClick) col.onClick(row, e);
    });
  }
  set({ cols, rows, total, sort, onSort, keepScroll }) {
    this.cols = cols; this.rows = rows; this.onSort = onSort;
    const widths = cols.map((c) => c.w + 'px').join(' ');
    this.wrap.style.setProperty('--cols', widths);
    this.head.innerHTML = cols.map((c, k) => {
      const s = sort && sort.id === c.id ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return `<div class="c${c.num ? ' n' : ''}${s ? ' sorted' : ''}" data-c="${k}" title="${esc(c.title || c.label)}">${esc(c.label)}${s}</div>`;
    }).join('');
    this.tot.style.display = total ? '' : 'none';
    if (total) this.tot.innerHTML = cols.map((c, k) => `<div class="c${c.num ? ' n' : ''}">${k === 0 ? total.label : (c.total ?? '')}</div>`).join('');
    this.body.style.height = rows.length * RH + 'px';
    if (!keepScroll) this.wrap.scrollTop = 0;
    this.last = null;
    this.paint();
  }
  paint() {
    const top = this.wrap.scrollTop, h = this.wrap.clientHeight || 600;
    const a = Math.max(0, Math.floor(top / RH) - 8), b = Math.min(this.rows.length, Math.ceil((top + h) / RH) + 8);
    if (this.last && this.last[0] === a && this.last[1] === b) return;
    this.last = [a, b];
    let html = '';
    for (let r = a; r < b; r++) {
      const row = this.rows[r];
      html += `<div class="gr" data-r="${r}" style="top:${r * RH}px">`;
      for (let k = 0; k < this.cols.length; k++) {
        const c = this.cols[k], cls = c.cls ? c.cls(row) : '';
        html += `<div class="c${c.num ? ' n' : ''}${c.onClick ? (c.link ? ' link' : ' drill') : ''}${cls ? ' ' + cls : ''}" data-c="${k}">${c.html(row)}</div>`;
      }
      html += '</div>';
    }
    if (!this.rows.length) html = '<div class="empty">No rows match the current filters.</div>';
    this.body.innerHTML = html;
  }
  csv(name, total) {
    const q = (s) => { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [this.cols.map((c) => q(c.label)).join(',')];
    for (const row of this.rows) lines.push(this.cols.map((c) => q(c.raw(row))).join(','));
    if (total) lines.push(this.cols.map((c, k) => q(k === 0 ? 'Total' : c.totalRaw ?? '')).join(','));
    download(name, lines.join('\r\n'));
  }
}
function download(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function dimWidth(c, sampleCodes) {
  let len = c.label.length;
  for (let k = 0; k < Math.min(sampleCodes.length, 300); k++) len = Math.max(len, dval(c, sampleCodes[k]).length);
  return Math.max(70, Math.min(300, Math.round(len * 7.2 + 22)));
}
function numWidth(label) { return Math.max(104, Math.min(190, Math.round(label.length * 6.6 + 24))); }
function sortRows(rows, cols, sort) {
  if (!sort) return rows;
  const c = cols.find((x) => x.id === sort.id); if (!c) return rows;
  const dir = sort.dir, key = c.sortKey || c.raw;
  return rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
}

/* --------------------------------------------------------------- picker */
let pk = null;
function closePicker() { if (pk) { pk.el.remove(); pk = null; } }
function openPicker(anchor, { items, selected = [], multi = false, onPick, placeholder = 'Search…' }) {
  closePicker();
  const el = document.createElement('div'); el.className = 'pk';
  el.innerHTML = `<input type="text" placeholder="${esc(placeholder)}"><div class="list"></div>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.min(r.left, window.innerWidth - 330) + 'px';
  el.style.top = Math.min(r.bottom + 4, window.innerHeight - 430) + 'px';
  const input = el.firstChild, list = el.lastChild, sel = new Set(selected);
  let shown = [], hl = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((it) => !q || it.label.toLowerCase().includes(q) || String(it.value).toLowerCase().includes(q));
    hl = Math.min(hl, Math.max(0, shown.length - 1));
    let html = '', g = null;
    shown.forEach((it, k) => {
      if (it.group !== g) { g = it.group; html += `<div class="g">${esc(g || '')}</div>`; }
      html += `<div class="it${k === hl ? ' hl' : ''}" data-k="${k}"><span class="ck">${sel.has(it.value) ? '✓' : ''}</span><span>${esc(it.label)}</span></div>`;
    });
    list.innerHTML = html || '<div class="empty">No match</div>';
  };
  const pick = (k) => {
    const it = shown[k]; if (!it) return;
    if (multi) { sel.has(it.value) ? sel.delete(it.value) : sel.add(it.value); }
    onPick(it.value);
    if (multi) draw(); else closePicker();
  };
  list.addEventListener('mousedown', (e) => { const it = e.target.closest('.it'); if (it) { e.preventDefault(); pick(+it.dataset.k); } });
  input.addEventListener('input', () => { hl = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(hl); e.preventDefault(); }
    else if (e.key === 'Escape') closePicker();
  });
  pk = { el, anchor };
  draw(); input.focus();
}
document.addEventListener('mousedown', (e) => { if (pk && !pk.el.contains(e.target) && !pk.anchor.contains(e.target)) closePicker(); });

function dimItems(t, exclude = []) {
  return [...t.cols.values()].filter((c) => c.kind === 'dim' && !exclude.includes(c.name))
    .sort((a, b) => gi(a.group) - gi(b.group)).map((c) => ({ value: c.name, label: c.label, group: c.group }));
}
function measureItems(t, listMode) {
  return [...t.cols.values()].filter((c) => c.kind !== 'dim' && (!listMode || c.kind === 'num'))
    .sort((a, b) => gi(a.group) - gi(b.group)).map((c) => ({ value: c.name, label: c.label, group: c.group }));
}

/* ------------------------------------------------------------- sidebar */
function curTable() { return T[APP.tableOf(S.tab)]; }
function renderSidebar() {
  const t = curTable(), sb = $('#sb');
  const chips = Object.entries(S.filters).filter(([, f]) => f.vals.length).map(([name, f]) => {
    const c = t.cols.get(name), off = !c;
    const shown = f.vals.slice(0, 3).map((v) => (v === null ? '(blank)' : c && c.labels && c.labels[v] ? v : v)).join(', ') + (f.vals.length > 3 ? ` +${f.vals.length - 3}` : '');
    return `<span class="chip${off ? ' off' : ''}" title="${off ? 'Not available in this table - ignored here' : esc(name + (f.not ? ' ≠ ' : ' = ') + f.vals.join(', '))}"><span><b>${esc(name)}</b> ${f.not ? '≠' : '='} ${esc(shown)}</span><button data-rmf="${esc(name)}" title="Remove">×</button></span>`;
  });
  const OPS = { 'abs>': '|x| >', '>': '>', '<': '<', '>=': '≥', '<=': '≤', '!=0': '≠ 0', '=0': '= 0' };
  const numEd = S.num.map((f, k) => {
    const c = t.cols.get(f.col);
    return `<div class="numf${c ? '' : ' chip off'}" title="${c ? '' : 'Not available in this table - ignored here'}"><span title="${esc(c ? c.label : f.col)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c ? c.label : f.col)}</span>
      <select data-numop="${k}">${Object.entries(OPS).map(([o, l]) => `<option value="${o}" ${o === f.op ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="number" step="any" data-numx="${k}" value="${esc(f.x)}" ${f.op === '!=0' || f.op === '=0' ? 'disabled' : ''}>
      <span class="chip" style="padding:0;border:0;background:none"><button data-rmn="${k}" title="Remove">×</button></span></div>`;
  }).join('');
  let html = APP.omnibox ? '' : `<input class="search" id="q" type="search" placeholder="Search policy, claim, reinsured…  ( / )" value="${esc(S.search)}">`;
  html += `<div class="sbh" style="margin-top:${APP.omnibox ? 2 : 14}px">Filters <button id="clearf">Clear all</button></div><div class="chips">${chips.join('') || '<span class="muted">None - showing everything</span>'}</div>`;
  html += `<div class="sbh">Amount filters <button id="addnum">+ Add</button></div>${numEd}`;
  html += `<div class="sbh">Dimensions <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">${TABLE_LABEL[t.name]}</span></div>`;
  const byGroup = new Map();
  for (const c of t.cols.values()) if (c.kind === 'dim') { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); }
  const groups = [...byGroup.keys()].sort((a, b) => gi(a) - gi(b));
  for (const g of groups) {
    html += `<div class="dgroup"><div>${esc(g)}</div>`;
    for (const c of byGroup.get(g)) {
      const f = S.filters[c.name], open = S.open.includes(c.name);
      html += `<button class="dim" data-dim="${esc(c.name)}"><span class="car">${open ? '▾' : '▸'}</span><span class="nm">${esc(c.label)}</span>${f && f.vals.length ? `<span class="badge">${f.not ? '≠' : ''}${f.vals.length}</span>` : ''}<span class="muted">${c.dict.length.toLocaleString()}</span></button>`;
      if (open) html += facetHtml(t, c);
    }
    html += '</div>';
  }
  sb.innerHTML = html;
}
function facetHtml(t, c) {
  const f = S.filters[c.name] || { vals: [], not: false }, sel = new Set(f.vals.map(vk));
  const cnt = facetCounts(t, c.name), q = (S.fq && S.fq[c.name]) || '';
  let ks = [];
  for (let k = 0; k < c.dict.length; k++) if (!q || dval(c, k).toLowerCase().includes(q.toLowerCase())) ks.push(k);
  const many = ks.length > 150;
  if (many || c.dict.length > 30) ks.sort((a, b) => (sel.has(vk(c.dict[b])) - sel.has(vk(c.dict[a]))) || cnt[b] - cnt[a] || a - b);
  const shown = ks.slice(0, 150);
  let html = `<div class="facet" data-facet="${esc(c.name)}">`;
  if (c.dict.length > 8) html += `<input type="text" data-fq="${esc(c.name)}" placeholder="Filter values…" value="${esc(q)}">`;
  html += `<div class="opts"><button data-fall="${esc(c.name)}">All shown</button><button data-fnone="${esc(c.name)}">None</button><label title="Exclude the selected values instead of keeping them"><input type="checkbox" data-fnot="${esc(c.name)}" ${f.not ? 'checked' : ''}>exclude</label></div>`;
  for (const k of shown) {
    const v = c.dict[k];
    html += `<label class="fv${cnt[k] ? '' : ' zero'}"><input type="checkbox" data-fv="${esc(c.name)}" data-k="${k}" ${sel.has(vk(v)) ? 'checked' : ''}><span class="l" title="${esc(dval(c, k))}">${esc(dval(c, k))}</span><span class="c">${cnt[k].toLocaleString()}</span></label>`;
  }
  if (ks.length > shown.length) html += `<div class="fmore">${(ks.length - shown.length).toLocaleString()} more - type to narrow</div>`;
  return html + '</div>';
}
function setFilter(name, vals, not) {
  if (!vals.length) delete S.filters[name];
  else S.filters[name] = { vals, not: !!not };
}
function addFilterValue(name, value, replace = true) {
  pushHist();
  const f = S.filters[name];
  if (replace || !f || f.not) setFilter(name, [value], false);
  else if (!f.vals.map(vk).includes(vk(value))) f.vals.push(value);
}
function wireSidebar() {
  const sb = $('#sb');
  let qt = 0;
  sb.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'q') { clearTimeout(qt); qt = setTimeout(() => { S.search = el.value; renderMain(); refreshSidebarCounts(); save(); }, 180); }
    else if (el.dataset.fq !== undefined) { S.fq = S.fq || {}; S.fq[el.dataset.fq] = el.value; refreshSidebarCounts(); }
    else if (el.dataset.numx !== undefined) { clearTimeout(qt); qt = setTimeout(() => { S.num[+el.dataset.numx].x = el.value; update(); }, 300); }
  });
  sb.addEventListener('change', (e) => {
    const el = e.target, t = curTable();
    if (el.dataset.fv !== undefined) {
      pushHist();
      const name = el.dataset.fv, c = t.cols.get(name), v = c.dict[+el.dataset.k];
      const f = S.filters[name] || { vals: [], not: false };
      let vals = f.vals.filter((x) => vk(x) !== vk(v));
      if (el.checked) vals.push(v);
      setFilter(name, vals, f.not);
      update();
    } else if (el.dataset.fnot !== undefined) {
      pushHist();
      const f = S.filters[el.dataset.fnot]; if (f) f.not = el.checked; else S.filters[el.dataset.fnot] = { vals: [], not: el.checked };
      update();
    } else if (el.dataset.numop !== undefined) {
      pushHist(); S.num[+el.dataset.numop].op = el.value; update();
    }
  });
  sb.addEventListener('click', (e) => {
    const el = e.target.closest('button'); if (!el) return;
    const t = curTable();
    if (el.dataset.dim !== undefined) {
      const n = el.dataset.dim, i = S.open.indexOf(n);
      if (i >= 0) S.open.splice(i, 1); else S.open.push(n);
      renderSidebar(); save();
    } else if (el.dataset.rmf !== undefined) { pushHist(); delete S.filters[el.dataset.rmf]; update(); }
    else if (el.dataset.rmn !== undefined) { pushHist(); S.num.splice(+el.dataset.rmn, 1); update(); }
    else if (el.id === 'clearf') { pushHist(); S.filters = {}; S.num = []; S.search = ''; update(); }
    else if (el.id === 'addnum') {
      openPicker(el, {
        items: measureItems(t, true), placeholder: 'Filter rows on amount…',
        onPick: (col) => { pushHist(); S.num.push({ col, op: 'abs>', x: S.tol }); update(); },
      });
    } else if (el.dataset.fall !== undefined) {
      pushHist();
      const name = el.dataset.fall, c = t.cols.get(name), q = ((S.fq && S.fq[name]) || '').toLowerCase();
      const vals = []; for (let k = 0; k < c.dict.length; k++) if (!q || dval(c, k).toLowerCase().includes(q)) vals.push(c.dict[k]);
      setFilter(name, vals, S.filters[name]?.not); update();
    } else if (el.dataset.fnone !== undefined) { pushHist(); delete S.filters[el.dataset.fnone]; update(); }
  });
}
function refreshSidebarCounts() {
  const sb = $('#sb'), y = sb.scrollTop, a = document.activeElement;
  const sel = a && sb.contains(a) ? (a.id === 'q' ? '#q' : a.dataset.fq !== undefined ? `[data-fq="${CSS.escape(a.dataset.fq)}"]` : a.dataset.numx !== undefined ? `[data-numx="${a.dataset.numx}"]` : null) : null;
  const caret = sel && a.selectionStart !== undefined ? [a.selectionStart, a.selectionEnd] : null;
  renderSidebar();
  sb.scrollTop = y;
  if (sel) { const el = sb.querySelector(sel); if (el) { el.focus(); try { if (caret) el.setSelectionRange(...caret); } catch (e) { /* number inputs */ } } }
}
/* ------------------------------------------------------------ explorer */
const grids = {};
function explorer(tname) {
  const t = T[tname], v = view(tname), page = $('#main');
  const listMode = v.mode === 'list';
  const chipList = listMode ? v.listCols : v.groupBy;
  const chip = (name, kind, k) => { const c = t.cols.get(name); return `<span class="chip" draggable="true" data-chip="${kind}" data-k="${k}"><span>${esc(c ? c.label : name)}</span><button data-rm="${kind}" data-k="${k}">×</button></span>`; };
  const cd = v.colDim && t.cols.get(v.colDim);
  page.innerHTML = `
    <div class="toolbar">
      <div class="tg"><span class="seg"><button data-mode="group" aria-pressed="${!listMode}">Aggregate</button><button data-mode="list" aria-pressed="${listMode}">List rows</button></span></div>
      <div class="tg"><label>${listMode ? 'Columns' : 'Rows'}</label>${chipList.map((n, k) => chip(n, 'rows', k)).join('')}<button class="add" id="addrow">+ ${listMode ? 'column' : 'group by'}</button></div>
      ${listMode ? '' : `<div class="tg"><label>Across</label><button class="add" id="setcol">${cd ? esc(cd.label) + ' ▾' : '+ column dimension'}</button>${cd ? `<button class="chip" id="clrcol" title="Remove column dimension" style="padding:2px 8px">×</button><label style="display:flex;gap:4px;align-items:center;color:var(--text-2)"><input type="checkbox" id="cum" ${v.cum ? 'checked' : ''}>cumulative</label>` : ''}</div>`}
      <div class="tg"><label>Values</label>${v.measures.map((n, k) => chip(n, 'meas', k)).join('')}<button class="add" id="addmeas">+ value</button></div>
      <span class="spacer"></span>
      <div class="tg"><button class="iconbtn" id="presets">Views ▾</button><button class="iconbtn" id="csv" title="Download the current table as CSV">CSV</button></div>
    </div>
    <div class="status" id="status"></div>
    <div id="gridhost" style="flex:1;min-height:0;display:flex"></div>`;
  if (!grids[tname] || !document.body.contains(grids[tname].host)) grids[tname] = new Grid($('#gridhost'));
  else { $('#gridhost').replaceWith(grids[tname].host); }
  const grid = grids[tname];
  const t0 = performance.now();
  const idx = filtered(t);
  const model = listMode ? listModel(t, v, idx) : groupModel(t, v, idx);
  if (model.cols[0] && model.cols[0].num) model.cols.unshift({ id: 'lbl', label: '', num: false, w: 90, html: () => '', raw: () => '' });
  model.cols.forEach((c) => { if (!c.w) c.w = c.num ? numWidth(c.label) : 140; });
  sortRows(model.rows, model.cols, v.sort);
  grid.set({ cols: model.cols, rows: model.rows, total: model.total, sort: v.sort, onSort: (id) => { const s = v.sort; v.sort = s && s.id === id ? { id, dir: -s.dir } : { id, dir: model.cols.find((c) => c.id === id).num ? -1 : 1 }; save(); renderMain(true); }, keepScroll: model.keepScroll });
  const ms = (performance.now() - t0).toFixed(0);
  const crumbs = Object.entries(S.filters).filter(([n, f]) => f.vals.length && t.cols.has(n)).length + S.num.length + (S.search ? 1 : 0);
  $('#status').innerHTML = `<span>${idx.length.toLocaleString()} of ${t.n.toLocaleString()} ${TABLE_LABEL[tname]}${crumbs ? ` · ${crumbs} filter${crumbs > 1 ? 's' : ''}` : ''}</span><span>${model.rows.length.toLocaleString()} row${model.rows.length === 1 ? '' : 's'}</span><span>${unitLabel()}</span><span>${ms} ms</span>${model.note ? `<span>${model.note}</span>` : ''}<span class="spacer"></span><span>${listMode ? 'Click a policy or claim to open it; click any other value to filter.' : 'Click a group to drill down. Click a policy to open it.'}</span>`;
  $('#csv').onclick = () => grid.csv(`${tname}_${new Date().toISOString().slice(0, 10)}.csv`, model.total);
  wireToolbar(tname, t, v);
}
function openPolicyFromRow(t, i, claimName) { APP.openPolicy(t.name === 'policies' ? i : t.pidx[i], t, i); }
function listModel(t, v, idx) {
  const lc = v.listCols.map((n) => t.cols.get(n)).filter((c) => c && c.kind === 'dim');
  const ms = v.measures.map((n) => t.cols.get(n)).filter((c) => c && c.kind === 'num');
  const rows = Array.from(idx);
  const cols = lc.map((c) => ({
    id: 'd:' + c.name, label: c.label, num: false, w: dimWidth(c, rows.slice(0, 300).map((i) => c.codes[i])),
    html: (i) => esc(dval(c, c.codes[i])), raw: (i) => dval(c, c.codes[i]), sortKey: (i) => c.codes[i],
    link: c.name === 'Policy' || c.name === 'Claim',
    onClick: (i) => (c.name === 'Policy' || c.name === 'Claim' ? openPolicyFromRow(t, i) : (addFilterValue(c.name, c.dict[c.codes[i]]), update())),
  }));
  const total = { label: 'Total' };
  ms.forEach((m) => {
    let s = 0; for (let j = 0; j < idx.length; j++) s += m.values[idx[j]];
    const isDelta = m.group === 'Delta';
    cols.push({ id: 'm:' + m.name, label: m.label, num: true, html: (i) => money(m.values[i]), raw: (i) => m.values[i], total: money(s), totalRaw: s,
      cls: isDelta ? (i) => (Math.abs(m.values[i]) > S.tol ? 'bad' : '') : null });
  });
  if (!cols.length) cols.push({ id: 'none', label: 'Add columns', html: () => '', raw: () => '', w: 200 });
  return { cols, rows, total: ms.length ? total : null };
}
function groupModel(t, v, idx) {
  const gb = v.groupBy.map((n) => t.cols.get(n)).filter((c) => c && c.kind === 'dim');
  const ms = v.measures.map((n) => t.cols.get(n)).filter((c) => c && c.kind !== 'dim');
  const cd = v.colDim ? t.cols.get(v.colDim) : null;
  const agg = aggregate(t, idx, gb, ms, cd);
  agg.rows.sort((a, b) => { for (let k = 0; k < a.codes.length; k++) if (a.codes[k] !== b.codes[k]) return a.codes[k] - b.codes[k]; return 0; });
  const cols = [];
  gb.forEach((c, k) => {
    cols.push({
      id: 'd:' + c.name, label: c.label, num: false, w: dimWidth(c, agg.rows.slice(0, 300).map((g) => g.codes[k])),
      html: (g) => esc(dval(c, g.codes[k])), raw: (g) => dval(c, g.codes[k]), sortKey: (g) => g.codes[k],
      link: c.name === 'Policy',
      onClick: (g) => {
        if (c.name === 'Policy') { const r = polRow.get(c.dict[g.codes[k]]); if (r !== undefined) APP.openPolicy(r); return; }
        pushHist();
        for (let j = 0; j <= k; j++) setFilter(gb[j].name, [gb[j].dict[g.codes[j]]], false);
        v.groupBy = v.groupBy.slice(k + 1);
        if (!v.groupBy.length && !v.colDim) { v.mode = 'list'; if (!v.listCols.length) v.listCols = (APP.presets[t.name].find((p) => p.view.mode === 'list') || { view: { listCols: ['Policy'] } }).view.listCols.slice(); v.measures = v.measures.filter((n) => t.cols.get(n)?.kind === 'num'); }
        v.sort = null;
        update();
      },
    });
  });
  const total = { label: gb.length ? 'Total' : 'Total (no grouping)' };
  if (!cd) {
    ms.forEach((m, mi) => {
      const isDelta = m.group === 'Delta';
      cols.push({ id: 'm:' + m.name, label: m.label, num: true, html: (g) => fmtCol(m, g.acc.s[mi]), raw: (g) => g.acc.s[mi], total: fmtCol(m, agg.total.s[mi]), totalRaw: agg.total.s[mi],
        cls: isDelta ? (g) => (Math.abs(g.acc.s[mi]) > S.tol ? 'bad' : '') : null });
    });
    return { cols, rows: agg.rows, total };
  }
  // cross-tab
  let ccs = [...agg.colTot.keys()].sort((a, b) => a - b);
  let note = '';
  if (ccs.length > 80) { note = `showing the first 80 of ${ccs.length} columns`; ccs = ccs.slice(0, 80); }
  const C = ccs.length;
  const cumOK = (m) => v.cum && m.kind !== 'distinct';
  // The "(blank)" column is never part of the cumulative chain.
  const chain = ccs.map((cc, ci) => (cd.dict[cc] === null ? -1 : ci)).filter((ci) => ci >= 0);
  const cumulate = (x, mi) => { for (let k = 1; k < chain.length; k++) x[mi * C + chain[k]] += x[mi * C + chain[k - 1]]; };
  for (const g of agg.rows) {
    g.x = new Float64Array(ms.length * C); let lastHas = -1;
    ccs.forEach((cc, ci) => { const cell = g.cells.get(cc); if (cell) { if (cd.dict[cc] !== null) lastHas = ci; ms.forEach((m, mi) => { g.x[mi * C + ci] = cell.s[mi]; }); } });
    g.lastHas = lastHas;
    ms.forEach((m, mi) => { if (cumOK(m)) cumulate(g.x, mi); });
  }
  const tx = new Float64Array(ms.length * C);
  ccs.forEach((cc, ci) => { const ct = agg.colTot.get(cc); ms.forEach((m, mi) => { tx[mi * C + ci] = ct.s[mi]; }); });
  ms.forEach((m, mi) => { if (cumOK(m)) cumulate(tx, mi); });
  ms.forEach((m, mi) => {
    ccs.forEach((cc, ci) => {
      const lab = (ms.length > 1 ? m.label + ' · ' : '') + dval(cd, cc);
      const blank = (g) => cumOK(m) && cd.dict[cc] !== null && ci > g.lastHas;
      cols.push({ id: `x:${mi}:${ci}`, label: lab, num: true, w: ms.length > 1 ? numWidth(lab) : Math.max(96, numWidth(dval(cd, cc))),
        html: (g) => (blank(g) ? '' : fmtCol(m, g.x[mi * C + ci])), raw: (g) => (blank(g) ? '' : g.x[mi * C + ci]), sortKey: (g) => g.x[mi * C + ci],
        total: fmtCol(m, tx[mi * C + ci]), totalRaw: tx[mi * C + ci] });
    });
    cols.push({ id: 'm:' + m.name, label: (ms.length > 1 ? m.label + ' · ' : '') + 'Total', num: true, html: (g) => `<b>${fmtCol(m, g.acc.s[mi])}</b>`, raw: (g) => g.acc.s[mi], total: fmtCol(m, agg.total.s[mi]), totalRaw: agg.total.s[mi] });
  });
  if (v.cum && ms.some((m) => m.kind === 'distinct')) note += (note ? '; ' : '') + 'distinct counts are not cumulated';
  return { cols, rows: agg.rows, total, note };
}
function wireToolbar(tname, t, v) {
  const page = $('#main'), listMode = v.mode === 'list';
  page.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
    if (v.mode === b.dataset.mode) return;
    pushHist(); v.mode = b.dataset.mode; v.sort = null;
    if (v.mode === 'list') {
      if (!v.listCols.length) v.listCols = [...new Set([...(t.name === 'policies' ? ['Policy'] : ['Policy', 'Claim']), ...v.groupBy])].filter((n) => t.cols.has(n));
      v.measures = v.measures.filter((n) => t.cols.get(n)?.kind === 'num');
    }
    update();
  });
  $('#addrow').onclick = (e) => openPicker(e.currentTarget, {
    items: dimItems(t, listMode ? v.listCols : v.groupBy), placeholder: listMode ? 'Add column…' : 'Group by…',
    onPick: (n) => { pushHist(); (listMode ? v.listCols : v.groupBy).push(n); if (!listMode && v.colDim === n) v.colDim = null; update(); },
  });
  $('#addmeas').onclick = (e) => openPicker(e.currentTarget, {
    items: measureItems(t, listMode), multi: true, selected: v.measures, placeholder: 'Add values…',
    onPick: (n) => { pushHist(); const k = v.measures.indexOf(n); if (k >= 0) v.measures.splice(k, 1); else v.measures.push(n); update(); },
  });
  const sc = $('#setcol');
  if (sc) sc.onclick = (e) => openPicker(e.currentTarget, {
    items: dimItems(t, v.groupBy), selected: v.colDim ? [v.colDim] : [], placeholder: 'Spread across…',
    onPick: (n) => { pushHist(); v.colDim = n; v.sort = null; update(); },
  });
  const cc = $('#clrcol'); if (cc) cc.onclick = () => { pushHist(); v.colDim = null; v.cum = false; v.sort = null; update(); };
  const cum = $('#cum'); if (cum) cum.onchange = () => { pushHist(); v.cum = cum.checked; update(); };
  page.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => {
    pushHist();
    const arr = b.dataset.rm === 'meas' ? v.measures : listMode ? v.listCols : v.groupBy;
    arr.splice(+b.dataset.k, 1); v.sort = null; update();
  });
  // drag & drop to reorder chips
  let drag = null;
  page.querySelectorAll('[data-chip]').forEach((ch) => {
    ch.addEventListener('dragstart', (e) => { drag = ch; e.dataTransfer.effectAllowed = 'move'; });
    ch.addEventListener('dragover', (e) => { if (drag && drag.dataset.chip === ch.dataset.chip) { e.preventDefault(); ch.classList.add('drop'); } });
    ch.addEventListener('dragleave', () => ch.classList.remove('drop'));
    ch.addEventListener('drop', (e) => {
      e.preventDefault(); ch.classList.remove('drop'); if (!drag || drag === ch) return;
      pushHist();
      const arr = ch.dataset.chip === 'meas' ? v.measures : listMode ? v.listCols : v.groupBy;
      const [x] = arr.splice(+drag.dataset.k, 1); arr.splice(+ch.dataset.k, 0, x); update();
    });
  });
  $('#presets').onclick = (e) => openPicker(e.currentTarget, {
    items: APP.presets[tname].map((p, k) => ({ value: k, label: p.name, group: 'Saved views' })), placeholder: 'Choose a view…',
    onPick: (k) => {
      pushHist(); const p = APP.presets[tname][k];
      S.views[tname] = { ...clone(BASE_VIEW), ...clone(p.view) };
      if (p.filters) Object.assign(S.filters, clone(p.filters));
      update();
    },
  });
}

/* ---------------------------------------------------------------- shell */
function renderTop() {
  $('#tabs').innerHTML = APP.tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${l}</button>`).join('');
  $('#units').value = S.units;
  if ($('#tol')) $('#tol').value = S.tol;
  $('#back').disabled = hi <= 0;
  $('#layout').classList.toggle('nosb', !S.sidebar);
  if (APP.onTop) APP.onTop();
}
function renderMain(keepScroll) {
  const page = $('#main');
  page.className = 'page';
  const t = APP.tabs.find(([k]) => k === S.tab);
  if (t && t[2]) t[2](page); else explorer(S.tab, keepScroll);
}
function renderAll() { closePicker(); renderTop(); renderSidebar(); renderMain(); save(); }
function update() { closePicker(); renderTop(); refreshSidebarCounts(); renderMain(); save(); }
function goTab(k) { if (S.tab !== k) { S.tab = k; renderAll(); } }

function boot() {
  const app = $('#app');
  if (!window.ACTDASH_DATA) {
    app.innerHTML = `<div class="nodata"><h2>No data loaded</h2>
      <p>This page reads <code>${esc(APP.dataFile)}</code>, which is generated from the Excel sources and kept out of git.</p>
      <pre>pip install -r requirements.txt
python recon.py build</pre>
      <p>Then reload this page. Alternatively, pick a <code>${esc(APP.dataFile.split('/').pop())}</code> file:</p>
      <input type="file" id="pick" accept=".js,.json"></div>`;
    $('#pick').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      let text = await file.text(); text = text.replace(/^\s*window\.ACTDASH_DATA\s*=\s*/, '').replace(/;\s*$/, '');
      window.ACTDASH_DATA = JSON.parse(text); boot();
    };
    return;
  }
  decode(window.ACTDASH_DATA);
  S.tab = APP.tabs[0][0];
  load();
  const fromUrl = decodeHash(location.hash);
  if (fromUrl) Object.assign(S, fromUrl);
  hi = (history.state && history.state.i) || 0;
  if (!APP.tabs.some(([k]) => k === S.tab)) S.tab = APP.tabs[0][0];
  if (APP.onLoad) APP.onLoad();
  app.innerHTML = `
    <header class="top">
      <button class="iconbtn" id="tsb" title="Toggle filters panel">☰</button>
      <div class="brand">${esc(APP.title)}<small title="Data as of · tool version · built">${esc(META.actuarial.as_of || '')}${META.version ? ' · v' + esc(META.version) : ''}</small></div>
      <nav class="tabs" id="tabs" role="tablist"></nav>
      ${APP.topHtml ? APP.topHtml() : ''}
      <span class="spacer"></span>
      ${APP.showTol ? '<label class="ctl" title="Absolute delta above which a policy counts as a discrepancy">Tolerance <input id="tol" type="number" min="0" step="any"></label>' : ''}
      <label class="ctl">Units <select id="units"><option value="">USD</option><option value="k">USD k</option><option value="m">USD m</option></select></label>
      <button class="iconbtn" id="back" title="Previous view (Alt+←) - same as the browser Back button">↶ Back</button>
      <a class="iconbtn navlink" href="${esc(APP.otherTool.href)}" title="${esc(APP.otherTool.title)}">${esc(APP.otherTool.label)} ↗</a>
    </header>
    <div class="layout" id="layout"><aside id="sb"></aside><main id="main" class="page"></main></div>
    <div class="drawer" id="drawer"></div>`;
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) goTab(b.dataset.tab); };
  $('#units').onchange = (e) => { S.units = e.target.value; renderMain(); save(); };
  let tt = 0;
  if ($('#tol')) $('#tol').oninput = (e) => { clearTimeout(tt); tt = setTimeout(() => { S.tol = Math.max(0, Number(e.target.value) || 0); renderMain(); save(); }, 250); };
  $('#back').onclick = back;
  $('#tsb').onclick = () => { S.sidebar = !S.sidebar; renderTop(); save(); };
  wireSidebar();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePicker(); closeDrawer(); if (APP.onEscape) APP.onEscape(); }
    else if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#q')?.focus(); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); }
  });
  window.addEventListener('resize', () => { for (const g of Object.values(grids)) { g.last = null; g.paint(); } if (APP.onResize) APP.onResize(); });
  if (APP.afterBoot) APP.afterBoot();
  renderAll();
}
function closeDrawer() { const d = $('#drawer'); if (d) d.classList.remove('open'); }

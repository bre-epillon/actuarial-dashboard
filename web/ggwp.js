'use strict';
/* =====================================================================
   Written premium (GGWP / GNWP) dashboard.
   Source: the most recent Underwriting Report (Production) workbook in inputs/ggwp-pyramid, read by the
   local server (`ggwp.bat`) - expected premium, our share, summed by underwriting year / month / class.
   The page re-checks the folder every 30 s and refreshes by itself. Without the server a CSV with the
   same columns can be loaded by hand.
   Gross-gross written premium (GGWP) is before commissions, gross-net (GNWP) after them:
   commission = GGWP - GNWP.
   ===================================================================== */
const LS = 'actdash.ggwp.v1', POLL_MS = 30000;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NF = {};
const nf = (d) => (NF[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

/* ---------------------------------------------------------------- model */
const DIMS = {
  uwy: { label: 'Underwriting year', val: (r) => r.y, ordered: true },
  cls: { label: 'Class of business', val: (r) => r.cls, byValue: true },
  month: { label: 'UW month', val: (r) => r.m, fmt: (v) => MON[v - 1] || v, ordered: true },
  quarter: { label: 'UW quarter', val: (r) => 'Q' + Math.ceil(r.m / 3), ordered: true },
  period: { label: 'UW year-month', val: (r) => `${r.y}-${pad(r.m)}`, ordered: true },
};
const MEAS = {
  ggwp: { label: 'GGWP (before commissions)', short: 'GGWP', f: (a) => a.ggwp },
  gnwp: { label: 'GNWP (after commissions)', short: 'GNWP', f: (a) => a.gnwp },
  comm: { label: 'Commissions (GGWP − GNWP)', short: 'Commissions', f: (a) => a.ggwp - a.gnwp },
  ratio: { label: 'Commission % of GGWP', short: 'Comm. %', pct: true, f: (a) => (a.ggwp ? (a.ggwp - a.gnwp) / a.ggwp : null) },
  share: { label: '% of total GGWP', short: '% of total', pct: true, f: (a, g) => (g.ggwp ? a.ggwp / g.ggwp : null) },
};
const P = { units: '', rows: 'uwy', cols: 'month', meas: 'ggwp', cum: false, heat: true, barDim: 'uwy', chart: 'timeline', chartMeas: 'ggwp', chartCum: false, sidebar: true };
const FIL = { uwy: [], cls: [], month: [] };
let DATA = null, SERVER = null /* true | false | null (unknown) */, checkedAt = null, toastTimer = 0;

function loadPrefs() { try { Object.assign(P, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { /* ignore */ } }
function savePrefs() { try { localStorage.setItem(LS, JSON.stringify(P)); } catch (e) { /* ignore */ } }

/* ------------------------------------------------------------------ csv */
function parseCsv(text, delim) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
function parseExtract(text) {
  const first = text.split('\n', 1)[0];
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const all = parseCsv(text, delim), head = (all.shift() || []).map((h) => h.trim().toLowerCase());
  const find = (re) => head.findIndex((h) => re.test(h));
  const ix = { ggwp: find(/ggwp/), gnwp: find(/gnwp/), m: find(/underwriting month|uw month/), y: find(/underwriting year|uw year/), cls: find(/reserving class|class/) };
  const missing = Object.entries(ix).filter(([, v]) => v < 0).map(([k]) => ({ ggwp: 'GGWP', gnwp: 'GNWP', m: 'underwriting month', y: 'underwriting year', cls: 'reserving class' }[k]));
  if (missing.length) throw new Error(`Column(s) not found: ${missing.join(', ')}. The file has: ${head.join(' | ') || '(empty)'}`);
  const num = (v) => { const x = parseFloat(String(v).replace(/\s/g, '')); return Number.isFinite(x) ? x : 0; };
  return all.map((r) => ({ ggwp: num(r[ix.ggwp]), gnwp: num(r[ix.gnwp]), m: Math.round(num(r[ix.m])), y: Math.round(num(r[ix.y])), cls: (r[ix.cls] || '').trim() || '(blank)' }));
}
function dataNotes(rows) {
  const notes = [], sum = (a, f) => a.reduce((s, r) => s + f(r), 0), a0 = (n) => nf(0).format(n);
  const unk = rows.filter((r) => /^(unknown|\(blank\))$/i.test(r.cls));
  if (unk.length) notes.push(`${unk.length} row(s) with class “${unk[0].cls}”: GGWP ${a0(sum(unk, (r) => r.ggwp))}.`);
  const neg = rows.filter((r) => r.gnwp > r.ggwp + 0.5);
  if (neg.length) notes.push(`${neg.length} row(s) where GNWP is above GGWP (negative commissions): ${neg.slice(0, 3).map((r) => `${r.y}-${pad(r.m)} ${r.cls}`).join('; ')}${neg.length > 3 ? '…' : ''}.`);
  const fut = rows.filter((r) => r.y > new Date().getFullYear());
  if (fut.length) notes.push(`Underwriting year(s) in the future: ${[...new Set(fut.map((r) => r.y))].join(', ')} (GGWP ${a0(sum(fut, (r) => r.ggwp))}).`);
  const byY = new Map(); for (const r of rows) byY.set(r.y, (byY.get(r.y) || 0) + Math.abs(r.ggwp) + Math.abs(r.gnwp));
  const zero = [...byY].filter(([, v]) => v < 0.5).map(([y]) => y);
  if (zero.length) notes.push(`Underwriting year(s) with no premium: ${zero.join(', ')}.`);
  const seen = new Set(); let dup = 0; for (const r of rows) { const k = `${r.y}|${r.m}|${r.cls}`; if (seen.has(k)) dup++; else seen.add(k); }
  if (dup) notes.push(`${dup} duplicated underwriting year / month / class combination(s) (amounts are added up).`);
  return notes;
}

/* ----------------------------------------------------------- formatting */
function scale() { return P.units === 'm' ? [1e6, 2] : P.units === 'k' ? [1e3, 1] : [1, 0]; }
function amt(v) { const [div, d] = scale(), x = Number((v / div).toFixed(d)); return nf(d).format(x === 0 ? 0 : x); }
const pct = (v) => (v === null || v === undefined ? '–' : (v * 100).toFixed(1) + '%');
const baseUnit = () => (DATA && DATA.unit) || 'Base CCY';
const unitLabel = () => baseUnit() + (P.units === 'm' ? ' m' : P.units === 'k' ? ' k' : '');
const natural = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
const dfmt = (d, v) => (d.fmt ? d.fmt(v) : String(v));

/* ------------------------------------------------------------ filtering */
const keep = (r, skip) => (skip === 'uwy' || !FIL.uwy.length || FIL.uwy.includes(String(r.y)))
  && (skip === 'cls' || !FIL.cls.length || FIL.cls.includes(r.cls))
  && (skip === 'month' || !FIL.month.length || FIL.month.includes(String(r.m)));
const inScope = () => DATA.rows.filter((r) => keep(r));
const add = (a, r) => { a.ggwp += r.ggwp; a.gnwp += r.gnwp; };
const acc = () => ({ ggwp: 0, gnwp: 0 });
function groupBy(rows, dim) {
  const d = DIMS[dim], m = new Map();
  for (const r of rows) { const k = d.val(r); let a = m.get(k); if (!a) m.set(k, (a = acc())); add(a, r); }
  return m;
}
const sortedKeys = (m, dim) => [...m.keys()].sort(natural);

/* ------------------------------------------------------------- sidebar */
function renderSidebar() {
  const sb = $('#sb');
  let html = `<div class="sbh" style="margin-top:2px">Filters <button id="clearf">Clear all</button></div>`;
  for (const key of ['uwy', 'month', 'cls']) {
    const d = DIMS[key], m = groupBy(DATA.rows.filter((r) => keep(r, key)), key);
    // keep selected values visible even when the other filters hide them
    for (const v of FIL[key]) { const k = key === 'cls' ? v : Number(v); if (!m.has(k)) m.set(k, acc()); }
    for (const r of DATA.rows) { const k = d.val(r); if (!m.has(k)) m.set(k, acc()); }
    const keys = key === 'cls' ? [...m.keys()].sort((a, b) => m.get(b).ggwp - m.get(a).ggwp) : [...m.keys()].sort(natural);
    html += `<div class="sbh">${esc(d.label)}${FIL[key].length ? ` <button data-clr="${key}">clear (${FIL[key].length})</button>` : ''}</div><div class="facet" style="margin:0 0 6px">`;
    for (const k of keys) {
      const on = FIL[key].includes(String(k)), a = m.get(k);
      html += `<label class="fv${a.ggwp || a.gnwp ? '' : ' zero'}"><input type="checkbox" data-fk="${key}" data-v="${esc(k)}" ${on ? 'checked' : ''}><span class="l" title="${esc(dfmt(d, k))}">${esc(dfmt(d, k))}</span><span class="c">${shortNum(a.ggwp)}</span></label>`;
    }
    html += '</div>';
  }
  html += '<div class="muted" style="font-size:12px">Amounts next to each value: GGWP within the other filters. Nothing ticked = all.</div>';
  sb.innerHTML = html;
}

/* -------------------------------------------------------------- pivot */
function pivotModel(rows) {
  const rd = DIMS[P.rows], cd = P.cols === 'none' ? null : DIMS[P.cols];
  const R = new Map(), grand = acc(), colTot = new Map();
  for (const r of rows) {
    const rk = rd.val(r), ck = cd ? cd.val(r) : 0;
    let e = R.get(rk); if (!e) R.set(rk, (e = { k: rk, cells: new Map(), tot: acc() }));
    let c = e.cells.get(ck); if (!c) e.cells.set(ck, (c = acc()));
    add(c, r); add(e.tot, r); add(grand, r);
    let t = colTot.get(ck); if (!t) colTot.set(ck, (t = acc())); add(t, r);
  }
  let rkeys = [...R.keys()];
  rkeys = rd.byValue ? rkeys.sort((a, b) => R.get(b).tot.ggwp - R.get(a).tot.ggwp) : rkeys.sort(natural);
  const ckeys = cd ? [...colTot.keys()].sort(natural) : [0];
  const cum = cd && P.cum && cd.ordered;
  if (cum) {
    for (const e of R.values()) { let run = acc(); for (const ck of ckeys) { const c = e.cells.get(ck) || acc(); run = { ggwp: run.ggwp + c.ggwp, gnwp: run.gnwp + c.gnwp }; e.cells.set(ck, run); } }
    let run = acc(); for (const ck of ckeys) { const c = colTot.get(ck); run = { ggwp: run.ggwp + c.ggwp, gnwp: run.gnwp + c.gnwp }; colTot.set(ck, run); }
  }
  const m = MEAS[P.meas];
  const columns = cd
    ? ckeys.map((ck) => ({ label: dfmt(cd, ck), val: (e) => { const a = e.cells.get(ck); return a ? m.f(a, grand) : null; }, tot: () => m.f(colTot.get(ck), grand), pct: m.pct }))
    : ['ggwp', 'gnwp', 'comm', 'ratio', 'share'].map((k) => ({ label: MEAS[k].short, key: k, val: (e) => MEAS[k].f(e.tot, grand), tot: () => MEAS[k].f(grand, grand), pct: MEAS[k].pct, bar: k === 'ggwp' }));
  if (cd) columns.push({ label: 'Total', val: (e) => m.f(e.tot, grand), tot: () => m.f(grand, grand), pct: m.pct, total: true });
  // heat scale per column (no column dimension) or over the whole body
  const body = rkeys.map((k) => R.get(k));
  const scaleFor = (cols) => { let lo = 0, hi = 0; for (const e of body) for (const c of cols) { const v = c.val(e); if (v === null) continue; if (v < lo) lo = v; if (v > hi) hi = v; } return Math.max(Math.abs(lo), Math.abs(hi)) || 1; };
  const bodyCols = columns.filter((c) => !c.total);
  const shared = cd ? scaleFor(bodyCols) : 0;
  columns.forEach((c) => { c.max = cd ? shared : scaleFor([c]); });
  return { rd, cd, rows: body, columns, grand, rowLabel: rd.label };
}
function cellHtml(c, v, e) {
  if (v === null || (!c.pct && Math.abs(v) < 0.005)) return '<td>–</td>';
  const txt = c.pct ? pct(v) : amt(v);
  let style = '', cls = c.total ? 'tc' : '';
  if (P.heat && !c.total && !(c.pct && c.key === 'ratio') && c.max) { const a = Math.round(48 * Math.min(1, Math.abs(v) / c.max)); if (a >= 2) style = ` style="background:color-mix(in srgb, ${v < 0 ? 'var(--s8)' : 'var(--s1)'} ${a}%, transparent)"`; }
  if (v < 0 && !c.pct) cls += ' neg';
  const bar = c.bar && c.max ? `<span class="inbar" style="width:${Math.max(0, Math.min(100, 100 * v / c.max)).toFixed(1)}%"></span>` : '';
  return `<td class="${cls}"${style}>${txt}${bar}</td>`;
}
function pivotHtml(pm) {
  const rl = (e) => esc(dfmt(pm.rd, e.k));
  return `<div class="pv"><table><thead><tr><th>${esc(pm.rowLabel)}</th>${pm.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
    ${pm.rows.map((e) => `<tr><td>${rl(e)}</td>${pm.columns.map((c) => cellHtml(c, c.val(e), e)).join('')}</tr>`).join('') || `<tr><td colspan="${pm.columns.length + 1}" class="muted">No rows match the filters.</td></tr>`}
    <tr class="tot"><td>Total</td>${pm.columns.map((c) => `<td>${c.pct ? pct(c.tot()) : amt(c.tot())}</td>`).join('')}</tr></tbody></table></div>`;
}
function pivotCsv(pm) {
  const q = (s) => { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const f = (c, v) => (v === null ? '' : c.pct ? (v * 100).toFixed(4) : v.toFixed(2));
  const lines = [[pm.rowLabel, ...pm.columns.map((c) => c.label)].map(q).join(',')];
  for (const e of pm.rows) lines.push([dfmt(pm.rd, e.k), ...pm.columns.map((c) => f(c, c.val(e)))].map(q).join(','));
  lines.push(['Total', ...pm.columns.map((c) => f(c, c.tot()))].map(q).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ggwp_pivot_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* --------------------------------------------------------------- charts */
function barSpec(rows) {
  const d = DIMS[P.barDim], m = groupBy(rows, P.barDim), ks = sortedKeys(m, P.barDim).filter((k) => Math.abs(m.get(k).ggwp) + Math.abs(m.get(k).gnwp) > 0.5);
  return { cats: ks.map((k) => dfmt(d, k)), xTitle: d.label, fmt: amt, ariaLabel: `GGWP and GNWP by ${d.label}`,
    series: [{ name: 'GGWP (before commissions)', color: 'var(--s1)', vals: ks.map((k) => m.get(k).ggwp) }, { name: 'GNWP (after commissions)', color: 'var(--s2)', vals: ks.map((k) => m.get(k).gnwp) }] };
}
const running = (a) => { let s = 0; return a.map((v) => (s += v)); };
function lineSpec(rows) {
  const cum = (a) => (P.chartCum ? running(a) : a);
  if (P.chart === 'timeline') {
    const m = groupBy(rows, 'period'), ks = [...m.keys()].sort(), xs = [];
    if (ks.length) {
      const [y0, m0] = ks[0].split('-').map(Number), [y1, m1] = ks[ks.length - 1].split('-').map(Number);
      for (let i = y0 * 12 + m0 - 1; i <= y1 * 12 + m1 - 1; i++) xs.push(`${Math.floor(i / 12)}-${pad((i % 12) + 1)}`);
    }
    const v = (k, f) => xs.map((x) => (m.get(x) ? f(m.get(x)) : 0));
    return { xs, xTitle: 'Underwriting month', fmt: amt, refs: [], ariaLabel: 'GGWP and GNWP by underwriting month',
      series: [{ name: 'GGWP', color: 'var(--s1)', vals: cum(v(0, (a) => a.ggwp)) }, { name: 'GNWP', color: 'var(--s2)', vals: cum(v(0, (a) => a.gnwp)) }] };
  }
  // one line per underwriting year over the 12 underwriting months
  const f = MEAS[P.chartMeas].f, byY = new Map();
  for (const r of rows) { let a = byY.get(r.y); if (!a) byY.set(r.y, (a = Array.from({ length: 12 }, acc))); if (r.m >= 1 && r.m <= 12) add(a[r.m - 1], r); }
  const ys = [...byY.keys()].filter((y) => byY.get(y).some((a) => a.ggwp || a.gnwp)).sort((a, b) => a - b).slice(-8);
  return { xs: MON, xTitle: 'Underwriting month', fmt: amt, refs: [], ariaLabel: `${MEAS[P.chartMeas].short} by underwriting month, one line per underwriting year`, empty: 'No premium in scope.',
    series: ys.map((y) => ({ name: String(y), color: `var(--s${(y % 8) + 1})`, vals: cum(byY.get(y).map(f)) })) };
}

/* ----------------------------------------------------------------- page */
const sel = (id, opts, v) => `<select id="${id}" class="iconbtn">${opts.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function renderMain() {
  const page = $('#main'); if (!DATA) return;
  const rows = inScope(), tot = acc(); rows.forEach((r) => add(tot, r));
  const comm = tot.ggwp - tot.gnwp, years = new Set(rows.filter((r) => r.ggwp || r.gnwp).map((r) => r.y));
  const kpi = (l, v, sub) => `<div class="kpi"><div class="kl">${l}</div><div class="kv0">${v}</div><div class="kf">${sub || '&nbsp;'}</div></div>`;
  const pm = pivotModel(rows);
  const dimOpts = Object.entries(DIMS).map(([k, d]) => [k, d.label]);
  const cumOk = P.cols !== 'none' && DIMS[P.cols].ordered;
  const notes = DATA.notes;
  const mode = DATA.source === 'manual' ? 'loaded by hand' : 'latest report in inputs/ggwp-pyramid';
  page.innerHTML = `
    <section class="card">
      <div class="meta"><span>File: <b>${esc(DATA.file)}</b> (${mode})</span><span>Modified <b>${esc(DATA.modified || '?')}</b></span><span>${DATA.rows.length.toLocaleString()} rows · ${rows.length.toLocaleString()} in scope</span><span>Amounts in <b>${unitLabel()}</b></span></div>
      ${DATA.note ? `<div class="muted" style="font-size:12px;margin-top:6px">${esc(DATA.note)}</div>` : ''}
      ${notes.length ? `<details class="map"><summary>${notes.length} data note${notes.length > 1 ? 's' : ''}</summary><ul class="notes-list">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    </section>
    <div class="kpis">
      ${kpi('GGWP (before commissions)', amt(tot.ggwp))}
      ${kpi('GNWP (after commissions)', amt(tot.gnwp))}
      ${kpi('Commissions', amt(comm), 'GGWP − GNWP')}
      ${kpi('Commission % of GGWP', pct(tot.ggwp ? comm / tot.ggwp : null))}
      ${kpi('Underwriting years', years.size ? `${Math.min(...years)} – ${Math.max(...years)}` : '–', `${years.size} with premium`)}
    </div>
    <div class="charts">
      <section class="card"><h2>Written premium by ${sel('bardim', ['uwy', 'quarter', 'month'].map((k) => [k, DIMS[k].label]), P.barDim)}<span class="r"><button class="iconbtn" data-tbl="chB">Table</button></span></h2><div id="chB"></div></section>
      <section class="card"><h2>${sel('chart', [['timeline', 'Timeline by underwriting month'], ['overlay', 'Year overlay (seasonality)']], P.chart)}<span class="r">
        ${P.chart === 'overlay' ? sel('chmeas', [['ggwp', 'GGWP'], ['gnwp', 'GNWP'], ['comm', 'Commissions']], P.chartMeas) : ''}
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="chcum" ${P.chartCum ? 'checked' : ''}>cumulative</label>
        <button class="iconbtn" data-tbl="chL">Table</button></span></h2><div id="chL"></div></section>
    </div>
    <section class="card">
      <h2>Pivot <span class="muted" style="font-weight:400">${unitLabel()}</span><span class="r">
        <label>Rows</label>${sel('prow', dimOpts, P.rows)}
        <label>Columns</label>${sel('pcol', [['none', '(none - all measures)'], ...dimOpts], P.cols)}
        ${P.cols !== 'none' ? `<label>Value</label>${sel('pmeas', Object.entries(MEAS).map(([k, m]) => [k, m.label]), P.meas)}` : ''}
        ${cumOk ? `<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="pcum" ${P.cum ? 'checked' : ''}>cumulative →</label>` : ''}
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="pheat" ${P.heat ? 'checked' : ''}>heat map</label>
        <button class="iconbtn" id="pcsv">CSV</button></span></h2>
      <div id="pvhost">${pivotHtml(pm)}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Underwriting year × underwriting month with the GGWP value is the premium “pyramid”. Percent values are ratios of the sums, not averages. Negative amounts in red.</div>
    </section>`;
  for (const [id, host, fn, key] of [['chB', $('#chB'), barChart, 'B'], ['chL', $('#chL'), lineChart, 'L']]) {
    host._mode = P['tbl' + key] ? 'table' : 'chart';
    fn(host, key === 'B' ? barSpec(rows) : lineSpec(rows));
  }
  page.querySelectorAll('[data-tbl]').forEach((b) => {
    const h = $('#' + b.dataset.tbl), key = b.dataset.tbl.slice(2);
    if (h._mode === 'table') b.textContent = 'Chart';
    b.onclick = () => { h._mode = h._mode === 'table' ? 'chart' : 'table'; P['tbl' + key] = h._mode === 'table'; b.textContent = h._mode === 'table' ? 'Chart' : 'Table'; savePrefs(); h._draw(); };
  });
  const bind = (id, key, fn) => { const el = $('#' + id); if (el) el.onchange = () => { P[key] = el.type === 'checkbox' ? el.checked : el.value; if (fn) fn(); savePrefs(); renderMain(); }; };
  bind('bardim', 'barDim'); bind('chart', 'chart'); bind('chmeas', 'chartMeas'); bind('chcum', 'chartCum');
  bind('prow', 'rows'); bind('pcol', 'cols'); bind('pmeas', 'meas'); bind('pcum', 'cum'); bind('pheat', 'heat');
  $('#pcsv').onclick = () => pivotCsv(pm);
}
function renderStatus() {
  const el = $('#stat'); if (!el) return;
  const t = checkedAt ? checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  if (DATA && DATA.source === 'manual') el.innerHTML = '<span class="dot"></span>File loaded by hand - no auto-refresh';
  else if (SERVER === false) el.innerHTML = '<span class="dot bad"></span>Local server not running - start <b>ggwp.bat</b>';
  else if (SERVER) el.innerHTML = `<span class="dot ok"></span>Auto-refresh on · checked ${t}`;
  else el.textContent = '';
  const s = $('#fsmall'); if (s) s.textContent = DATA ? DATA.file : '';
}
function renderAll() { if (!DATA) return; $('#units').options[0].text = baseUnit(); renderSidebar(); renderMain(); renderStatus(); $('#layout').classList.toggle('nosb', !P.sidebar); }

function setData(text, meta, source) {
  const rows = parseExtract(text);
  const replaced = DATA && DATA.file;
  DATA = { rows, notes: dataNotes(rows).concat(meta.warnings || []), unit: meta.unit || '', note: meta.note || '', file: meta.file, modified: meta.modified ? meta.modified.replace('T', ' ') : '', sig: meta.file + '|' + meta.modified + '|' + meta.size, source };
  // drop filter values that no longer exist in the new extract
  const have = { uwy: new Set(rows.map((r) => String(r.y))), cls: new Set(rows.map((r) => r.cls)), month: new Set(rows.map((r) => String(r.m))) };
  for (const k of Object.keys(FIL)) FIL[k] = FIL[k].filter((v) => have[k].has(v));
  renderAll();
  if (replaced && replaced !== meta.file) toast(`New extract loaded: ${meta.file}`);
  else if (replaced) toast('Extract refreshed');
}
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.style.display = ''; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 6000);
}
function showError(msg) {
  const main = $('#main');
  const box = `<section class="card"><h2>No data</h2><p>${esc(msg)}</p>
    <p class="muted">Put the Underwriting Report (Production) workbook in <code>inputs/ggwp-pyramid</code> and start the dashboard with <code>ggwp.bat</code> (it always opens the most recent file there). A CSV with the same columns can also be loaded by hand with the button at the top.</p></section>`;
  if (!DATA) main.innerHTML = box; else toast(msg);
}

async function check(force) {
  if (DATA && DATA.source === 'manual' && !force) return;
  try {
    const r = await fetch('/api/ggwp/latest', { cache: 'no-store' });
    SERVER = true; checkedAt = new Date();
    if (!r.ok) { const e = await r.json().catch(() => ({})); renderStatus(); return showError(e.error || 'No extract found.'); }
    const info = await r.json(), sig = info.file + '|' + info.modified + '|' + info.size;
    if (force || !DATA || DATA.source === 'manual' || DATA.sig !== sig) {
      const res = await fetch('/api/ggwp', { cache: 'no-store' }), full = await res.json();
      if (!res.ok) { renderStatus(); return showError(full.error || 'The extract could not be read.'); }
      setData(full.csv, full, 'server');
    }
    renderStatus();
  } catch (e) {
    if (e instanceof Error && /Column\(s\)/.test(e.message)) { showError(e.message); return; }
    SERVER = false; renderStatus();
    if (!DATA) showError('The local server is not running, so the latest extract cannot be loaded automatically.');
  }
}

function boot() {
  loadPrefs();
  $('#app').innerHTML = `
    <header class="top">
      <button class="iconbtn" id="tsb" title="Toggle filters panel">☰</button>
      <div class="brand">Written premium<small id="fsmall"></small></div>
      <span class="status-pill" id="stat"></span>
      <span class="spacer"></span>
      <label class="ctl">Units <select id="units"><option value="">USD</option><option value="k">k</option><option value="m">m</option></select></label>
      <label class="iconbtn" title="Load a CSV extract by hand (no auto-refresh)">Load CSV…<input type="file" id="pick" accept=".csv,text/csv,.txt" hidden></label>
      <button class="iconbtn" id="refresh" title="Check for a newer file now">↻</button>
      <a class="iconbtn navlink" href="explorer.html">Explorer ↗</a>
    </header>
    <div class="layout" id="layout"><aside id="sb"></aside><main id="main" class="page scroll"><div class="empty">Loading the latest extract…</div></main></div>`;
  $('#units').value = P.units;
  $('#units').onchange = (e) => { P.units = e.target.value; savePrefs(); renderAll(); };
  $('#tsb').onclick = () => { P.sidebar = !P.sidebar; savePrefs(); $('#layout').classList.toggle('nosb', !P.sidebar); };
  $('#refresh').onclick = () => { if (DATA && DATA.source === 'manual') DATA.source = 'server'; check(true); };
  $('#pick').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { setData(await f.text(), { file: f.name, modified: f.lastModified ? new Date(f.lastModified).toISOString().slice(0, 19) : '', size: f.size }, 'manual'); } catch (err) { showError(err.message); }
    e.target.value = '';
  };
  $('#sb').addEventListener('change', (e) => {
    const el = e.target; if (!el.dataset.fk) return;
    const a = FIL[el.dataset.fk], v = el.dataset.v, i = a.indexOf(v);
    if (el.checked && i < 0) a.push(v); else if (!el.checked && i >= 0) a.splice(i, 1);
    renderAll();
  });
  $('#sb').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'clearf') for (const k of Object.keys(FIL)) FIL[k] = []; else if (b.dataset.clr) FIL[b.dataset.clr] = []; else return;
    renderAll();
  });
  window.addEventListener('resize', () => { /* charts redraw through ResizeObserver */ });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check(true);
  setInterval(() => { if (!document.hidden) check(); }, POLL_MS);
}
boot();

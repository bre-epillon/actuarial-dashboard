'use strict';
/* =====================================================================
   Reconciliation tool: Actuarial vs Finance, policy level.
   Data: data/recon_data.js (built by `python recon.py build`).
   ===================================================================== */
const RECON_D = ['GClmP_D', 'GClmO_D', 'GPrmB_D', 'Pipeline_D', 'GBrok_D', 'GDed_D'];
APP = {
  title: 'Reconciliation',
  lsKey: 'actdash.recon.v1',
  dataFile: 'data/recon_data.js',
  showTol: true,
  tabs: [['recon', 'Reconciliation', (page) => recon(page)], ['policies', 'Policies']],
  tableOf: () => 'policies',
  otherTool: { href: 'explorer.html', label: 'Explorer', title: 'Browse policies, claims and brokers; premium and claim charts' },
  openPolicy: (row) => openPolicy(row),
  onResize: () => { if (reconGrid) { reconGrid.last = null; reconGrid.paint(); } },
  presets: {
    policies: [
      { name: 'Reconciliation by Reserving LOB', view: { mode: 'group', groupBy: ['Reserving LOB'], measures: ['#rows', ...RECON_D] } },
      { name: 'Reconciliation by Broker', view: { mode: 'group', groupBy: ['Broker'], measures: ['#rows', ...RECON_D] } },
      { name: 'Policy list (deltas)', view: { mode: 'list', listCols: ['Policy', 'Source', 'UWY', 'Reserving LOB', 'Branch', 'Office', 'Policy Type', 'Reinsured'], measures: [...RECON_D] } },
      { name: 'Incurred by UWY (act vs fin)', view: { mode: 'group', groupBy: ['UWY'], measures: ['#rows', 'Incurred_A', 'Incurred_F', 'Incurred_D'] } },
      { name: 'Premium by Office × Policy Type', view: { mode: 'group', groupBy: ['Office', 'Policy Type'], measures: ['#rows', 'GPrmB_A', 'GPrmB_F', 'GPrmB_D'] } },
      { name: 'Premium by Reserving LOB × UWY (Δ)', view: { mode: 'group', groupBy: ['Reserving LOB'], colDim: 'UWY', measures: ['GPrmB_D'] } },
    ],
  },
};

/* --------------------------------------------------------------- recon */
let reconGrid = null;
function recon() {
  const P = T.policies, idx = filtered(P), page = $('#main'), R = S.recon, tol = S.tol;
  const col = (k, s) => P.cols.get(k + '_' + s).values;
  // summary
  const sum = RM.map((m) => {
    const a = col(m.key, 'A'), f = col(m.key, 'F'), d = col(m.key, 'D');
    let A = 0, F = 0, Dl = 0, abs = 0, n = 0;
    for (let j = 0; j < idx.length; j++) { const i = idx[j]; A += a[i]; F += f[i]; Dl += d[i]; const x = Math.abs(d[i]); abs += x; if (x > tol) n++; }
    return { m, A, F, D: Dl, abs, n };
  });
  const totAbs = sum.filter((s) => s.m.key !== 'Incurred').reduce((x, s) => x + Math.abs(s.D), 0);
  const isBad = (i) => (R.focus === 'any' ? MAIN.some((m) => Math.abs(col(m.key, 'D')[i]) > tol) : Math.abs(col(R.focus, 'D')[i]) > tol);
  let nBad = 0; for (let j = 0; j < idx.length; j++) if (isBad(idx[j])) nBad++;
  const focusLabel = R.focus === 'any' ? 'any measure' : RM.find((m) => m.key === R.focus).label;
  const a = META.actuarial, f = META.finance;

  const sumRows = sum.map((s) => `<tr class="click${R.focus === s.m.key ? ' sel' : ''}" data-focus="${s.m.key}">
      <td>${esc(s.m.label)}${s.m.key === 'Incurred' ? '<span class="tag">derived</span>' : ''}</td>
      <td class="n">${money(s.A)}</td><td class="n">${money(s.F)}</td><td class="n">${money(s.D)}</td>
      <td class="n">${s.F ? (100 * s.D / Math.abs(s.F)).toFixed(3) + '%' : '<span class="z">–</span>'}</td>
      <td class="n">${money(s.abs)}</td><td class="n">${count(s.n)}</td></tr>`).join('');

  const dimOpts = [...P.cols.values()].filter((c) => c.kind === 'dim' && c.name !== 'Policy' && c.dict.length < 3000).sort((x, y) => gi(x.group) - gi(y.group))
    .map((c) => `<option value="${esc(c.name)}" ${c.name === R.byDim ? 'selected' : ''}>${esc(c.label)}</option>`).join('');

  page.className = 'page scroll';
  page.innerHTML = `
  <section class="card">
    <div class="meta">
      <span>Actuarial: <b>${esc(a.file)}</b> [${esc(a.sheet)}] · as of <b>${esc(a.as_of || '?')}</b> · ${a.rows.toLocaleString()} rows</span>
      <span>Finance: <b>${esc(f.file)}</b> [${esc(f.sheet)}] · cutoff <b>${esc(f.as_of || '?')}</b> · ${f.rows.toLocaleString()} rows</span>
      <span>Built ${esc(META.built_at)}</span>
    </div>
    ${(META.warnings || []).map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
  </section>
  <section class="card">
    <h2>Reconciliation by measure <span class="muted" style="font-weight:400">${unitLabel()} · Δ = Actuarial − Finance · ${idx.length.toLocaleString()} policies in scope</span>
      <span class="r"><span class="muted">Total |Δ| across measures</span> <b>${money(totAbs)}</b></span></h2>
    <table class="t"><thead><tr><th>Measure</th><th class="n">Actuarial</th><th class="n">Finance</th><th class="n">Δ</th><th class="n">Δ / Finance</th><th class="n">Σ |Δ| by policy</th><th class="n"># policies |Δ| > ${esc(tol)}</th></tr></thead>
    <tbody>${sumRows}</tbody></table>
    <details class="map"><summary>How each measure is mapped</summary>
      <table class="t" style="margin-top:6px"><thead><tr><th>Measure</th><th>Actuarial (Measure codes)</th><th>Finance columns summed</th><th>Note</th></tr></thead><tbody>
      ${RM.map((m) => `<tr><td>${esc(m.label)}</td><td>${Object.entries(m.actuarial).map(([k, s]) => (s < 0 ? '− ' : '+ ') + k).join(' ')}</td><td>${m.key === 'Incurred' ? 'Total Paid Claims + Total Outstanding Claims' : esc(m.finance.join(' + ') || '(none)')}</td><td>${esc(m.note || '')}</td></tr>`).join('')}
      </tbody></table></details>
  </section>
  <div class="two">
    <section class="card">
      <h2>Δ by <select id="bydim" class="iconbtn">${dimOpts}</select><span class="muted" style="font-weight:400">${esc(focusLabel)}</span>
        <span class="r legend"><span><span class="sw" style="background:var(--pos)"></span>Actuarial higher</span><span><span class="sw" style="background:var(--neg)"></span>Finance higher</span></span></h2>
      <div class="scrollbox" id="byhost"></div>
    </section>
    <section class="card">
      <h2>Coverage <span class="muted" style="font-weight:400">policies by source</span></h2>
      <div id="covhost"></div>
    </section>
  </div>
  <section class="card">
    <h2>Discrepant policies <span class="muted" style="font-weight:400">${nBad.toLocaleString()} with |Δ| > ${esc(tol)} on ${esc(focusLabel)}</span>
      <span class="r"><label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="showall" ${R.showAll ? 'checked' : ''}>show matched policies too</label>
      ${R.focus !== 'any' ? '<button class="iconbtn" id="anyfocus">Show all measures</button>' : ''}<button class="iconbtn" id="rcsv">CSV</button></span></h2>
    <div class="recon-grid" id="rghost"></div>
  </section>`;

  // Δ by dimension
  const dc = P.cols.get(R.byDim) || P.cols.get('Reserving LOB');
  const nb = dc.dict.length, bA = new Float64Array(nb), bF = new Float64Array(nb), bD = new Float64Array(nb), bAbs = new Float64Array(nb), bN = new Int32Array(nb), bBad = new Int32Array(nb);
  const keys = R.focus === 'any' ? MAIN.map((m) => m.key) : [R.focus];
  const dA = keys.map((k) => col(k, 'A')), dF = keys.map((k) => col(k, 'F')), dD = keys.map((k) => col(k, 'D'));
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j], k = dc.codes[i]; bN[k]++; if (isBad(i)) bBad[k]++;
    for (let q = 0; q < keys.length; q++) { bA[k] += dA[q][i]; bF[k] += dF[q][i]; bD[k] += dD[q][i]; bAbs[k] += Math.abs(dD[q][i]); }
  }
  const present = []; for (let k = 0; k < nb; k++) if (bN[k]) present.push(k);
  const sortBy = R.focus === 'any' ? bAbs : bD;
  present.sort((x, y) => Math.abs(sortBy[y]) - Math.abs(sortBy[x]) || x - y);
  const maxD = Math.max(1e-9, ...present.map((k) => Math.abs(bD[k])));
  const bar = (v) => { const w = (50 * Math.abs(v) / maxD).toFixed(1); return `<div class="dbar" title="${esc(nf(0).format(v))}"><span class="${v >= 0 ? 'p' : 'm'}" style="width:${w}%"></span></div>`; };
  const anyMode = R.focus === 'any';
  $('#byhost').innerHTML = `<table class="t"><thead><tr><th>${esc(dc.label)}</th><th class="n">Policies</th><th class="n">Discrepant</th>
      ${anyMode ? '<th class="n">Σ |Δ| (all measures)</th><th class="n">Net Δ</th>' : '<th class="n">Actuarial</th><th class="n">Finance</th><th class="n">Δ</th>'}<th style="width:30%">${anyMode ? 'Net Δ' : 'Δ'}</th></tr></thead><tbody>
      ${present.map((k) => `<tr class="click" data-by="${k}"><td>${esc(dval(dc, k))}</td><td class="n">${count(bN[k])}</td><td class="n">${count(bBad[k])}</td>
        ${anyMode ? `<td class="n">${money(bAbs[k])}</td><td class="n">${money(bD[k])}</td>` : `<td class="n">${money(bA[k])}</td><td class="n">${money(bF[k])}</td><td class="n">${money(bD[k])}</td>`}
        <td>${bar(bD[k])}</td></tr>`).join('')}
    </tbody></table>`;

  // coverage
  const sc = P.cols.get('Source'), cov = new Map();
  const ck = R.focus === 'any' ? 'GPrmB' : R.focus;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j], k = sc.codes[i]; const e = cov.get(k) || { n: 0, A: 0, F: 0 };
    e.n++; e.A += col(ck, 'A')[i]; e.F += col(ck, 'F')[i]; cov.set(k, e);
  }
  const ckl = RM.find((m) => m.key === ck).label;
  $('#covhost').innerHTML = `<div class="muted" style="font-size:12px;margin:-4px 0 6px">${esc(ckl)}</div><table class="t"><thead><tr><th>Source</th><th class="n">Policies</th><th class="n">Actuarial</th><th class="n">Finance</th></tr></thead><tbody>
    ${[...cov.entries()].sort((x, y) => x[0] - y[0]).map(([k, e]) => `<tr class="click" data-src="${k}"><td>${esc(dval(sc, k))}</td><td class="n">${count(e.n)}</td><td class="n">${money(e.A)}</td><td class="n">${money(e.F)}</td></tr>`).join('')}
    </tbody></table><p class="muted" style="margin:8px 0 0;font-size:12px">Click a row to filter. Policies in one source only show their full amount as Δ.</p>`;

  // discrepancy grid
  const rows = []; for (let j = 0; j < idx.length; j++) { const i = idx[j]; if (R.showAll || isBad(i)) rows.push(i); }
  const dims = ['Policy', 'Source', 'UWY', 'Reserving LOB', 'Branch', 'Office', 'Policy Type'].map((n) => P.cols.get(n)).filter(Boolean);
  const cols = dims.map((c) => ({
    id: 'd:' + c.name, label: c.label, num: false, w: c.name === 'Policy' ? 140 : dimWidth(c, rows.slice(0, 300).map((i) => c.codes[i])),
    html: (i) => esc(dval(c, c.codes[i])), raw: (i) => dval(c, c.codes[i]), sortKey: (i) => c.codes[i],
    link: c.name === 'Policy', onClick: (i) => (c.name === 'Policy' ? APP.openPolicy(i) : (addFilterValue(c.name, c.dict[c.codes[i]]), update())),
  }));
  const numCol = (key, s, label) => {
    const vals = col(key, s); let tot = 0; for (const i of rows) tot += vals[i];
    return { id: `m:${key}_${s}`, label, num: true, html: (i) => money(vals[i]), raw: (i) => vals[i], total: money(tot), totalRaw: tot,
      cls: s === 'D' ? (i) => (Math.abs(vals[i]) > tol ? 'bad' : '') : null };
  };
  if (R.focus === 'any') {
    cols.push({ id: 'maxabs', label: 'max |Δ|', num: true, html: (i) => money(Math.max(...MAIN.map((m) => Math.abs(col(m.key, 'D')[i])))), raw: (i) => Math.max(...MAIN.map((m) => Math.abs(col(m.key, 'D')[i]))) });
    MAIN.forEach((m) => cols.push(numCol(m.key, 'D', m.label + ' · Δ')));
  } else {
    const m = RM.find((x) => x.key === R.focus);
    cols.push(numCol(m.key, 'A', m.label + ' · Act'), numCol(m.key, 'F', m.label + ' · Fin'), numCol(m.key, 'D', m.label + ' · Δ'));
    MAIN.filter((x) => x.key !== m.key).forEach((x) => cols.push(numCol(x.key, 'D', x.label + ' · Δ')));
  }
  cols.forEach((c) => { if (!c.w) c.w = numWidth(c.label); });
  const defSort = { id: R.focus === 'any' ? 'maxabs' : `m:${R.focus}_D`, dir: -1, abs: true };
  const sort = R.sort && cols.some((c) => c.id === R.sort.id) ? R.sort : defSort;
  const sc2 = cols.find((c) => c.id === sort.id);
  if (sort.abs) { const key = sc2.raw; rows.sort((x, y) => Math.abs(key(y)) - Math.abs(key(x))); } else sortRows(rows, cols, sort);
  reconGrid = new Grid($('#rghost'));
  reconGrid.set({ cols, rows, total: { label: 'Total' }, sort, onSort: (id) => { R.sort = R.sort && R.sort.id === id ? { id, dir: -R.sort.dir } : { id, dir: cols.find((c) => c.id === id).num ? -1 : 1 }; save(); renderMain(); } });

  // wiring
  page.querySelectorAll('[data-focus]').forEach((tr) => tr.onclick = () => { pushHist(); R.focus = R.focus === tr.dataset.focus ? 'any' : tr.dataset.focus; R.sort = null; update(); });
  $('#bydim').onchange = (e) => { R.byDim = e.target.value; save(); renderMain(); };
  page.querySelectorAll('[data-by]').forEach((tr) => tr.onclick = () => { addFilterValue(dc.name, dc.dict[+tr.dataset.by], false); update(); });
  page.querySelectorAll('[data-src]').forEach((tr) => tr.onclick = () => { addFilterValue('Source', sc.dict[+tr.dataset.src]); update(); });
  $('#showall').onchange = (e) => { R.showAll = e.target.checked; save(); renderMain(); };
  const af = $('#anyfocus'); if (af) af.onclick = () => { pushHist(); R.focus = 'any'; R.sort = null; update(); };
  $('#rcsv').onclick = () => reconGrid.csv(`reconciliation_${R.focus}_${new Date().toISOString().slice(0, 10)}.csv`, true);
}

/* -------------------------------------------------------------- drawer */
function openPolicy(row) {
  const P = T.policies, get = (n) => { const c = P.cols.get(n); return c ? (c.kind === 'dim' ? c.dict[c.codes[row]] : c.values[row]) : null; };
  const ref = get('Policy'), tol = S.tol;
  const attrs = (group) => [...P.cols.values()].filter((c) => c.kind === 'dim' && c.group === group)
    .map((c) => [c.label, c.dict[c.codes[row]]]).filter(([, v]) => v !== null && v !== '');
  const kv = (list) => list.map(([k, v]) => `<div><span>${esc(k)}</span><span title="${esc(v)}">${esc(v)}</span></div>`).join('');
  const recRows = RM.map((m) => {
    const A = get(m.key + '_A'), F = get(m.key + '_F'), Dl = get(m.key + '_D'), bad = Math.abs(Dl) > tol;
    return `<tr><td>${esc(m.label)}</td><td class="n">${money(A)}</td><td class="n">${money(F)}</td><td class="n"${bad ? ' style="background:var(--bad-bg);color:var(--bad-text);font-weight:600"' : ''}>${money(Dl)}</td></tr>`;
  }).join('');
  const fin = [...P.cols.values()].filter((c) => c.group === 'Finance (all columns)' && Math.abs(c.values[row]) > 0.005);
  const finHtml = fin.length ? `<div class="kv">${fin.map((c) => `<div><span title="${esc(c.label)}">${esc(c.label)}</span><span style="margin-left:auto">${money(c.values[row])}</span></div>`).join('')}</div>` : '<p class="muted">Not in the finance file.</p>';
  const nCl = get('Claims_N'), nOpen = get('OpenClaims_N');
  const dr = $('#drawer');
  dr.innerHTML = `<header><h3>${esc(ref)}</h3><span class="tag">${esc(get('Source'))}</span><span class="spacer"></span>
      <button class="iconbtn" id="dcopy">Copy ref</button><a class="iconbtn navlink" href="explorer.html#policy=${encodeURIComponent(ref)}" target="_blank" rel="noopener" title="Premium and claim charts, claims and postings of this policy">Open in Explorer ↗</a><button class="iconbtn" id="dclose" title="Close (Esc)">✕</button></header>
    <div class="body">
      <div><h4>Reconciliation <span class="muted" style="font-weight:400">${unitLabel()} · ${nCl ? count(nCl) + ' claims (' + count(nOpen) + ' open)' : 'no claims'}</span></h4><table class="t"><thead><tr><th>Measure</th><th class="n">Actuarial</th><th class="n">Finance</th><th class="n">Δ</th></tr></thead><tbody>${recRows}</tbody></table></div>
      <div class="kv">${kv(attrs('Actuarial'))}${kv(attrs('Finance'))}</div>
      <div><h4>Finance production file - non-zero columns</h4>${finHtml}</div>
    </div>`;
  dr.classList.add('open');
  $('#dclose').onclick = closeDrawer;
  $('#dcopy').onclick = () => { navigator.clipboard?.writeText(ref); $('#dcopy').textContent = 'Copied'; };
}

boot();

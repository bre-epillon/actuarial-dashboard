'use strict';
/* =====================================================================
   Tiny inline-SVG line chart: crosshair + tooltip, legend, table view,
   dashed reference lines. No dependencies.
   spec = { xs: [label], xTitle, series: [{ name, color, vals }], refs: [{ name, color, value }],
            fmt(v) -> tooltip text, ariaLabel, empty }
   ===================================================================== */
function niceTicks(lo, hi, n = 5) {
  if (lo === hi) hi = lo + 1;
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), f = step0 / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step, t = [];
  for (let v = a; v <= b + step / 2; v += step) t.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return t;
}
function shortNum(v) {
  const a = Math.abs(v), s = v < 0 ? '−' : '', t = (x, d) => (x >= d ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, '');
  if (a >= 1e9) return s + t(a / 1e9, 10) + 'bn';
  if (a >= 1e6) return s + t(a / 1e6, 10) + 'm';
  if (a >= 1e3) return s + t(a / 1e3, 10) + 'k';
  return s + Math.round(a);
}

function lineChart(host, spec) {
  host._spec = spec;
  host.classList.add('chart');
  const draw = () => {
    const sp = host._spec, n = sp.xs.length, mode = host._mode || 'chart';
    if (!n) { host.innerHTML = `<div class="empty">${sp.empty || 'No data in scope.'}</div>`; return; }
    const legend = `<div class="legend lg-row">${sp.series.map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}${(sp.refs || []).map((r) => `<span class="lg"><i class="dash" style="--c:${r.color}"></i>${esc(r.name)}</span>`).join('')}</div>`;
    if (mode === 'table') {
      host.innerHTML = legend + `<div class="scrollbox" style="max-height:300px"><table class="t"><thead><tr><th>${esc(sp.xTitle || '')}</th>${sp.series.map((s) => `<th class="n">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>
        ${sp.xs.map((x, i) => `<tr><td>${esc(x)}</td>${sp.series.map((s) => `<td class="n">${sp.fmt(s.vals[i])}</td>`).join('')}</tr>`).join('')}</tbody>
        ${(sp.refs || []).length ? `<tfoot>${sp.refs.map((r) => `<tr><td>${esc(r.name)}</td><td class="n" colspan="${sp.series.length}">${sp.fmt(r.value)}</td></tr>`).join('')}</tfoot>` : ''}</table></div>`;
      return;
    }
    const W = Math.max(300, host.clientWidth || 640), H = 280, m = { l: 52, r: 14, t: 10, b: 30 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    host._w = host.clientWidth;
    let lo = 0, hi = 0;
    for (const s of sp.series) for (const v of s.vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (const r of sp.refs || []) { lo = Math.min(lo, r.value); hi = Math.max(hi, r.value); }
    const ticks = niceTicks(lo, hi, 5), y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const X = (i) => m.l + (n <= 1 ? pw / 2 : (pw * i) / (n - 1));
    const Y = (v) => m.t + ph * (1 - (v - y0) / (y1 - y0 || 1));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(sp.ariaLabel || '')}">`;
    for (const t of ticks) {
      svg += `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${m.l}" x2="${m.l + pw}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ax" x="${m.l - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${shortNum(t)}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 64))));
    for (let i = 0; i < n; i += step) svg += `<text class="ax" x="${X(i).toFixed(1)}" y="${H - 9}" text-anchor="middle">${esc(sp.xs[i])}</text>`;
    for (const s of sp.series) {
      if (n === 1) { svg += `<circle cx="${X(0)}" cy="${Y(s.vals[0]).toFixed(1)}" r="4" fill="${s.color}"/>`; continue; }
      svg += `<path d="${s.vals.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    let prevLabel = -1e9;
    for (const r of [...(sp.refs || [])].sort((a, b) => b.value - a.value)) {
      const y = Y(r.value), ly = Math.max(y - 5, prevLabel + 13); prevLabel = ly;
      svg += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${r.color}" stroke-width="1.5" stroke-dasharray="6 4"/><text class="rl" x="${m.l + pw - 4}" y="${ly.toFixed(1)}" text-anchor="end">${esc(r.name)}</text>`;
    }
    svg += `<g class="hov" style="display:none"><line class="vl" y1="${m.t}" y2="${m.t + ph}"/>${sp.series.map((s) => `<circle r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('')}</g>`;
    svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/></svg>`;
    host.innerHTML = legend + `<div class="cv">${svg}<div class="tip" style="display:none"></div></div>`;
    const cv = host.querySelector('.cv'), tip = cv.querySelector('.tip'), hov = cv.querySelector('.hov'), dots = hov.querySelectorAll('circle'), vl = hov.querySelector('.vl');
    const move = (e) => {
      const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) * (W / r.width);
      const i = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((mx - m.l) / pw) * (n - 1))));
      const x = X(i);
      hov.style.display = ''; vl.setAttribute('x1', x); vl.setAttribute('x2', x);
      sp.series.forEach((s, k) => { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', Y(s.vals[i])); });
      tip.innerHTML = `<div class="th">${esc(sp.xs[i])}</div>${sp.series.map((s) => `<div><i style="background:${s.color}"></i><span>${esc(s.name)}</span><b>${sp.fmt(s.vals[i])}</b></div>`).join('')}`;
      tip.style.display = '';
      const px = (x / W) * r.width, tw = tip.offsetWidth;
      tip.style.left = (px + 14 + tw > r.width ? px - 14 - tw : px + 14) + 'px';
      tip.style.top = '8px';
    };
    const out = () => { hov.style.display = 'none'; tip.style.display = 'none'; };
    const hit = cv.querySelector('.hit');
    hit.addEventListener('mousemove', move); hit.addEventListener('mouseleave', out);
    hit.addEventListener('touchmove', (e) => { move(e.touches[0]); e.preventDefault(); }, { passive: false });
  };
  host._draw = draw;
  if (!host._ro && typeof ResizeObserver !== 'undefined') {
    host._ro = new ResizeObserver(() => { if (host._mode !== 'table' && host._w !== host.clientWidth && host.clientWidth) draw(); });
    host._ro.observe(host);
  }
  draw();
}

/* ---------------------------------------------------------------------------
   Grouped vertical bars (one group per category), same look and hover as lineChart.
   spec = { cats: [label], xTitle, series: [{ name, color, vals }], fmt(v), ariaLabel, empty }
   --------------------------------------------------------------------------- */
function barChart(host, spec) {
  host._spec = spec;
  host.classList.add('chart');
  const draw = () => {
    const sp = host._spec, n = sp.cats.length, mode = host._mode || 'chart', k = sp.series.length;
    if (!n) { host.innerHTML = `<div class="empty">${sp.empty || 'No data in scope.'}</div>`; return; }
    const legend = `<div class="legend lg-row">${sp.series.map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
    if (mode === 'table') {
      host.innerHTML = legend + `<div class="scrollbox" style="max-height:300px"><table class="t"><thead><tr><th>${esc(sp.xTitle || '')}</th>${sp.series.map((s) => `<th class="n">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>
        ${sp.cats.map((x, i) => `<tr><td>${esc(x)}</td>${sp.series.map((s) => `<td class="n">${sp.fmt(s.vals[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      return;
    }
    const W = Math.max(300, host.clientWidth || 640), H = 280, m = { l: 52, r: 10, t: 10, b: 30 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    host._w = host.clientWidth;
    let lo = 0, hi = 0;
    for (const s of sp.series) for (const v of s.vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const ticks = niceTicks(lo, hi, 5), y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const Y = (v) => m.t + ph * (1 - (v - y0) / (y1 - y0 || 1)), yz = Y(0);
    const gw = pw / n, bw = Math.max(3, Math.min(26, (gw * 0.78 - (k - 1) * 2) / k)), groupW = k * bw + (k - 1) * 2;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(sp.ariaLabel || '')}"><rect class="band" x="0" y="${m.t}" width="${gw}" height="${ph}" style="display:none"/>`;
    for (const t of ticks) svg += `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${m.l}" x2="${m.l + pw}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ax" x="${m.l - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${shortNum(t)}</text>`;
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 46))));
    for (let i = 0; i < n; i += step) svg += `<text class="ax" x="${(m.l + gw * (i + 0.5)).toFixed(1)}" y="${H - 9}" text-anchor="middle">${esc(sp.cats[i])}</text>`;
    // bars: 4px rounded data end, anchored to the baseline
    sp.series.forEach((s, j) => s.vals.forEach((v, i) => {
      if (!v) return;
      const x = m.l + gw * i + (gw - groupW) / 2 + j * (bw + 2), y = Y(v), r = Math.min(4, bw / 2, Math.abs(yz - y));
      const d = v >= 0
        ? `M${x.toFixed(1)} ${yz.toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)} ${y.toFixed(1)} ${(x + bw).toFixed(1)} ${(y + r).toFixed(1)}V${yz.toFixed(1)}Z`
        : `M${x.toFixed(1)} ${yz.toFixed(1)}V${(y - r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)} ${y.toFixed(1)} ${(x + bw).toFixed(1)} ${(y - r).toFixed(1)}V${yz.toFixed(1)}Z`;
      svg += `<path d="${d}" fill="${s.color}"/>`;
    }));
    svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/></svg>`;
    host.innerHTML = legend + `<div class="cv">${svg}<div class="tip" style="display:none"></div></div>`;
    const cv = host.querySelector('.cv'), tip = cv.querySelector('.tip'), band = cv.querySelector('.band');
    const move = (e) => {
      const r = cv.getBoundingClientRect(), mx = (e.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.floor((mx - m.l) / gw)));
      band.style.display = ''; band.setAttribute('x', m.l + gw * i);
      tip.innerHTML = `<div class="th">${esc(sp.cats[i])}</div>${sp.series.map((s) => `<div><i style="background:${s.color}"></i><span>${esc(s.name)}</span><b>${sp.fmt(s.vals[i])}</b></div>`).join('')}`;
      tip.style.display = '';
      const px = ((m.l + gw * (i + 0.5)) / W) * r.width, tw = tip.offsetWidth;
      tip.style.left = (px + 14 + tw > r.width ? px - 14 - tw : px + 14) + 'px'; tip.style.top = '8px';
    };
    const hit = cv.querySelector('.hit');
    hit.addEventListener('mousemove', move);
    hit.addEventListener('mouseleave', () => { band.style.display = 'none'; tip.style.display = 'none'; });
  };
  host._draw = draw;
  if (!host._ro && typeof ResizeObserver !== 'undefined') {
    host._ro = new ResizeObserver(() => { if (host._mode !== 'table' && host._w !== host.clientWidth && host.clientWidth) draw(); });
    host._ro.observe(host);
  }
  draw();
}

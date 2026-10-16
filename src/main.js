import './style.css';
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { sumProps } from './meshAnalysis.js';
import { groupParts, partsCsv } from './partsList.js';
import { Measurements } from './measure.js';
import { buildSheet, sheetToDxf, sheetToSvg } from './dxf/dxfExport.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── state ──────────────────────────────────────────────────────────────────
const viewer = new Viewer($('#canvasHost'));
const measure = new Measurements(viewer, $('#labels'), $('#measureList'), $('#measureHint'));
const parts = [];      // index = part id
const nodes = [];      // index = node id: { id, name, parent, children, partIds, el, row, expanded }
const files = [];      // { name, unit, rootId, parts, ms }
let selectedNode = null;
let partCounter = 0;
let fileCounter = 0;

const PALETTE = ['#9fb3c8', '#c8b49f', '#a9c89f', '#c89fb8', '#9fc8c4', '#c8c39f', '#b0a4d1', '#d1a4a4', '#a4bfd1', '#bfcfa0'];
const nameColor = new Map();
function defaultColor(name, fileColor) {
  if (fileColor) return new THREE.Color(fileColor[0], fileColor[1], fileColor[2]);
  if (!nameColor.has(name)) nameColor.set(name, PALETTE[nameColor.size % PALETTE.length]);
  return new THREE.Color(nameColor.get(name));
}

// ── number formatting ──────────────────────────────────────────────────────
const nf = (v, d = 1) => Number.isFinite(v) ? v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const ng = (v) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  return a >= 1e5 ? nf(v, 0) : a >= 100 ? nf(v, 1) : a >= 1 ? nf(v, 3) : v.toPrecision(4);
};
function density() {
  const v = $('#material').value;
  return v === 'custom' ? (parseFloat($('#customDensity').value) || 0) : parseFloat(v);
}
function materialName() {
  const o = $('#material').selectedOptions[0];
  return $('#material').value === 'custom' ? `Custom (${density()} kg/m³)` : o.textContent;
}

// ── toasts & progress ──────────────────────────────────────────────────────
function toast(msg, kind = '', ms = 5000) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 12000 : ms);
}
function showProgress(text, frac, busy) {
  $('#progress').hidden = false;
  $('#progressText').textContent = text;
  $('#progressBar').style.width = Math.round((frac || 0) * 100) + '%';
  $('#progressBar').classList.toggle('busy', !!busy);
}
const hideProgress = () => { $('#progress').hidden = true; };

// ── loading files ──────────────────────────────────────────────────────────
let worker = null;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    const job = pending.get(m.id);
    if (!job) return;
    if (m.type === 'progress') job.onProgress(m.stage, m.frac);
    else { pending.delete(m.id); job.resolve(m); }
  };
  worker.onerror = (e) => {
    for (const job of pending.values()) job.resolve({ ok: false, error: e.message || 'worker failed', name: job.name });
    pending.clear();
    worker = null;
  };
  return worker;
}

function formatOf(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'stp' || ext === 'step') return 'step';
  if (ext === 'igs' || ext === 'iges') return 'iges';
  return null;
}

let queue = Promise.resolve();
function openFiles(fileList) {
  for (const f of fileList) queue = queue.then(() => openOne(f.name, () => f.arrayBuffer(), f.size));
  return queue;
}

async function openOne(name, getBuffer, size) {
  const format = formatOf(name);
  if (!format) { toast(`${name}: not a STEP or IGES file (.stp, .step, .igs, .iges)`, 'error'); return; }
  const t0 = performance.now();
  showProgress(`${name} (${(size / 1e6).toFixed(1)} MB): reading file`, 0.02, true);
  let res;
  try {
    const buffer = await getBuffer();
    const id = ++fileCounter;
    res = await new Promise((resolve) => {
      pending.set(id, {
        name, resolve,
        onProgress: (stage, frac) => showProgress(`${name}: ${stage}…`, frac, frac < 0.6),
      });
      getWorker().postMessage({ id, name, buffer, format, quality: $('#quality').value }, [buffer]);
    });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  hideProgress();
  if (!res.ok) { toast(`Could not open ${name}: ${res.error}`, 'error'); return; }
  const ms = performance.now() - t0;
  addModel(name, res, ms);
}

function addModel(fileName, res, ms) {
  const firstModel = parts.length === 0;
  const file = { name: fileName, unit: res.unit, parts: res.meshes.length, ms };
  files.push(file);
  let partNo = 0;
  const mkNode = (name, parent) => {
    const n = { id: nodes.length, name, parent, children: [], partIds: [], expanded: false };
    nodes.push(n);
    if (parent) parent.children.push(n);
    return n;
  };
  const root = mkNode(fileName, null);
  root.expanded = true;
  root.file = file;
  file.rootId = root.id;

  const addPart = (node, meshIndex, nameHint) => {
    const m = res.meshes[meshIndex];
    const name = nameHint || m.name || `Part ${++partNo}`;
    const part = {
      id: partCounter++, name, nodeId: node.id, visible: true, file: fileName,
      analysis: m.analysis, color: defaultColor(name, m.color),
    };
    parts[part.id] = part;
    viewer.addPart(part, m);
    node.partIds.push(part.id);
  };

  const walk = (src, parent, depth) => {
    // collapse the unnamed top-level wrapper occt adds
    const meshes = src.meshes || [];
    const kids = src.children || [];
    if (depth === 0 && !src.name && meshes.length === 0) { kids.forEach(c => walk(c, parent, depth + 1)); return; }
    const name = src.name || (meshes.length === 1 && res.meshes[meshes[0]].name) || '';
    const node = mkNode(name, parent);
    if (meshes.length === 1 && kids.length === 0) {
      addPart(node, meshes[0], name || null);
      if (!node.name) node.name = parts[node.partIds[0]].name;
    } else {
      meshes.forEach((mi, k) => {
        const child = mkNode(res.meshes[mi].name || `${name || 'Solid'} ${k + 1}`, node);
        addPart(child, mi, child.name);
      });
      kids.forEach(c => walk(c, node, depth + 1));
      if (!node.name) node.name = `Assembly ${node.id}`;
    }
  };
  walk(res.root, root, 0);
  if (root.children.length === 1 && root.children[0].children.length) root.children[0].expanded = true;

  renderFiles();
  renderTree();
  viewer.refreshAppearance();
  updateSectionRange();
  $('#empty').hidden = true;
  if (firstModel) viewer.setView('iso');
  renderParts();
  toast(`Opened ${fileName}: ${res.meshes.length} part${res.meshes.length === 1 ? '' : 's'} in ${(ms / 1000).toFixed(1)} s`);
}

function renderFiles() {
  $('#fileList').innerHTML = files.map(f => `<div class="file"><b>${esc(f.name)}</b><br>
    <span class="muted">Units in file: ${esc(f.unit)}${f.unit !== 'mm' ? ' → shown in mm' : ''} · ${f.parts} part${f.parts === 1 ? '' : 's'} · ${(f.ms / 1000).toFixed(1)} s</span></div>`).join('');
}

function closeAll() {
  viewer.clear();
  measure.clear();
  parts.length = 0; nodes.length = 0; files.length = 0; nameColor.clear();
  partCounter = 0;
  selectedNode = null;
  renderFiles(); renderTree(); renderProps(); renderParts();
  $('#empty').hidden = false;
  setSectionAxis('');
}

// ── tree ───────────────────────────────────────────────────────────────────
function nodeParts(n, out = []) {
  out.push(...n.partIds);
  for (const c of n.children) nodeParts(c, out);
  return out;
}
function nodePath(n) {
  const names = [];
  for (let x = n; x; x = x.parent) names.unshift(x.name);
  return names.join(' / ');
}

function renderTree() {
  const host = $('#tree');
  host.innerHTML = '';
  const filter = $('#treeFilter').value.trim().toLowerCase();
  const matches = (n) => !filter || n.name.toLowerCase().includes(filter) || n.children.some(matches);
  const build = (n, depth, parentEl) => {
    if (!matches(n)) return;
    const el = document.createElement('div');
    el.className = 'node';
    el.setAttribute('role', 'treeitem');
    const row = document.createElement('div');
    row.className = 'row-n';
    row.style.paddingLeft = (depth * 14) + 'px';
    const ids = nodeParts(n);
    const hasKids = n.children.length > 0;
    const anyVisible = ids.some(id => parts[id].visible);
    const color = ids.length ? '#' + parts[ids[0]].color.getHexString() : '#999999';
    row.innerHTML = `<span class="caret">${hasKids ? (n.expanded || filter ? '▾' : '▸') : ''}</span>
      <input type="checkbox" class="vis" title="Show / hide" ${anyVisible ? 'checked' : ''}>
      <input type="color" class="swatch" title="Colour" value="${color}">
      <span class="name ${anyVisible ? '' : 'hidden-part'}" title="${esc(nodePath(n))}">${esc(n.name)}${ids.length > 1 ? ` <span class="muted">(${ids.length})</span>` : ''}</span>
      <button class="iso small" title="Isolate">Isolate</button>`;
    el.appendChild(row);
    n.el = el; n.row = row;
    row.querySelector('.caret').addEventListener('click', (e) => { e.stopPropagation(); n.expanded = !n.expanded; renderTree(); });
    row.querySelector('.vis').addEventListener('click', (e) => {
      e.stopPropagation();
      const on = e.target.checked;
      for (const id of ids) parts[id].visible = on;
      viewer.refreshAppearance(); renderTree(); if (viewer.section.caps) viewer.setSection({});
    });
    row.querySelector('.swatch').addEventListener('click', (e) => e.stopPropagation());
    row.querySelector('.swatch').addEventListener('input', (e) => {
      for (const id of ids) parts[id].color.set(e.target.value);
      viewer.refreshAppearance();
    });
    row.querySelector('.iso').addEventListener('click', (e) => { e.stopPropagation(); isolate(ids); });
    row.addEventListener('click', (e) => selectNode(n, e.ctrlKey || e.metaKey || e.shiftKey, true));
    row.addEventListener('dblclick', () => { n.expanded = !n.expanded; renderTree(); });
    if (hasKids) {
      const kids = document.createElement('div');
      kids.className = 'children';
      kids.hidden = !(n.expanded || filter);
      n.children.forEach(c => build(c, depth + 1, kids));
      el.appendChild(kids);
    }
    parentEl.appendChild(el);
  };
  nodes.filter(n => !n.parent).forEach(n => build(n, 0, host));
  syncTreeSelection(false);
}

function syncTreeSelection(scroll) {
  for (const n of nodes) {
    if (!n.row) continue;
    const ids = nodeParts(n);
    const sel = n === selectedNode || (ids.length > 0 && n.partIds.length > 0 && n.children.length === 0 && ids.every(id => viewer.selected.has(id)));
    n.row.classList.toggle('selected', sel);
  }
  if (scroll) {
    const first = nodes.find(n => n.row && n.row.classList.contains('selected'));
    if (first) first.row.scrollIntoView({ block: 'nearest' });
  }
}

function expandTo(node) {
  let changed = false;
  for (let x = node.parent; x; x = x.parent) if (!x.expanded) { x.expanded = true; changed = true; }
  if (changed) renderTree();
}

// ── selection ──────────────────────────────────────────────────────────────
function setSelection(ids, additive) {
  if (!additive) viewer.selected.clear();
  for (const id of ids) {
    if (additive && viewer.selected.has(id) && ids.length === 1) viewer.selected.delete(id);
    else viewer.selected.add(id);
  }
  viewer.refreshAppearance();
  renderProps();
  syncTreeSelection(true);
  markPartsRows();
}

function selectNode(n, additive, frame) {
  selectedNode = additive ? null : n;
  const ids = nodeParts(n);
  setSelection(ids, additive);
  if (frame && ids.length) viewer.fit([...viewer.selected]);
}

function selectPart(id, additive) {
  const p = parts[id];
  const node = nodes[p.nodeId];
  selectedNode = additive ? null : node;
  expandTo(node);
  setSelection([id], additive);
}

function isolate(ids) {
  viewer.isolated = new Set(ids);
  viewer.refreshAppearance();
  viewer.fit(ids);
  if (viewer.section.axis) viewer.setSection({});
  toast('Isolated ' + ids.length + ' part' + (ids.length === 1 ? '' : 's') + ' — "Show all" to undo', '', 3000);
}

function showAll() {
  viewer.isolated = null;
  for (const p of parts) if (p) p.visible = true;
  viewer.refreshAppearance();
  renderTree();
  if (viewer.section.axis) viewer.setSection({});
}

// ── properties ─────────────────────────────────────────────────────────────
let lastPropsText = '';
function renderProps() {
  const ids = [...viewer.selected];
  const host = $('#props');
  const chip = $('#selChip');
  if (!ids.length) {
    host.innerHTML = '<p class="muted">Click a part in the view or the tree.</p>';
    lastPropsText = '';
    chip.hidden = true;
    return;
  }
  const s = sumProps(ids.map(id => parts[id].analysis));
  const rho = density();
  const massKg = s.volume * 1e-9 * rho;
  const size = [0, 1, 2].map(k => s.bboxMax[k] - s.bboxMin[k]);
  const single = ids.length === 1 ? parts[ids[0]] : null;
  const title = single ? single.name : selectedNode && nodeParts(selectedNode).length === ids.length ? selectedNode.name : `${ids.length} parts`;
  const path = single ? nodePath(nodes[single.nodeId]) : selectedNode && nodeParts(selectedNode).length === ids.length ? nodePath(selectedNode) : 'Multiple selection';
  const xyz = (v) => v.map(x => nf(x, 2)).join(', ');
  const openCount = ids.filter(id => !parts[id].analysis.closed).length;
  const rows = [
    ['Parts', ids.length],
    ['Size X × Y × Z', `${nf(size[0], 2)} × ${nf(size[1], 2)} × ${nf(size[2], 2)} mm`],
    ['Min corner', xyz(s.bboxMin) + ' mm'],
    ['Max corner', xyz(s.bboxMax) + ' mm'],
    ['Volume*', `${nf(s.volume, 1)} mm³<br>${s.volume >= 1e3 ? (s.volume * 1e-9).toPrecision(5) : (s.volume * 1e-9).toExponential(4)} m³`],
    ['Surface area*', `${nf(s.area, 1)} mm²`],
    ['Centroid*', xyz(s.centroid) + ' mm'],
    ['Mass*', `<b>${ng(massKg)} kg</b><br><span class="muted">${esc(materialName())}</span>`],
    ['Triangles', s.triangles.toLocaleString('en-GB')],
  ];
  host.innerHTML = `<h2>${esc(title)}</h2><div class="path">${esc(path)}</div>
    ${openCount ? `<div class="warn">⚠ ${openCount === ids.length && ids.length === 1 ? 'The mesh is not closed' : `${openCount} of ${ids.length} meshes are not closed`}: volume, centroid and mass are unreliable.</div>` : ''}
    <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    <p class="muted small">* from mesh, approx.</p>`;
  lastPropsText = [
    title, path, '',
    `Parts: ${ids.length}`,
    `Size X x Y x Z: ${size.map(v => v.toFixed(2)).join(' x ')} mm`,
    `Min corner: ${s.bboxMin.map(v => v.toFixed(2)).join(', ')} mm`,
    `Max corner: ${s.bboxMax.map(v => v.toFixed(2)).join(', ')} mm`,
    `Volume (from mesh, approx.): ${s.volume.toFixed(1)} mm3 = ${(s.volume * 1e-9).toPrecision(6)} m3`,
    `Surface area (from mesh, approx.): ${s.area.toFixed(1)} mm2`,
    `Centroid (from mesh, approx.): ${s.centroid.map(v => v.toFixed(2)).join(', ')} mm`,
    `Mass (from mesh, approx.): ${massKg.toPrecision(5)} kg (${materialName()}, ${rho} kg/m3)`,
    `Triangles: ${s.triangles}`,
    openCount ? `WARNING: ${openCount} mesh(es) not closed, volume unreliable` : 'Mesh closed: yes',
  ].join('\n');
  chip.hidden = false;
  chip.textContent = `${title} · ${nf(size[0], 1)}×${nf(size[1], 1)}×${nf(size[2], 1)} mm · ${ng(massKg)} kg ▸`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

// ── parts list ─────────────────────────────────────────────────────────────
let groups = [];
function renderParts() {
  const visOnly = $('#partsVisibleOnly').checked;
  const items = parts.filter(p => p && (!visOnly || viewer.partVisible(p))).map(p => ({ id: p.id, name: p.name, analysis: p.analysis }));
  groups = groupParts(items, { byGeometry: $('#groupGeom').checked });
  const rho = density();
  let tq = 0, tm = 0, tv = 0;
  const body = groups.map((g, i) => {
    const m = g.volume * 1e-9 * rho;
    tq += g.count; tm += m * g.count; tv += g.volume * g.count;
    return `<tr data-i="${i}"><td>${i + 1}</td><td class="n">${esc(g.name)}${g.closed ? '' : ' ⚠'}</td><td>${g.count}</td>
      <td>${g.size.map(v => nf(v, 1)).join(' × ')}</td><td>${nf(g.volume, 0)}</td><td>${ng(m)}</td><td>${ng(m * g.count)}</td></tr>`;
  }).join('');
  $('#partsTable').innerHTML = groups.length ? `<thead><tr><th>#</th><th class="n">Name</th><th>Qty</th><th>Size X×Y×Z mm</th><th>Vol. each mm³</th><th>Mass each kg</th><th>Mass total kg</th></tr></thead>
    <tbody>${body}</tbody><tfoot><tr><td></td><td class="n">Total</td><td>${tq}</td><td></td><td>${nf(tv, 0)}</td><td></td><td>${ng(tm)}</td></tr></tfoot>` : '<tbody><tr><td class="n muted">No parts loaded.</td></tr></tbody>';
  $$('#partsTable tbody tr[data-i]').forEach(tr => tr.addEventListener('click', (e) => {
    const g = groups[+tr.dataset.i];
    selectedNode = null;
    setSelection(g.ids, e.ctrlKey || e.metaKey || e.shiftKey);
  }));
  markPartsRows();
}
function markPartsRows() {
  $$('#partsTable tbody tr[data-i]').forEach(tr => {
    const g = groups[+tr.dataset.i];
    tr.classList.toggle('selected', g.ids.every(id => viewer.selected.has(id)));
  });
}

// ── picking in the 3D view ─────────────────────────────────────────────────
(function setupPointer() {
  const el = viewer.renderer.domElement;
  let down = null, longTimer = null, longFired = false;
  const active = new Set();
  el.addEventListener('pointerdown', (e) => {
    active.add(e.pointerId);
    if (active.size > 1) { down = null; clearTimeout(longTimer); return; }
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    longFired = false;
    if (e.pointerType === 'touch') {
      longTimer = setTimeout(() => {
        if (!down || measure.mode) return;
        longFired = true;
        const hit = viewer.pick(down.x, down.y);
        if (hit) { selectPart(hit.object.userData.partId, true); if (navigator.vibrate) navigator.vibrate(20); }
      }, 550);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; clearTimeout(longTimer); }
  });
  const end = (e) => {
    active.delete(e.pointerId);
    clearTimeout(longTimer);
    if (!down || longFired || e.type === 'pointercancel') { down = null; return; }
    const d = down; down = null;
    if (performance.now() - d.t > 600) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (measure.mode) { measure.click(e.clientX, e.clientY); return; }
    const hit = viewer.pick(e.clientX, e.clientY);
    if (hit) selectPart(hit.object.userData.partId, additive);
    else if (!additive) { selectedNode = null; setSelection([], false); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
})();

// ── section plane ──────────────────────────────────────────────────────────
let sectionRange = [0, 1];
function updateSectionRange() {
  const box = viewer.boundsOf(parts.filter(Boolean).map(p => p.id));
  const axis = viewer.section.axis;
  if (!axis || box.isEmpty()) return;
  const k = { x: 'x', y: 'y', z: 'z' }[axis];
  const pad = (box.max[k] - box.min[k]) * 0.001 + 1e-3;
  sectionRange = [box.min[k] - pad, box.max[k] + pad];
}
function sectionFromSlider() {
  const t = +$('#sectionSlider').value / 1000;
  const v = sectionRange[0] + (sectionRange[1] - sectionRange[0]) * t;
  $('#sectionValue').textContent = viewer.section.axis ? `${viewer.section.axis.toUpperCase()} = ${nf(v, 1)} mm` : '–';
  viewer.setSection({ value: v });
}
function setSectionAxis(axis) {
  $$('#sectionAxis button').forEach(b => b.classList.toggle('active', b.dataset.axis === axis));
  $('#sectionSlider').disabled = !axis;
  viewer.setSection({ axis: axis || null });
  if (axis) { updateSectionRange(); $('#sectionSlider').value = 500; sectionFromSlider(); }
  else $('#sectionValue').textContent = '–';
}

// ── DXF export ─────────────────────────────────────────────────────────────
let dxfText = null, dxfName = 'drawing.dxf';
async function generateDxf() {
  const scope = $('#dxfScope').value;
  let ids = scope === 'selection' ? [...viewer.selected] : parts.filter(p => p && viewer.partVisible(p) && !(viewer.isolated && !viewer.isolated.has(p.id))).map(p => p.id);
  if (!ids.length) { $('#dxfStatus').textContent = scope === 'selection' ? 'Select one or more parts first.' : 'No visible parts.'; return; }
  const views = $$('input[name="dxfView"]:checked').map(i => i.value);
  if (!views.length) { $('#dxfStatus').textContent = 'Tick at least one view.'; return; }
  $('#btnDxfPreview').disabled = true; $('#btnDxfDownload').disabled = true;
  const t0 = performance.now();
  try {
    const sel = ids.map(id => ({ geometry: parts[id].mesh.geometry, analysis: parts[id].analysis }));
    const sheet = await buildSheet(viewer.renderer, sel, {
      views, angle: $('#dxfAngle').value, hidden: $('#dxfHidden').checked, tangentEdges: $('#dxfTangent').checked,
      dims: $('#dxfDims').checked, isoTrueLength: $('#dxfIsoTrue').checked, resolution: +$('#dxfRes').value,
      current: viewer.viewBasis(),
    }, (msg) => { $('#dxfStatus').textContent = msg + '…'; });
    const base = (files.length === 1 ? files[0].name : 'models').replace(/\.[^.]+$/, '');
    const title = scope === 'selection' && ids.length === 1 ? `${base} – ${parts[ids[0]].name}` : base;
    dxfText = sheetToDxf(sheet, { title, hiddenLines: $('#dxfHidden').checked });
    dxfName = `${base}${scope === 'selection' ? '-selection' : ''}-views.dxf`;
    $('#dxfPreview').innerHTML = sheetToSvg(sheet, { hiddenLines: $('#dxfHidden').checked });
    const nVis = sheet.views.reduce((s, v) => s + v.visible.length, 0), nHid = sheet.views.reduce((s, v) => s + v.hidden.length, 0);
    $('#dxfStatus').textContent = `${sheet.views.length} view(s), ${nVis} visible and ${nHid} hidden polylines, ${(dxfText.length / 1e6).toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    $('#btnDxfDownload').disabled = false;
  } catch (e) {
    console.error(e);
    $('#dxfStatus').textContent = 'DXF export failed: ' + e.message;
  } finally {
    $('#btnDxfPreview').disabled = false;
    viewer.requestRender();
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

// ── UI wiring ──────────────────────────────────────────────────────────────
$('#fileInput').addEventListener('change', (e) => { openFiles([...e.target.files]); e.target.value = ''; });
$$('#empty [data-sample]').forEach(b => b.addEventListener('click', () => {
  const name = b.dataset.sample;
  queue = queue.then(() => openOne(name, async () => {
    const r = await fetch(`./samples/${name}`);
    if (!r.ok) throw new Error(`sample not found (HTTP ${r.status})`);
    return r.arrayBuffer();
  }, 0));
}));
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  if (e.dataTransfer && e.dataTransfer.files.length) openFiles([...e.dataTransfer.files]);
});

$('#btnFit').addEventListener('click', () => viewer.fit());
$('#btnFitSel').addEventListener('click', () => viewer.fit(viewer.selected.size ? [...viewer.selected] : null));
$('#viewSelect').addEventListener('change', (e) => { if (e.target.value) viewer.setView(e.target.value); e.target.value = ''; });
$$('[data-view]').forEach(b => b.addEventListener('click', () => viewer.setView(b.dataset.view)));

function setOrtho(on) {
  viewer.setOrtho(on);
  $('#btnOrtho').classList.toggle('on', on); $('#chkOrtho').checked = on;
}
$('#btnOrtho').addEventListener('click', () => setOrtho(viewer.camera !== viewer.ortho));
$('#chkOrtho').addEventListener('change', (e) => setOrtho(e.target.checked));
function setEdges(on) { viewer.setEdges(on); $('#btnEdges').classList.toggle('on', on); $('#chkEdges').checked = on; }
$('#btnEdges').addEventListener('click', () => setEdges(!viewer.edgesOn));
$('#chkEdges').addEventListener('change', (e) => setEdges(e.target.checked));
$('#chkGhost').addEventListener('change', (e) => { viewer.ghost = e.target.checked; viewer.refreshAppearance(); });
$('#opacity').addEventListener('input', (e) => { viewer.opacityOthers = +e.target.value; viewer.refreshAppearance(); });

function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  viewer.setTheme(dark ? 'dark' : 'light');
  $('#btnTheme').textContent = dark ? 'Light' : 'Dark';
  $('#chkDark').checked = dark;
  try { localStorage.setItem('sv-theme', dark ? 'dark' : 'light'); } catch { /* storage unavailable */ }
}
$('#btnTheme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));
$('#chkDark').addEventListener('change', (e) => setTheme(e.target.checked));
{
  let saved = null;
  try { saved = localStorage.getItem('sv-theme'); } catch { /* storage unavailable */ }
  // dark by default; a light/dark choice made with the toolbar button is remembered
  setTheme(saved ? saved === 'dark' : true);
}

$$('#sectionAxis button').forEach(b => b.addEventListener('click', () => setSectionAxis(b.dataset.axis)));
$('#sectionSlider').addEventListener('input', sectionFromSlider);
$('#chkFlip').addEventListener('change', (e) => viewer.setSection({ flip: e.target.checked }));
$('#chkCaps').addEventListener('change', (e) => viewer.setSection({ caps: e.target.checked }));

function setMeasureMode(mode) {
  measure.setMode(mode);
  $$('#measureMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#btnMeasure').classList.toggle('on', !!mode);
}
$$('#measureMode button').forEach(b => b.addEventListener('click', () => setMeasureMode(b.dataset.mode)));
$('#btnMeasure').addEventListener('click', () => {
  const on = !measure.mode;
  setMeasureMode(on ? 'distance' : '');
  if (on) showTab('measure');
});
$('#btnClearMeasure').addEventListener('click', () => measure.clear());

$('#btnShot').addEventListener('click', () => {
  const canvas = viewer.snapshot(measure.labelsForSnapshot());
  canvas.toBlob((b) => download(b, `step-viewer-${stamp()}.png`), 'image/png');
});
$('#btnCopy').addEventListener('click', async () => {
  if (!lastPropsText) { toast('Nothing selected'); return; }
  toast(await copyText(lastPropsText) ? 'Properties copied to the clipboard' : 'Copy failed', '', 2500);
});
$('#btnIsolateSel').addEventListener('click', () => { if (viewer.selected.size) isolate([...viewer.selected]); });
$('#btnHideSel').addEventListener('click', () => {
  for (const id of viewer.selected) parts[id].visible = false;
  setSelection([], false); renderTree();
});
$('#btnClearSel').addEventListener('click', () => { selectedNode = null; setSelection([], false); });
$('#btnShowAll').addEventListener('click', showAll);
$('#btnCloseAll').addEventListener('click', closeAll);
$('#treeFilter').addEventListener('input', renderTree);
$('#material').addEventListener('change', () => {
  $('#customDensityWrap').hidden = $('#material').value !== 'custom';
  renderProps(); renderParts();
});
$('#customDensity').addEventListener('input', () => { renderProps(); renderParts(); });
$('#groupGeom').addEventListener('change', renderParts);
$('#partsVisibleOnly').addEventListener('change', renderParts);
$('#btnCsv').addEventListener('click', () => {
  if (!groups.length) return;
  const base = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'parts';
  download(new Blob([partsCsv(groups, density(), materialName())], { type: 'text/csv' }), `${base}-parts-list.csv`);
});
$('#btnDxfPreview').addEventListener('click', generateDxf);
$('#btnDxfDownload').addEventListener('click', () => {
  if (dxfText) download(new Blob([dxfText], { type: 'application/dxf' }), dxfName);
});

function showTab(name) {
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
  if (name === 'parts') renderParts();
}
$$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// drawers on narrow screens
function toggleDrawer(id, force) {
  const el = document.getElementById(id);
  const open = force ?? !el.classList.contains('open');
  el.classList.toggle('open', open);
  if (open) for (const other of ['treePanel', 'sidePanel']) if (other !== id) document.getElementById(other).classList.remove('open');
}
$('#btnTree').addEventListener('click', () => toggleDrawer('treePanel'));
$('#btnPanel').addEventListener('click', () => toggleDrawer('sidePanel'));
$$('[data-close]').forEach(b => b.addEventListener('click', () => toggleDrawer(b.dataset.close, false)));
$('#selChip').addEventListener('click', () => { showTab('props'); toggleDrawer('sidePanel', true); });
$('#viewport').addEventListener('pointerdown', () => { toggleDrawer('treePanel', false); toggleDrawer('sidePanel', false); });

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') viewer.fit();
  else if (k === 's') viewer.fit(viewer.selected.size ? [...viewer.selected] : null);
  else if (k === 'o') setOrtho(viewer.camera !== viewer.ortho);
  else if (k === 'e') setEdges(!viewer.edgesOn);
  else if (k === 'm') $('#btnMeasure').click();
  else if (k === 'escape') { if (measure.mode) setMeasureMode(''); else { selectedNode = null; setSelection([], false); } }
});

// exposed for automated acceptance tests only (no network, no side effects)
window.__stepViewer = { viewer, parts, nodes, files, measure, openFiles, selectPart, generateDxf, getDxf: () => dxfText, setSectionAxis };

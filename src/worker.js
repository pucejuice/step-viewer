// Parser worker: runs occt-import-js (Open CASCADE in WebAssembly) off the main
// thread, then analyses every mesh. The file bytes never leave this browser.
//
// For STEP files it also reads the product structure from the file text and
// matches every mesh to its occurrence and body (step/map.js). That gives the
// real sub-assembly tree and names, and lets a trimmed copy of the file be
// written (step/trim.js), checked by reading it back, and handed to the page.
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { analyseMesh, faceIdsFromBrep } from './meshAnalysis.js';
import { detectUnit } from './units.js';
import { parseP21 } from './step/p21.js';
import { productStructure } from './step/structure.js';
import { matchMeshes, structureTree, unitScale } from './step/map.js';
import { trimStep } from './step/trim.js';

let occtPromise = null;
function getOcct() {
  if (!occtPromise) occtPromise = occtimportjs({ locateFile: () => wasmUrl });
  return occtPromise;
}

const QUALITY = {
  coarse: { linearDeflection: 0.002, angularDeflection: 0.35 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.15 },
  fine: { linearDeflection: 0.0004, angularDeflection: 0.07 },
};
const paramsFor = (quality) => ({ linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...(QUALITY[quality] || QUALITY.normal) });

// STEP files kept for trimming, by load id (in this worker's memory only)
const kept = new Map();

const latin1 = (text) => { const b = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 255; return b; };

function areaCentroidOf(m) {
  const pos = m.attributes.position.array, idx = m.index.array;
  let A = 0, cx = 0, cy = 0, cz = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    A += ar; cx += ar * (pos[a] + pos[b] + pos[c]); cy += ar * (pos[a + 1] + pos[b + 1] + pos[c + 1]); cz += ar * (pos[a + 2] + pos[b + 2] + pos[c + 2]);
  }
  return A > 0 ? [cx / (3 * A), cy / (3 * A), cz / (3 * A)] : [0, 0, 0];
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'trim') return trim(msg);
  if (msg.type === 'forget') { if (msg.id == null) kept.clear(); else kept.delete(msg.id); return; }
  return load(msg);
};

async function load({ id, name, buffer, format, quality }) {
  const progress = (stage, frac) => self.postMessage({ type: 'progress', id, stage, frac });
  try {
    progress('Loading geometry kernel', 0.05);
    const occt = await getOcct();
    const bytes = new Uint8Array(buffer);
    const unit = detectUnit(bytes, format);
    progress('Reading and meshing ' + format.toUpperCase(), 0.15);
    const res = format === 'iges' ? occt.ReadIgesFile(bytes, paramsFor(quality)) : occt.ReadStepFile(bytes, paramsFor(quality));
    if (!res || !res.success) throw new Error('the geometry kernel could not read this file');
    if (!res.meshes.length) throw new Error('the file contains no solid or surface geometry');

    // product structure and mesh matching (STEP only; failures just disable trimming)
    let root = res.root, edit = { editable: false, reason: format === 'iges' ? 'Trimmed download is for STEP files only.' : '' };
    if (format === 'step') {
      progress('Reading the assembly structure', 0.58);
      try {
        const file = parseP21(new TextDecoder('latin1').decode(bytes));
        const st = productStructure(file);
        const cents = res.meshes.map(areaCentroidOf);
        const sizes = res.meshes.map(m => { const p = m.attributes.position.array; let a = [1e30, 1e30, 1e30], b = [-1e30, -1e30, -1e30]; for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < a[k]) a[k] = p[i + k]; if (p[i + k] > b[k]) b[k] = p[i + k]; } return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); });
        const r = matchMeshes(st, res.root, cents, sizes, unitScale(unit));
        if (r.ok) {
          kept.set(id, { file, st, map: r.map, cents, quality, name });
          root = structureTree(st, r.map);
          r.map.forEach((m, i) => { if (!res.meshes[i].name) res.meshes[i].name = st.pds.get(m.pd).name; });
          edit = { editable: true };
        } else {
          edit = { editable: false, reason: `This file's structure could not be matched to its parts (${r.reason}), so a trimmed copy can't be written safely.` };
        }
      } catch (e) {
        edit = { editable: false, reason: `This file's structure could not be read for trimming (${e.message}).` };
      }
    }

    const meshes = [];
    const transfer = [];
    const n = res.meshes.length;
    for (let i = 0; i < n; i++) {
      if (i % 10 === 0) progress(`Analysing parts ${i + 1}/${n}`, 0.6 + 0.4 * i / n);
      const m = res.meshes[i];
      const positions = new Float32Array(m.attributes.position.array);
      const normals = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const indices = new Uint32Array(m.index.array);
      const faceIds = faceIdsFromBrep(indices.length / 3, m.brep_faces);
      const a = analyseMesh(positions, indices, faceIds);
      meshes.push({ name: m.name || '', color: m.color || null, positions, normals, indices, analysis: a });
      transfer.push(positions.buffer, indices.buffer, a.featureEdges.buffer, a.smoothEdges.buffer);
      if (normals) transfer.push(normals.buffer);
    }
    const strip = (node) => ({ name: node.name || '', meshes: node.meshes || [], children: (node.children || []).map(strip) });
    self.postMessage({ type: 'result', id, ok: true, name, unit, root: strip(root), meshes, ...edit }, transfer);
  } catch (err) {
    self.postMessage({ type: 'result', id, ok: false, name, error: String(err && err.message || err) });
  }
}

/** Write the file without the deleted meshes, read it back, and check exactly the kept parts come out. */
async function trim({ id, reqId, deleted, partNames }) {
  const reply = (o) => self.postMessage({ type: 'trimResult', id, reqId, ...o });
  const progress = (stage) => self.postMessage({ type: 'trimProgress', id, reqId, stage });
  const k = kept.get(id);
  if (!k) return reply({ ok: false, reason: 'the original file is no longer in memory; open it again' });
  try {
    progress('Writing the trimmed file');
    const del = new Set(deleted);
    const out = trimStep(k.file, k.st, k.map, del, (i) => partNames[i] || k.st.pds.get(k.map[i].pd).name);
    progress('Checking the trimmed file by reading it back');
    const occt = await getOcct();
    const bytes = latin1(out.text);
    const res = occt.ReadStepFile(bytes, paramsFor(k.quality));
    if (!res || !res.success) throw new Error('the trimmed file could not be read back');
    const want = k.cents.filter((c, i) => !del.has(i));
    if (res.meshes.length !== want.length) throw new Error(`check failed: expected ${want.length} parts, the trimmed file has ${res.meshes.length}`);
    const got = res.meshes.map(areaCentroidOf);
    const used = new Uint8Array(got.length);
    for (const c of want) {
      let hit = -1;
      for (let j = 0; j < got.length; j++) {
        if (used[j]) continue;
        const g = got[j];
        if (Math.abs(g[0] - c[0]) < 0.05 && Math.abs(g[1] - c[1]) < 0.05 && Math.abs(g[2] - c[2]) < 0.05) { hit = j; break; }
      }
      if (hit < 0) throw new Error('check failed: a kept part is missing or moved in the trimmed file');
      used[hit] = 1;
    }
    reply({ ok: true, bytes, summary: out.summary, kept: want.length }, [bytes.buffer]);
  } catch (e) {
    reply({ ok: false, reason: e.message });
  }
}

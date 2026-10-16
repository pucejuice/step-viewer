// Parser worker: runs occt-import-js (Open CASCADE in WebAssembly) off the main
// thread, then analyses every mesh. The file bytes never leave this browser.
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { analyseMesh, faceIdsFromBrep } from './meshAnalysis.js';
import { detectUnit } from './units.js';

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

self.onmessage = async (ev) => {
  const { id, name, buffer, format, quality } = ev.data;
  const progress = (stage, frac) => self.postMessage({ type: 'progress', id, stage, frac });
  try {
    progress('Loading geometry kernel', 0.05);
    const occt = await getOcct();
    const bytes = new Uint8Array(buffer);
    const unit = detectUnit(bytes, format);
    progress('Reading and meshing ' + format.toUpperCase(), 0.15);
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...(QUALITY[quality] || QUALITY.normal) };
    const res = format === 'iges' ? occt.ReadIgesFile(bytes, params) : occt.ReadStepFile(bytes, params);
    if (!res || !res.success) throw new Error('the geometry kernel could not read this file');
    if (!res.meshes.length) throw new Error('the file contains no solid or surface geometry');

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
    self.postMessage({ type: 'result', id, ok: true, name, unit, root: strip(res.root), meshes }, transfer);
  } catch (err) {
    self.postMessage({ type: 'result', id, ok: false, name, error: String(err && err.message || err) });
  }
};

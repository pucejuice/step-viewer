// Mesh analysis shared by the parser worker, the main thread and the Node tests.
// Pure functions on typed arrays, no three.js dependency.
//
// OCCT writes one triangulation per B-rep face, so vertices on shared edges are
// duplicated. weld() merges them by position so that topology (closed check,
// feature edges, silhouettes) can be worked out.

/** Merge coincident vertices. Returns { map: Uint32Array(vertex -> welded id), count }. */
export function weld(positions, tol) {
  const n = positions.length / 3;
  const map = new Uint32Array(n);
  const inv = 1 / tol;
  const table = new Map();
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.round(positions[3 * i] * inv);
    const y = Math.round(positions[3 * i + 1] * inv);
    const z = Math.round(positions[3 * i + 2] * inv);
    const key = x + ',' + y + ',' + z;
    let id = table.get(key);
    if (id === undefined) { id = count++; table.set(key, id); }
    map[i] = id;
  }
  return { map, count };
}

export function bbox(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Per-triangle B-rep face id from occt-import-js brep_faces ranges. */
export function faceIdsFromBrep(triCount, brepFaces) {
  const ids = new Int32Array(triCount).fill(-1);
  if (brepFaces && brepFaces.length) {
    brepFaces.forEach((f, k) => { for (let t = f.first; t <= f.last && t < triCount; t++) ids[t] = k; });
  }
  return ids;
}

function triNormal(p, a, b, c, out) {
  const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
  const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 0) { nx /= len; ny /= len; nz /= len; }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return len / 2; // triangle area
}

/**
 * Full analysis of one mesh.
 * positions: Float32Array xyz, indices: Uint32Array, faceIds: Int32Array per triangle.
 * Returns mass properties and two edge sets, each as Float32Array with 12 floats
 * per edge: ax ay az bx by bz n1x n1y n1z n2x n2y n2z (n2 = n1 on open edges).
 *  - featureEdges: B-rep face boundaries, open and non-manifold edges
 *  - smoothEdges: edges inside one B-rep face (used for view silhouettes)
 */
export function analyseMesh(positions, indices, faceIds) {
  const box = bbox(positions);
  const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
  const { map, count } = weld(positions, Math.max(diag * 1e-7, 1e-6));
  const triCount = indices.length / 3;
  const normals = new Float32Array(triCount * 3);
  const nrm = [0, 0, 0];

  // mass properties about the bbox centre (better conditioning), in doubles
  const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, cz = (box.min[2] + box.max[2]) / 2;
  let vol = 0, area = 0, mx = 0, my = 0, mz = 0;
  const p = positions;
  for (let t = 0; t < triCount; t++) {
    const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    area += triNormal(p, a, b, c, nrm);
    normals[3 * t] = nrm[0]; normals[3 * t + 1] = nrm[1]; normals[3 * t + 2] = nrm[2];
    const ax = p[3 * a] - cx, ay = p[3 * a + 1] - cy, az = p[3 * a + 2] - cz;
    const bx = p[3 * b] - cx, by = p[3 * b + 1] - cy, bz = p[3 * b + 2] - cz;
    const qx = p[3 * c] - cx, qy = p[3 * c + 1] - cy, qz = p[3 * c + 2] - cz;
    // signed volume of tetra (origin, a, b, c) = a . (b x c) / 6
    const v = (ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx)) / 6;
    vol += v;
    mx += v * (ax + bx + qx) / 4; my += v * (ay + by + qy) / 4; mz += v * (az + bz + qz) / 4;
  }
  const centroid = vol !== 0 ? [cx + mx / vol, cy + my / vol, cz + mz / vol] : [cx, cy, cz];

  // edge table on welded ids
  const edges = new Map(); // key -> [t1, t2, count, dirOk]
  let inconsistent = 0;
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const i0 = map[indices[3 * t + k]], i1 = map[indices[3 * t + ((k + 1) % 3)]];
      if (i0 === i1) continue;
      const lo = i0 < i1 ? i0 : i1, hi = i0 < i1 ? i1 : i0;
      const key = lo * count + hi;
      const e = edges.get(key);
      if (e === undefined) {
        edges.set(key, [t, -1, 1, i0 < i1 ? 1 : -1, indices[3 * t + k], indices[3 * t + ((k + 1) % 3)]]);
      } else {
        if (e[2] === 1) {
          e[1] = t;
          if ((i0 < i1 ? 1 : -1) === e[3]) inconsistent++; // same direction twice: flipped triangle
        }
        e[2]++;
      }
    }
  }

  let open = 0, nonManifold = 0;
  const feat = [], smooth = [];
  const hasFaces = faceIds && faceIds.length === triCount && faceIds[0] !== -1;
  const cosSharp = Math.cos(30 * Math.PI / 180);
  for (const e of edges.values()) {
    const [t1, t2, n, , va, vb] = e;
    const n1 = [normals[3 * t1], normals[3 * t1 + 1], normals[3 * t1 + 2]];
    const n2 = t2 >= 0 ? [normals[3 * t2], normals[3 * t2 + 1], normals[3 * t2 + 2]] : n1;
    const rec = [p[3 * va], p[3 * va + 1], p[3 * va + 2], p[3 * vb], p[3 * vb + 1], p[3 * vb + 2], n1[0], n1[1], n1[2], n2[0], n2[1], n2[2]];
    if (n === 1) { open++; feat.push(rec); continue; }
    if (n > 2) { nonManifold++; feat.push(rec); continue; }
    const isFeature = hasFaces
      ? faceIds[t1] !== faceIds[t2]
      : (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) < cosSharp;
    (isFeature ? feat : smooth).push(rec);
  }
  const flat = (arr) => { const out = new Float32Array(arr.length * 12); arr.forEach((r, i) => out.set(r, i * 12)); return out; };

  return {
    bboxMin: box.min, bboxMax: box.max,
    volume: Math.abs(vol), area, centroid,
    triangles: triCount,
    closed: open === 0 && nonManifold === 0 && triCount > 0,
    openEdges: open, nonManifoldEdges: nonManifold, inconsistentEdges: inconsistent,
    featureEdges: flat(feat), smoothEdges: flat(smooth),
  };
}

/** Sum mass properties over several analysed meshes. */
export function sumProps(list) {
  const out = { volume: 0, area: 0, triangles: 0, closed: true, bboxMin: [Infinity, Infinity, Infinity], bboxMax: [-Infinity, -Infinity, -Infinity], centroid: [0, 0, 0], count: list.length };
  let mx = 0, my = 0, mz = 0;
  for (const a of list) {
    out.volume += a.volume; out.area += a.area; out.triangles += a.triangles;
    out.closed = out.closed && a.closed;
    for (let k = 0; k < 3; k++) { out.bboxMin[k] = Math.min(out.bboxMin[k], a.bboxMin[k]); out.bboxMax[k] = Math.max(out.bboxMax[k], a.bboxMax[k]); }
    mx += a.volume * a.centroid[0]; my += a.volume * a.centroid[1]; mz += a.volume * a.centroid[2];
  }
  if (out.volume > 0) out.centroid = [mx / out.volume, my / out.volume, mz / out.volume];
  else if (list.length) out.centroid = out.bboxMin.map((v, k) => (v + out.bboxMax[k]) / 2);
  return out;
}

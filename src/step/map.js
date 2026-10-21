// Match the meshes occt-import-js produced to STEP occurrences and bodies.
//
// occt-import-js names tree nodes after products and flattens some
// sub-assemblies into one node holding every solid below it. We expand those
// nodes through the real product structure (occurrences in file order, bodies
// in representation order), then prove the match geometrically: every
// instance of a product body must be the same local shape moved by its own
// chain of placements. Instances of one body that land on the wrong mesh are
// re-paired by position; anything that still disagrees fails the match.
import { mul, invRigid, apply, IDENTITY } from './structure.js';

const UNIT_MM = { mm: 1, cm: 10, dm: 100, m: 1000, km: 1e6, 'µm': 1e-3, nm: 1e-6, inch: 25.4, foot: 304.8, ft: 304.8, in: 25.4 };
export const unitScale = (u) => UNIT_MM[String(u || '').toLowerCase()] || 1;

/** Leaf instances below a product definition in occt order: [{ path: [nauo ids], pd, body, bodyIndex, W }]. */
function flatten(st, pd, path, W, scale, out) {
  pd.bodies.forEach((b, i) => out.push({ path, pd: pd.id, body: b, bodyIndex: i, W }));
  for (const nid of [...pd.asParent].sort((a, b) => a - b)) {
    const o = st.nauos.get(nid);
    const child = st.pds.get(o.child);
    if (!child) continue;
    const T = scaled(o.transform || IDENTITY, scale);
    flatten(st, child, [...path, nid], mul(W, T), scale, out);
  }
  return out;
}
const scaled = (m, s) => { const r = m.slice(); r[3] *= s; r[7] *= s; r[11] *= s; return r; };

/**
 * root: occt result root ({ name, meshes, children }), meshCentroids: [[x,y,z]] (area centroids, mm),
 * meshSizes: [diag]. Returns { ok, map: [{ path, pd, body, bodyIndex }] per mesh, tree, reason }.
 */
export function matchMeshes(st, root, meshCentroids, meshSizes, scale) {
  const map = new Array(meshCentroids.length).fill(null);
  const fail = (reason) => ({ ok: false, reason });

  // occt root children are the free shapes; align them with our roots by name, in order
  const roots = [...st.roots];
  const used = new Set();
  const assign = (node, pd, path, W) => {
    if (pd.name !== node.name && node.name) return `name mismatch: "${node.name}" vs "${pd.name}"`;
    if (!node.children.length) {
      const leaves = flatten(st, pd, path, W, scale, []);
      if (leaves.length !== node.meshes.length) return `"${node.name}": ${node.meshes.length} meshes but ${leaves.length} bodies`;
      node.meshes.forEach((mi, k) => { map[mi] = leaves[k]; });
      return null;
    }
    // node keeps its own bodies (if any) and lists children in occurrence order
    if (node.meshes.length !== pd.bodies.length) return `"${node.name}": own bodies differ`;
    node.meshes.forEach((mi, k) => { map[mi] = { path, pd: pd.id, body: pd.bodies[k], bodyIndex: k, W }; });
    const kids = [...pd.asParent].sort((a, b) => a - b).map(id => st.nauos.get(id)).filter(o => st.pds.has(o.child));
    if (kids.length !== node.children.length) return `"${node.name}": ${node.children.length} children but ${kids.length} occurrences`;
    for (let k = 0; k < kids.length; k++) {
      const o = kids[k];
      const err = assign(node.children[k], st.pds.get(o.child), [...path, o.id], mul(W, scaled(o.transform || IDENTITY, scale)));
      if (err) return err;
    }
    return null;
  };
  for (const node of root.children) {
    const idx = roots.findIndex((r, i) => !used.has(i) && (r.name === node.name || !node.name));
    if (idx < 0) return fail(`no product for top-level "${node.name}"`);
    used.add(idx);
    const err = assign(node, roots[idx], [], IDENTITY);
    if (err) return fail(err);
  }
  if (map.some(m => !m)) return fail('some meshes were not matched');

  // geometric proof, per product body: W_i^-1 * c_i must be one local point
  const byBody = new Map();
  map.forEach((m, mi) => {
    const k = m.pd + ':' + m.bodyIndex;
    if (!byBody.has(k)) byBody.set(k, []);
    byBody.get(k).push(mi);
  });
  let repaired = 0;
  for (const meshes of byBody.values()) {
    if (meshes.length < 2) continue;
    const tol = Math.max(meshSizes[meshes[0]] * 1e-4, 0.01);
    const local = (mi, inst) => apply(invRigid(inst.W), meshCentroids[mi]);
    const insts = meshes.map(mi => map[mi]);
    const L0 = local(meshes[0], insts[0]);
    const consistent = meshes.every((mi, i) => dist(local(mi, insts[i]), L0) <= tol);
    if (consistent) continue;
    // re-pair: find a local point that sends every instance onto a distinct mesh
    let solved = null;
    for (const mj of meshes) {
      const L = local(mj, insts[0]);
      const free = new Set(meshes), pairing = [];
      for (const inst of insts) {
        const p = apply(inst.W, L);
        let best = null, bd = tol;
        for (const mi of free) { const d = dist(p, meshCentroids[mi]); if (d <= bd) { bd = d; best = mi; } }
        if (best == null) break;
        free.delete(best); pairing.push([best, inst]);
      }
      if (pairing.length === insts.length) { solved = pairing; break; }
    }
    if (!solved) return fail(`placements of "${st.pds.get(insts[0].pd).name}" do not match the meshes`);
    for (const [mi, inst] of solved) map[mi] = inst;
    repaired++;
  }
  return { ok: true, map: map.map(({ path, pd, body, bodyIndex }) => ({ path, pd, body, bodyIndex })), repaired };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A tree like occt's, but with the real sub-assembly levels and product names. */
export function structureTree(st, map) {
  // key every mesh by its occurrence path
  const meshesAt = new Map();
  map.forEach((m, mi) => {
    const k = m.path.join('/');
    if (!meshesAt.has(k)) meshesAt.set(k, []);
    meshesAt.get(k).push([m.bodyIndex, mi]);
  });
  const build = (pd, path, name) => {
    const k = path.join('/');
    const own = (meshesAt.get(k) || []).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const children = [...pd.asParent].sort((a, b) => a - b).map(id => st.nauos.get(id))
      .filter(o => st.pds.has(o.child))
      .map(o => build(st.pds.get(o.child), [...path, o.id], st.pds.get(o.child).name));
    return { name, meshes: own, children };
  };
  const usedRoots = new Set(map.map(m => rootOf(st, m)));
  return { name: '', meshes: [], children: st.roots.filter(r => usedRoots.has(r.id)).map(r => build(r, [], r.name)) };
}

function rootOf(st, m) {
  if (!m.path.length) return m.pd;
  return st.nauos.get(m.path[0]).parent;
}

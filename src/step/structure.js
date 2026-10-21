// Product structure of an AP203 / AP214 / AP242 file: products, assembly
// occurrences (NEXT_ASSEMBLY_USAGE_OCCURRENCE) with their placements, and the
// solid bodies each product owns.
import { entityParts, hasType, argsOf, refsOf } from './p21.js';

const unq = (v) => (v && v.s ? v.s.slice(1, -1).replace(/''/g, "'") : '');
const ref = (v) => (v && typeof v === 'object' && 'r' in v ? v.r : null);
const BODY_TYPES = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL']);

/** Reverse references: id -> [ids of entities that reference it]. */
export function usedBy(file) {
  if (file._usedBy) return file._usedBy;
  const m = new Map();
  for (const id of file.order) for (const r of refsOf(file.entities.get(id))) {
    if (!m.has(r.id)) m.set(r.id, []);
    m.get(r.id).push(id);
  }
  file._usedBy = m;
  return m;
}

const firstPart = (ent) => entityParts(ent)[0];
const isPD = (ent) => /^PRODUCT_DEFINITION(_WITH_ASSOCIATED_DOCUMENTS)?$/.test(firstPart(ent).name);

export function productStructure(file) {
  const E = file.entities, by = usedBy(file);
  const get = (id) => E.get(id);
  const pds = new Map();   // PD id -> { id, name, nauosAsParent: [], nauosAsChild: [], bodies: [], sr: [] }
  const nauos = new Map(); // NAUO id -> { id, parent, child, name, pds (PRODUCT_DEFINITION_SHAPE of the NAUO), cdsr, rrwt, transform }

  for (const id of file.order) {
    const ent = get(id);
    if (isPD(ent)) {
      const a = firstPart(ent).args;
      const pdf = get(ref(a[2]));
      const prod = pdf ? get(ref(firstPart(pdf).args[2])) : null;
      const pa = prod ? firstPart(prod).args : null;
      pds.set(id, { id, name: pa ? (unq(pa[1]) || unq(pa[0])) : '', productId: prod ? prod.id : null, asParent: [], asChild: [], bodies: [], reps: [] });
    }
  }
  for (const id of file.order) {
    const ent = get(id);
    if (firstPart(ent).name === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
      const a = firstPart(ent).args;
      const o = { id, name: unq(a[1]) || unq(a[0]), parent: ref(a[3]), child: ref(a[4]) };
      nauos.set(id, o);
      if (pds.has(o.parent)) pds.get(o.parent).asParent.push(id);
      if (pds.has(o.child)) pds.get(o.child).asChild.push(id);
    }
  }
  // shape: PD <- PRODUCT_DEFINITION_SHAPE <- SHAPE_DEFINITION_REPRESENTATION -> representation
  const pdsOf = (defId) => (by.get(defId) || []).filter(u => firstPart(get(u)).name === 'PRODUCT_DEFINITION_SHAPE');
  for (const pd of pds.values()) {
    for (const s of pdsOf(pd.id)) {
      for (const u of by.get(s) || []) {
        const ue = get(u);
        if (firstPart(ue).name === 'SHAPE_DEFINITION_REPRESENTATION') pd.reps.push(ref(firstPart(ue).args[1]));
      }
    }
    pd.bodies = bodiesOf(file, pd.reps);
  }
  // placements: NAUO <- PRODUCT_DEFINITION_SHAPE <- CONTEXT_DEPENDENT_SHAPE_REPRESENTATION -> RRWT -> ITEM_DEFINED_TRANSFORMATION
  for (const o of nauos.values()) {
    o.shapeDef = pdsOf(o.id)[0] || null;
    o.cdsr = null; o.rrwt = null; o.transform = null;
    for (const u of (o.shapeDef ? by.get(o.shapeDef) : []) || []) {
      const ue = get(u);
      if (firstPart(ue).name !== 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') continue;
      o.cdsr = u;
      o.rrwt = ref(firstPart(ue).args[0]);
      o.transform = placementOf(file, o.rrwt, pds.get(o.child));
    }
  }
  const roots = [...pds.values()].filter(pd => pd.asChild.length === 0 && (pd.asParent.length || pd.bodies.length));
  return { pds, nauos, roots };
}

/** Solid bodies reachable from representations (through non-placement representation relationships). */
function bodiesOf(file, reps) {
  const E = file.entities, by = usedBy(file);
  const seen = new Set(), out = [];
  const visit = (rid) => {
    if (rid == null || seen.has(rid)) return;
    seen.add(rid);
    const ent = E.get(rid);
    if (!ent) return;
    // REPRESENTATION args: (name, items, context_of_items)
    const p = entityParts(ent).find(x => x.args.length >= 3 && Array.isArray(x.args[1]));
    if (p) for (const it of p.args[1]) {
      const iid = ref(it);
      const ie = iid != null ? E.get(iid) : null;
      if (ie && BODY_TYPES.has(firstPart(ie).name)) out.push(iid);
    }
    // representation relationships without a transformation join reps of one product
    for (const u of by.get(rid) || []) {
      const ue = E.get(u);
      if (!hasType(ue, 'SHAPE_REPRESENTATION_RELATIONSHIP') && !hasType(ue, 'REPRESENTATION_RELATIONSHIP')) continue;
      if (hasType(ue, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) continue;
      const ra = argsOf(ue, 'REPRESENTATION_RELATIONSHIP') || argsOf(ue, 'SHAPE_REPRESENTATION_RELATIONSHIP');
      if (!ra || ra.length < 4) continue;
      visit(ref(ra[2])); visit(ref(ra[3]));
    }
  };
  for (const r of reps) visit(r);
  return out;
}

// ── placements ─────────────────────────────────────────────────────────────
function num(v) { return v && v.n !== undefined ? parseFloat(v.n) : 0; }
function vec3(file, id) {
  const e = id != null ? file.entities.get(id) : null;
  if (!e) return null;
  const a = firstPart(e).args;
  const list = firstPart(e).name === 'DIRECTION' ? a[1] : a[1];
  return list.map(num).concat([0, 0, 0]).slice(0, 3);
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** AXIS2_PLACEMENT_3D -> 4x4 row-major matrix (local -> parent). */
function axisMatrix(file, id) {
  const e = file.entities.get(id);
  const a = firstPart(e).args;
  const o = vec3(file, ref(a[1])) || [0, 0, 0];
  let z = ref(a[2]) != null ? norm(vec3(file, ref(a[2]))) : [0, 0, 1];
  let x = ref(a[3]) != null ? vec3(file, ref(a[3])) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  // make x perpendicular to z
  const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = norm([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
  const y = cross(z, x);
  return [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2], 0, 0, 0, 1];
}
export function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
  return r;
}
export function invRigid(m) {
  // inverse of [R t; 0 1] = [R^T -R^T t; 0 1]
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = [m[3], m[7], m[11]];
  r[3] = -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
  r[7] = -(r[4] * t[0] + r[5] * t[1] + r[6] * t[2]);
  r[11] = -(r[8] * t[0] + r[9] * t[1] + r[10] * t[2]);
  return r;
}
export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];

/** Placement of a child occurrence in its parent (child coords -> parent coords), in file units. */
function placementOf(file, rrwtId, childPd) {
  const e = rrwtId != null ? file.entities.get(rrwtId) : null;
  if (!e) return IDENTITY;
  const rr = argsOf(e, 'REPRESENTATION_RELATIONSHIP');
  const tr = argsOf(e, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
  if (!rr || !tr) return IDENTITY;
  const idt = file.entities.get(ref(tr[0]));
  if (!idt || firstPart(idt).name !== 'ITEM_DEFINED_TRANSFORMATION') return IDENTITY;
  const ia = firstPart(idt).args;
  const a1 = axisMatrix(file, ref(ia[2])), a2 = axisMatrix(file, ref(ia[3]));
  // rep_1 is normally the child's representation (item_1 in child, item_2 in parent);
  // some writers swap them, so check which side belongs to the child
  const childReps = new Set(childPd ? childPd.reps : []);
  const rep1 = ref(rr[2]);
  return childReps.size && !childReps.has(rep1) && childReps.has(ref(rr[3]))
    ? mul(a1, invRigid(a2))
    : mul(a2, invRigid(a1));
}

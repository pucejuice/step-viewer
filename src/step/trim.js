// Remove deleted parts from a STEP file's text.
//
// A deleted mesh is removed at the highest level that is entirely deleted:
//   - an assembly occurrence (NEXT_ASSEMBLY_USAGE_OCCURRENCE): the part or
//     sub-assembly goes from its parent product, so it must be deleted in every
//     copy of that parent;
//   - a top-level product, when everything in it is deleted;
//   - one solid body of a product, when that body is deleted in every copy.
// Removal cascades through the entity graph: an entity that refers to a
// removed entity directly is removed too; a reference inside a list is taken
// out of the list. Afterwards everything no longer reachable is swept, and
// styling / layer entries for geometry that is gone are dropped.
import { entityParts, refsOf, writeP21 } from './p21.js';
import { usedBy } from './structure.js';

const firstPart = (ent) => entityParts(ent)[0];
const isPresentation = (ent) => entityParts(ent).some(p => /STYLED_ITEM$|^PRESENTATION_LAYER_ASSIGNMENT$|^MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION$|^DRAUGHTING_MODEL$|^PRESENTATION_LAYER_USAGE$/.test(p.name));

/**
 * file: parseP21 result, st: productStructure, map: per mesh { path, pd, body, bodyIndex },
 * deleted: Set of mesh indices. Returns { text, summary } or throws Error with a user message.
 */
export function trimStep(file, st, map, deleted, meshName = (i) => `part ${i + 1}`) {
  if (!deleted.size) throw new Error('nothing is deleted');
  if (deleted.size === map.length) throw new Error('every part is deleted, so there would be nothing left to save');
  const rootOf = (m) => (m.path.length ? st.nauos.get(m.path[0]).parent : m.pd);

  // meshes under each occurrence (a NAUO is used by every instance of its parent)
  const under = new Map(); // nauo id -> [mesh]
  const underRoot = new Map(); // root pd -> [mesh]
  const underBody = new Map(); // pd:bodyIndex -> [mesh]
  map.forEach((m, mi) => {
    for (const n of m.path) { if (!under.has(n)) under.set(n, []); under.get(n).push(mi); }
    const r = rootOf(m);
    if (!underRoot.has(r)) underRoot.set(r, []);
    underRoot.get(r).push(mi);
    const bk = m.pd + ':' + m.bodyIndex;
    if (!underBody.has(bk)) underBody.set(bk, []);
    underBody.get(bk).push(mi);
  });
  const allGone = (list) => list.every(i => deleted.has(i));

  const cut = { nauos: new Set(), roots: new Set(), bodies: new Set() };
  const problems = [];
  for (const mi of deleted) {
    const m = map[mi];
    const r = rootOf(m);
    if (allGone(underRoot.get(r))) { cut.roots.add(r); continue; }
    const n = m.path.find(id => allGone(under.get(id)));
    if (n != null) { cut.nauos.add(n); continue; }
    const bk = m.pd + ':' + m.bodyIndex;
    if (allGone(underBody.get(bk))) { cut.bodies.add(m.body); continue; }
    problems.push(mi);
  }
  if (problems.length) {
    // explain the first case in words
    const mi = problems[0], m = map[mi];
    const leaf = st.pds.get(m.pd);
    const more = problems.length > 1 ? ` (${problems.length} deleted parts are affected.)` : '';
    const sameInstance = map.filter(x => x.pd === m.pd && x.path.join('/') === m.path.join('/'));
    if (leaf.bodies.length > 1 && !sameInstance.every((x) => deleted.has(map.indexOf(x)))) {
      const copies = underBody.get(m.pd + ':' + m.bodyIndex).length;
      throw new Error(`"${meshName(mi)}" is one of ${leaf.bodies.length} bodies of "${leaf.name}", which is used ${copies} time${copies === 1 ? '' : 's'} in the file. ` +
        `To save without it, delete that body in every copy of "${leaf.name}", or delete whole copies.` + more);
    }
    const e = m.path[m.path.length - 1];
    const parent = st.pds.get(st.nauos.get(e).parent);
    const idx = m.path.length - 1;
    const copies = new Set(under.get(e).map(k => map[k].path.slice(0, idx).join('/'))).size;
    throw new Error(`"${meshName(mi)}" sits inside "${parent.name}", which is used ${copies} times in the file, and the file stores it once for all copies. ` +
      `To save without it, delete it in every copy of "${parent.name}", or delete whole copies.` + more);
  }

  // ── cascade ──────────────────────────────────────────────────────────────
  const E = file.entities, by = usedBy(file);
  const drop = new Set();
  const changed = new Map(); // id -> entity copy with edited lists
  const current = (id) => changed.get(id) || E.get(id);
  const cascade = (start) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (drop.has(id) || !E.has(id)) continue;
      drop.add(id);
      for (const u of by.get(id) || []) {
        if (drop.has(u)) continue;
        const ent = current(u);
        const refs = refsOf(ent).filter(r => r.id === id);
        if (refs.some(r => !r.inList)) { stack.push(u); continue; }
        // take the reference out of its list(s); an emptied list removes the entity
        const copy = changed.get(u) || cloneEntity(E.get(u));
        let emptied = false;
        const strip = (v) => {
          if (!Array.isArray(v)) { if (v && v.t) v.v.forEach(strip); return; }
          for (let i = v.length - 1; i >= 0; i--) {
            const x = v[i];
            if (x && typeof x === 'object' && !Array.isArray(x) && x.r === id) v.splice(i, 1);
            else strip(x);
          }
          if (v.length === 0) emptied = true;
        };
        for (const p of copy.parts) p.args.forEach(a => { if (Array.isArray(a)) strip(a); });
        copy.refs = null;
        changed.set(u, copy);
        if (emptied) stack.push(u);
      }
    }
  };

  for (const n of cut.nauos) cascade(n);
  for (const r of cut.roots) cascade(r);
  for (const b of cut.bodies) cascade(b);

  // products that lost every place they were used in are removed with their definitions
  let again = true;
  while (again) {
    again = false;
    for (const pd of st.pds.values()) {
      if (drop.has(pd.id) || !pd.asChild.length) continue;
      if (pd.asChild.every(n => drop.has(n))) { cascade(pd.id); again = true; }
    }
  }
  // product definition formations and products left without definitions
  for (const id of file.order) {
    if (drop.has(id)) continue;
    const name = firstPart(E.get(id)).name;
    if (/^PRODUCT_DEFINITION_FORMATION/.test(name) || name === 'PRODUCT') {
      const users = (by.get(id) || []).filter(u => {
        const n = firstPart(E.get(u)).name;
        return /^PRODUCT_DEFINITION(_WITH_ASSOCIATED_DOCUMENTS)?$/.test(n) || /^PRODUCT_DEFINITION_FORMATION/.test(n);
      });
      if (users.length && users.every(u => drop.has(u))) cascade(id);
    }
  }
  // second pass for products whose formations were just removed
  for (const id of file.order) {
    if (drop.has(id) || firstPart(E.get(id)).name !== 'PRODUCT') continue;
    const users = (by.get(id) || []).filter(u => /^PRODUCT_DEFINITION_FORMATION/.test(firstPart(E.get(u)).name));
    if (users.length && users.every(u => drop.has(u))) cascade(id);
  }

  // ── sweep ────────────────────────────────────────────────────────────────
  // Roots (entities nothing refers to) of three kinds:
  //  - presentation (styled items, presentation representations, layers),
  //  - representation relationships without a placement (they tie two
  //    representations of one product together),
  //  - everything else ("structural": shape definitions, placements, categories ...).
  // Geometry stays only if it is reachable from a live structural root, or
  // through a relationship one of whose sides is already live.
  const isRel = (ent) => entityParts(ent).some(p => p.name === 'SHAPE_REPRESENTATION_RELATIONSHIP' || p.name === 'REPRESENTATION_RELATIONSHIP')
    && !entityParts(ent).some(p => p.name === 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
  const roots0 = file.order.filter(id => !(by.get(id) || []).length);
  const S = new Set();
  const traverse = (start) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (S.has(id) || drop.has(id) || !E.has(id)) continue;
      const ent = current(id);
      if (isPresentation(ent) && id !== start) continue;
      S.add(id);
      for (const r of refsOf(ent)) if (!S.has(r.id)) stack.push(r.id);
    }
  };
  const liveRoots = roots0.filter(id => !drop.has(id));
  for (const id of liveRoots) { const ent = current(id); if (!isPresentation(ent) && !isRel(ent)) traverse(id); }
  for (let grew = true; grew;) {
    grew = false;
    for (const id of liveRoots) {
      if (S.has(id) || drop.has(id)) continue;
      const ent = current(id);
      if (isRel(ent) && refsOf(ent).some(r => S.has(r.id))) { traverse(id); grew = true; }
    }
  }
  for (const id of liveRoots) { const ent = current(id); if (isRel(ent) && !S.has(id)) cascade(id); }
  // styling and layers of geometry that is gone
  for (const id of file.order) {
    if (drop.has(id)) continue;
    const sty = entityParts(current(id)).find(p => /STYLED_ITEM$/.test(p.name));
    if (sty) { const item = sty.args[2]; if (item && item.r != null && !S.has(item.r)) cascade(id); }
  }
  for (const id of file.order) {
    if (drop.has(id)) continue;
    const ent = current(id);
    if (firstPart(ent).name !== 'PRESENTATION_LAYER_ASSIGNMENT') continue;
    const items = firstPart(ent).args[2];
    if (!Array.isArray(items)) continue;
    const keep = items.filter(x => !(x && x.r != null) || (S.has(x.r) && !drop.has(x.r)));
    if (keep.length === items.length) continue;
    if (!keep.length) { cascade(id); continue; }
    const copy = changed.get(id) || cloneEntity(E.get(id));
    copy.parts[0].args[2] = keep;
    copy.refs = null;
    changed.set(id, copy);
  }
  // final mark and sweep from the roots that are left
  const live = new Set();
  const stack = roots0.filter(id => !drop.has(id));
  while (stack.length) {
    const id = stack.pop();
    if (live.has(id) || drop.has(id) || !E.has(id)) continue;
    live.add(id);
    for (const r of refsOf(current(id))) if (!live.has(r.id)) stack.push(r.id);
  }
  for (const id of file.order) if (!live.has(id)) drop.add(id);

  // integrity: nothing that stays may refer to something removed
  for (const id of file.order) {
    if (drop.has(id)) continue;
    for (const r of refsOf(current(id))) {
      if (drop.has(r.id) || !E.has(r.id)) throw new Error(`internal check failed: #${id} still refers to removed #${r.id}`);
    }
  }
  const text = writeP21(file, drop, changed);
  return {
    text,
    summary: { occurrences: cut.nauos.size, products: cut.roots.size, bodies: cut.bodies.size, entitiesRemoved: drop.size },
  };
}

function cloneEntity(ent) {
  const parts = JSON.parse(JSON.stringify(entityParts(ent)));
  return { id: ent.id, body: ent.body, raw: ent.raw, parts, refs: null };
}

// Group identical parts: same name, or same (sorted) bounding box and volume
// within a relative tolerance (0.5 % by default).

const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);

export function sizeOf(a) {
  return [0, 1, 2].map(k => a.bboxMax[k] - a.bboxMin[k]);
}

function sameShape(a, b, tol) {
  if (!close(a.volume, b.volume, tol)) return false;
  // sorted extents so a part turned through 90° still matches
  const sa = sizeOf(a).sort((x, y) => x - y), sb = sizeOf(b).sort((x, y) => x - y);
  return sa.every((v, k) => Math.abs(v - sb[k]) <= Math.max(tol * Math.max(v, sb[k]), 0.01));
}

/**
 * items: [{ id, name, analysis }]. Returns groups sorted by count desc:
 * [{ name, names:Set, ids:[], count, size:[x,y,z], volume, area }]
 * A group joins items with the same name; groups whose geometry also matches
 * are merged when `byGeometry` is true (so differently named copies collapse).
 */
export function groupParts(items, { tol = 0.005, byGeometry = true } = {}) {
  const groups = [];
  const byName = new Map();
  for (const it of items) {
    let g = it.name ? byName.get(it.name) : undefined;
    if (g && !sameShape(g.ref, it.analysis, Math.max(tol, 0.05))) g = undefined; // same name, clearly different part
    if (!g && byGeometry) g = groups.find(x => sameShape(x.ref, it.analysis, tol));
    if (!g) {
      g = { name: it.name, names: new Set(), ids: [], ref: it.analysis };
      groups.push(g);
      if (it.name && !byName.has(it.name)) byName.set(it.name, g);
    }
    g.names.add(it.name);
    g.ids.push(it.id);
  }
  return groups.map(g => ({
    name: [...g.names].filter(Boolean).join(' / ') || 'Unnamed',
    ids: g.ids, count: g.ids.length,
    size: sizeOf(g.ref), volume: g.ref.volume, area: g.ref.area, closed: g.ref.closed,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function partsCsv(groups, density, materialName) {
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const rows = [['Item', 'Name', 'Qty', 'Size X (mm)', 'Size Y (mm)', 'Size Z (mm)', 'Volume each (mm3)', 'Mass each (kg)', 'Volume total (mm3)', 'Mass total (kg)', 'Material', 'Density (kg/m3)']];
  let tv = 0, tm = 0, tq = 0;
  groups.forEach((g, i) => {
    const m = g.volume * 1e-9 * density;
    tv += g.volume * g.count; tm += m * g.count; tq += g.count;
    rows.push([i + 1, q(g.name), g.count, ...g.size.map(v => v.toFixed(2)), g.volume.toFixed(1), m.toFixed(4), (g.volume * g.count).toFixed(1), (m * g.count).toFixed(4), q(materialName), density]);
  });
  rows.push(['', q('TOTAL'), tq, '', '', '', '', '', tv.toFixed(1), tm.toFixed(4), '', '']);
  rows.push(['', q('Volumes and masses from mesh, approx.'), '', '', '', '', '', '', '', '', '', '']);
  return rows.map(r => r.join(',')).join('\r\n') + '\r\n';
}

// The 8 isometric corners, shared by the DXF export and the viewer's view cube.
// Model axes: +X right, +Y back (so front is -Y), +Z up. A corner is the side
// the viewer looks FROM; the view direction points from that corner into the model.

export const CORNERS = [];
for (const sz of [1, -1]) {
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const key = `${sz > 0 ? 't' : 'b'}${sy < 0 ? 'f' : 'k'}${sx > 0 ? 'r' : 'l'}`;
      const label = `${sz > 0 ? 'Top' : 'Bottom'} ${sy < 0 ? 'front' : 'back'} ${sx > 0 ? 'right' : 'left'}`;
      CORNERS.push({ key, label, from: [sx, sy, sz], dir: [-sx, -sy, -sz], up: [0, 0, 1] });
    }
  }
}
export const DEFAULT_CORNER = 'tfr'; // top front right: the usual isometric
export const cornerByKey = (key) => CORNERS.find(c => c.key === key) || CORNERS.find(c => c.key === DEFAULT_CORNER);

/** Corner closest to a view direction (camera → target). */
export function nearestCorner(dir) {
  let best = null, bestDot = -Infinity;
  for (const c of CORNERS) {
    const d = (c.dir[0] * dir[0] + c.dir[1] * dir[1] + c.dir[2] * dir[2]) / Math.sqrt(3);
    if (d > bestDot) { bestDot = d; best = c; }
  }
  return best;
}

/**
 * Small SVG icon: a reference cube seen from slightly off the top-front-right
 * diagonal (so all 8 corners are apart), the 3 edges at the far corner dashed,
 * and one corner marked.
 */
const ICON_D = norm([-1, 1.8, -1.25]);           // view direction for the icon
const ICON_R = norm(cross(ICON_D, [0, 0, 1]));
const ICON_U = cross(ICON_R, ICON_D);
function norm(a) { const l = Math.hypot(...a); return a.map(v => v / l); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function cornerIcon(key, size = 44) {
  const k = size * 0.25;
  const proj = (p) => [size / 2 + dot3(p, ICON_R) * k, size / 2 - dot3(p, ICON_U) * k];
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push([sx, sy, sz]);
  const far = pts.reduce((a, b) => (dot3(b, ICON_D) > dot3(a, ICON_D) ? b : a));
  const same = (a, b) => a.every((s, i) => s === b[i]);
  const edges = [];
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const a = pts[i], b = pts[j];
    if (a.filter((s, n) => s !== b[n]).length !== 1) continue;
    const [x1, y1] = proj(a), [x2, y2] = proj(b);
    const hid = same(a, far) || same(b, far);
    edges.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${hid ? ' class="h"' : ''}/>`);
  }
  const [cx, cy] = proj(cornerByKey(key).from);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${edges.join('')}<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(size * 0.085).toFixed(1)}"/></svg>`;
}

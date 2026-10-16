// Build a 2D DXF drawing (orthographic views + isometric) with sdxf.js.
// Model space, 1:1, millimetres. Layers: VISIBLE, HIDDEN, DIMS, TEXT.
import { Drawing, Layer, LineType, Style, Line, LwPolyLine, Text, Solid } from '../vendor/sdxf.js';
import { viewFrame, collectEdges, projectedBounds, classify, cleanup, chain } from './projector.js';
import { renderDepth } from './depthRender.js';

export const DXF_VIEWS = {
  front: { label: 'FRONT', dir: [0, 1, 0], up: [0, 0, 1] },
  top: { label: 'TOP', dir: [0, 0, -1], up: [0, 1, 0] },
  right: { label: 'RIGHT', dir: [-1, 0, 0], up: [0, 0, 1] },
  left: { label: 'LEFT', dir: [1, 0, 0], up: [0, 0, 1] },
  bottom: { label: 'BOTTOM', dir: [0, 0, 1], up: [0, -1, 0] },
  back: { label: 'BACK', dir: [0, -1, 0], up: [0, 0, 1] },
  iso: { label: 'ISOMETRIC', dir: [-1, 1, -1], up: [0, 0, 1] },
};

const ISO_TRUE_LENGTH = Math.sqrt(3 / 2); // 1 / cos(35.264°): isometric drawing vs projection

const yieldUI = () => new Promise(r => setTimeout(r, 0));

/**
 * Project the given parts in one view.
 * parts: [{ geometry: THREE.BufferGeometry, analysis: { featureEdges, smoothEdges } }]
 */
export async function projectView(renderer, parts, dir, up, opts = {}) {
  const frame = viewFrame(dir, up);
  const b = projectedBounds(parts.map(p => p.geometry.attributes.position.array), frame);
  const size = Math.max(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin, 1e-6);
  const depth = renderDepth(renderer, parts.map(p => p.geometry), frame, b, opts.resolution || 4096);
  await yieldUI();
  const segs = collectEdges(parts.map(p => p.analysis), frame, { tangentEdges: !!opts.tangentEdges });
  const cls = classify(segs, frame, depth, { eps: 3e-4 });
  await yieldUI();
  const { visible, hidden } = cleanup(cls.visible, opts.hidden === false ? [] : cls.hidden, size);
  const tol = Math.max(size * 1e-6, 1e-4);
  return {
    frame, bounds: { xmin: b.xmin, xmax: b.xmax, ymin: b.ymin, ymax: b.ymax },
    visible: chain(visible, tol), hidden: chain(hidden, tol),
    stats: { candidates: segs.length / 6, pixels: depth.w + 'x' + depth.h, pxSize: depth.px },
  };
}

function transformView(v, scale, dx, dy) {
  const f = (pl) => ({ closed: pl.closed, pts: pl.pts.map(([x, y]) => [x * scale + dx, y * scale + dy]) });
  const b = v.bounds;
  return {
    ...v,
    visible: v.visible.map(f), hidden: v.hidden.map(f),
    bounds: { xmin: b.xmin * scale + dx, xmax: b.xmax * scale + dx, ymin: b.ymin * scale + dy, ymax: b.ymax * scale + dy },
  };
}

/**
 * Lay out the requested views. Returns { views: [{ key, label, visible, hidden, bounds, dims }], textHeight }.
 * opts: { views: ['front','top',...], angle: 'first'|'third', isoTrueLength, gap, dims }
 */
export async function buildSheet(renderer, parts, opts, onProgress = () => {}) {
  const keys = opts.views.filter(k => DXF_VIEWS[k] || k === 'current');
  const proj = {};
  let i = 0;
  for (const k of keys) {
    onProgress(`Projecting ${k === 'current' ? 'current view' : DXF_VIEWS[k].label.toLowerCase()} (${++i}/${keys.length})`);
    await yieldUI();
    const v = k === 'current' ? opts.current : DXF_VIEWS[k];
    proj[k] = await projectView(renderer, parts, v.dir, v.up, opts);
  }
  const all = Object.values(proj).map(v => v.bounds);
  const ext = Math.max(...all.map(b => Math.max(b.xmax - b.xmin, b.ymax - b.ymin)), 1);
  const gap = opts.gap || Math.max(ext * 0.25, 20);
  const textHeight = niceText(ext);

  const placed = {};
  const front = proj.front;
  const third = opts.angle === 'third';
  const W = (b) => b.xmax - b.xmin, H = (b) => b.ymax - b.ymin;
  if (front) placed.front = transformView(front, 1, 0, 0);
  const fb = front ? placed.front.bounds : { xmin: 0, xmax: 0, ymin: 0, ymax: 0 };
  const dimRoom = opts.dims ? textHeight * 6 : 0;
  // views aligned with the front view share one model axis with it
  const above = (v) => transformView(v, 1, 0, fb.ymax + gap + dimRoom - v.bounds.ymin);
  const below = (v) => transformView(v, 1, 0, fb.ymin - gap - dimRoom - v.bounds.ymax);
  const toRight = (v, ref) => transformView(v, 1, ref.xmax + gap + dimRoom - v.bounds.xmin, 0);
  const toLeft = (v) => transformView(v, 1, fb.xmin - gap - dimRoom - v.bounds.xmax, 0);
  if (front) {
    if (proj.top) placed.top = third ? above(proj.top) : below(proj.top);
    if (proj.bottom) placed.bottom = third ? below(proj.bottom) : above(proj.bottom);
    if (proj.right) placed.right = third ? toRight(proj.right, fb) : toLeft(proj.right);
    if (proj.left) placed.left = third ? toLeft(proj.left) : toRight(proj.left, fb);
    if (proj.back) {
      const outer = third ? (placed.right || placed.front) : (placed.left || placed.front);
      placed.back = toRight(proj.back, outer.bounds);
    }
  }
  // free views (no front view to align with, isometric, current) go in a row to the right
  let maxX = Math.max(...Object.values(placed).map(v => v.bounds.xmax), 0);
  const topY = Math.max(...Object.values(placed).map(v => v.bounds.ymax), 0);
  for (const k of keys) {
    if (placed[k]) continue;
    const v = proj[k];
    const s = (k === 'iso' && opts.isoTrueLength) ? ISO_TRUE_LENGTH : 1;
    const hasPlaced = Object.keys(placed).length > 0;
    const dx = (hasPlaced ? maxX + gap + dimRoom : 0) - v.bounds.xmin * s;
    const dy = (hasPlaced ? topY : 0) - v.bounds.ymax * s;
    placed[k] = transformView(v, s, dx, dy);
    placed[k].scale = s;
    maxX = placed[k].bounds.xmax;
  }
  const views = keys.map(k => ({
    key: k, label: k === 'current' ? 'VIEW' : DXF_VIEWS[k].label, ...placed[k],
    dims: opts.dims && k !== 'iso' && k !== 'current' ? { w: W(proj[k].bounds), h: H(proj[k].bounds) } : null,
  }));
  return { views, textHeight };
}

function niceText(ext) {
  const steps = [2.5, 3.5, 5, 7, 10, 14, 20, 28, 40, 56, 80];
  const want = ext / 70;
  return steps.find(s => s >= want) || steps[steps.length - 1];
}

const fmt = (v) => (Math.round(v * 10) / 10).toString();

/** Exploded linear dimension (lines, arrow solids, text) on layer DIMS. */
function addDim(dwg, p1, p2, offsetDir, offset, th, value) {
  const [ox, oy] = offsetDir;
  const a = [p1[0] + ox * offset, p1[1] + oy * offset], b = [p2[0] + ox * offset, p2[1] + oy * offset];
  const ext = th * 0.6;
  const o = { layer: 'DIMS' };
  dwg.append(new Line([[p1[0] + ox * th * 0.3, p1[1] + oy * th * 0.3, 0], [a[0] + ox * ext, a[1] + oy * ext, 0]], o));
  dwg.append(new Line([[p2[0] + ox * th * 0.3, p2[1] + oy * th * 0.3, 0], [b[0] + ox * ext, b[1] + oy * ext, 0]], o));
  dwg.append(new Line([[a[0], a[1], 0], [b[0], b[1], 0]], o));
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const al = th, aw = th / 3;
  for (const [tip, s] of [[a, 1], [b, -1]]) {
    const bx = tip[0] + ux * al * s, by = tip[1] + uy * al * s;
    const p = [[tip[0], tip[1], 0], [bx - uy * aw, by + ux * aw, 0], [bx + uy * aw, by - ux * aw, 0], [bx + uy * aw, by - ux * aw, 0]];
    dwg.append(new Solid([p[0], p[1], p[2], p[3]], o));
  }
  const rot = Math.atan2(uy, ux) * 180 / Math.PI;
  const txt = fmt(value);
  const tw = txt.length * th * 0.8;
  // keep the text on the outer side of the dimension line
  const upDot = -uy * ox + ux * oy;
  const off = upDot > 0 ? th * 0.5 : th * 1.5;
  const mx = (a[0] + b[0]) / 2 - ux * tw / 2 + ox * off, my = (a[1] + b[1]) / 2 - uy * tw / 2 + oy * off;
  dwg.append(new Text(txt, [mx, my, 0], { height: th, rotation: rot, layer: 'DIMS' }));
}

/** sdxf Drawing from a laid-out sheet. */
export function sheetToDxf(sheet, { title = '', hiddenLines = true } = {}) {
  const th = sheet.textHeight;
  const dash = Math.max(th * 1.2, 2);
  const dwg = new Drawing({
    insunits: 4, ltscale: 1,
    linetypes: [
      new LineType({ name: 'CONTINUOUS', description: 'Solid line' }),
      new LineType({ name: 'HIDDEN', description: 'Hidden __ __ __', elements: [dash, -dash / 2] }),
    ],
    layers: [
      new Layer({ name: '0', color: 7 }),
      new Layer({ name: 'VISIBLE', color: 7 }),
      new Layer({ name: 'HIDDEN', color: 8, lineType: 'HIDDEN' }),
      new Layer({ name: 'DIMS', color: 3 }),
      new Layer({ name: 'TEXT', color: 2 }),
    ],
    styles: [new Style({ name: 'STANDARD', font: 'txt', widthFactor: 1, obliqueAngle: 0 })],
  });
  const xmin = Math.min(...sheet.views.map(v => v.bounds.xmin));
  const xmax = Math.max(...sheet.views.map(v => v.bounds.xmax));
  const ymin = Math.min(...sheet.views.map(v => v.bounds.ymin));
  const ymax = Math.max(...sheet.views.map(v => v.bounds.ymax));
  dwg.extmin = [xmin, ymin - th * 6]; dwg.extmax = [xmax, ymax];

  const addPl = (pl, layer) => {
    if (pl.pts.length < 2) return;
    if (pl.pts.length === 2 && !pl.closed) {
      dwg.append(new Line([[...pl.pts[0], 0], [...pl.pts[1], 0]], { layer }));
    } else {
      dwg.append(new LwPolyLine(pl.pts, { flag: pl.closed ? 1 : 0, layer }));
    }
  };
  for (const v of sheet.views) {
    v.visible.forEach(pl => addPl(pl, 'VISIBLE'));
    if (hiddenLines) v.hidden.forEach(pl => addPl(pl, 'HIDDEN'));
    const b = v.bounds;
    const lblY = b.ymin - th * (v.dims ? 6.5 : 2.5);
    const label = v.scale && v.scale !== 1 ? `${v.label} (axes true length)` : v.label;
    dwg.append(new Text(label, [b.xmin, lblY, 0], { height: th, layer: 'TEXT' }));
    if (v.dims) {
      addDim(dwg, [b.xmin, b.ymin], [b.xmax, b.ymin], [0, -1], th * 3, th * 0.8, v.dims.w);
      addDim(dwg, [b.xmin, b.ymin], [b.xmin, b.ymax], [-1, 0], th * 3, th * 0.8, v.dims.h);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const lines = [title, `Units mm, scale 1:1. Generated ${date} by STEP Viewer from mesh edges (approximate).`].filter(Boolean);
  lines.forEach((t, i) => dwg.append(new Text(t, [xmin, ymin - th * (9 + 1.8 * i), 0], { height: i === 0 ? th * 1.2 : th * 0.7, layer: 'TEXT' })));
  return dwg.toString();
}

/** Quick SVG preview of a sheet (y flipped for screen). */
export function sheetToSvg(sheet, { hiddenLines = true } = {}) {
  const vs = sheet.views;
  const xmin = Math.min(...vs.map(v => v.bounds.xmin)), xmax = Math.max(...vs.map(v => v.bounds.xmax));
  const ymin = Math.min(...vs.map(v => v.bounds.ymin)), ymax = Math.max(...vs.map(v => v.bounds.ymax));
  const pad = (xmax - xmin + ymax - ymin) * 0.03 + sheet.textHeight * 7;
  const W = xmax - xmin + 2 * pad, H = ymax - ymin + 2 * pad;
  const sw = Math.max(W, H) / 900;
  const path = (pls) => pls.map(pl => 'M' + pl.pts.map(([x, y]) => `${(x - xmin + pad).toFixed(2)} ${(ymax - y + pad).toFixed(2)}`).join('L') + (pl.closed ? 'Z' : '')).join('');
  let body = '';
  for (const v of vs) {
    if (hiddenLines) body += `<path d="${path(v.hidden)}" class="hid" stroke-width="${sw}" stroke-dasharray="${sw * 6} ${sw * 3}"/>`;
    body += `<path d="${path(v.visible)}" class="vis" stroke-width="${sw * 1.5}"/>`;
    body += `<text x="${(v.bounds.xmin - xmin + pad).toFixed(1)}" y="${(ymax - v.bounds.ymin + pad + sheet.textHeight * 2.5).toFixed(1)}" font-size="${sheet.textHeight * 1.2}">${v.label}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

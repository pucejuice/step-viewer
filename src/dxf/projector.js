// Orthographic projection of mesh edges to 2D line work with hidden-line
// classification. Pure functions (no three.js) so they can be unit-tested.
//
// Line work = B-rep face boundary edges + view silhouettes (edges inside one
// B-rep face where the surface turns from facing the viewer to facing away).
// Visibility comes from a depth image rendered on the GPU (see depthRender.js):
// a sample on an edge is hidden when everything in the 3x3 pixels around it is
// nearer to the viewer than the sample.

export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** Orthonormal view frame: d = view direction (into the screen), u = screen up, r = screen right. */
export function viewFrame(dir, up) {
  const d = norm(dir);
  let r = cross(d, up);
  if (Math.hypot(...r) < 1e-9) r = cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]);
  r = norm(r);
  const u = cross(r, d);
  return { d, u, r };
}

/**
 * Candidate 3D segments for one view.
 * edgeSets: [{ featureEdges: Float32Array, smoothEdges: Float32Array }] (12 floats/edge)
 * Returns Float32Array of 6 floats per segment.
 */
export function collectEdges(edgeSets, frame, { tangentEdges = false, tangentAngle = 12 } = {}) {
  const out = [];
  const cosT = Math.cos(tangentAngle * Math.PI / 180);
  const { d } = frame;
  for (const s of edgeSets) {
    const fe = s.featureEdges;
    for (let i = 0; i < fe.length; i += 12) {
      const n1d = fe[i + 6] * d[0] + fe[i + 7] * d[1] + fe[i + 8] * d[2];
      const n2d = fe[i + 9] * d[0] + fe[i + 10] * d[1] + fe[i + 11] * d[2];
      if (!tangentEdges) {
        const c = fe[i + 6] * fe[i + 9] + fe[i + 7] * fe[i + 10] + fe[i + 8] * fe[i + 11];
        if (c > cosT && n1d * n2d > 0) continue; // tangent (smooth) B-rep edge, not a silhouette here
      }
      for (let k = 0; k < 6; k++) out.push(fe[i + k]);
    }
    const se = s.smoothEdges;
    for (let i = 0; i < se.length; i += 12) {
      const n1d = se[i + 6] * d[0] + se[i + 7] * d[1] + se[i + 8] * d[2];
      const n2d = se[i + 9] * d[0] + se[i + 10] * d[1] + se[i + 11] * d[2];
      if (n1d * n2d < 0) for (let k = 0; k < 6; k++) out.push(se[i + k]);
    }
  }
  return new Float32Array(out);
}

/** 2D extents and depth range of points (positions as flat xyz arrays) in a frame. */
export function projectedBounds(positionArrays, frame) {
  const b = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity };
  const { r, u, d } = frame;
  for (const p of positionArrays) {
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] * r[0] + p[i + 1] * r[1] + p[i + 2] * r[2];
      const y = p[i] * u[0] + p[i + 1] * u[1] + p[i + 2] * u[2];
      const z = p[i] * d[0] + p[i + 1] * d[1] + p[i + 2] * d[2];
      if (x < b.xmin) b.xmin = x; if (x > b.xmax) b.xmax = x;
      if (y < b.ymin) b.ymin = y; if (y > b.ymax) b.ymax = y;
      if (z < b.zmin) b.zmin = z; if (z > b.zmax) b.zmax = z;
    }
  }
  return b;
}

/** 3x3 max filter on a depth image (Float32Array, w*h). */
export function maxFilter3(src, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let m = src[o + x];
      if (x > 0 && src[o + x - 1] > m) m = src[o + x - 1];
      if (x < w - 1 && src[o + x + 1] > m) m = src[o + x + 1];
      tmp[o + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let m = tmp[i];
      if (y > 0 && tmp[i - w] > m) m = tmp[i - w];
      if (y < h - 1 && tmp[i + w] > m) m = tmp[i + w];
      out[i] = m;
    }
  }
  return out;
}

/**
 * Split segments into visible / hidden 2D pieces.
 * depth: { w, h, x0, y0, px, zNear, zFar, data } where data is the max-filtered
 * normalised depth (0 = zNear, 1 = zFar, >1 = background), row 0 at y0.
 * Returns { visible: number[], hidden: number[] } as flat x1,y1,x2,y2 lists.
 */
export function classify(segs, frame, depth, { eps = 3e-4, step = 0.7 } = {}) {
  const { r, u, d } = frame;
  const { w, h, x0, y0, px, zNear, zFar, data } = depth;
  const zs = 1 / (zFar - zNear);
  const visible = [], hidden = [];
  const states = [];
  for (let i = 0; i < segs.length; i += 6) {
    const ax = segs[i], ay = segs[i + 1], az = segs[i + 2], bx = segs[i + 3], by = segs[i + 4], bz = segs[i + 5];
    const X1 = ax * r[0] + ay * r[1] + az * r[2], Y1 = ax * u[0] + ay * u[1] + az * u[2], Z1 = (ax * d[0] + ay * d[1] + az * d[2] - zNear) * zs;
    const X2 = bx * r[0] + by * r[1] + bz * r[2], Y2 = bx * u[0] + by * u[1] + bz * u[2], Z2 = (bx * d[0] + by * d[1] + bz * d[2] - zNear) * zs;
    const lenPx = Math.hypot(X2 - X1, Y2 - Y1) / px;
    if (lenPx < 1e-3) continue; // edge seen end-on
    const n = Math.max(2, Math.ceil(lenPx / step));
    states.length = n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const ix = Math.floor((X1 + (X2 - X1) * t - x0) / px);
      const iy = Math.floor((Y1 + (Y2 - Y1) * t - y0) / px);
      const z = Z1 + (Z2 - Z1) * t;
      states[k] = (ix < 0 || iy < 0 || ix >= w || iy >= h) ? true : z <= data[iy * w + ix] + eps;
    }
    // remove isolated flips shorter than ~1.5 px (rasterisation noise)
    const minRun = Math.max(1, Math.round(1.5 / (lenPx / n)));
    let k = 0;
    while (k < n) {
      let j = k; while (j < n && states[j] === states[k]) j++;
      if (j - k < minRun && k > 0 && j < n && states[k - 1] === states[j]) for (let q = k; q < j; q++) states[q] = states[k - 1];
      k = j;
    }
    k = 0;
    while (k < n) {
      let j = k; while (j < n && states[j] === states[k]) j++;
      const t0 = k === 0 ? 0 : k / n, t1 = j === n ? 1 : j / n;
      const list = states[k] ? visible : hidden;
      list.push(X1 + (X2 - X1) * t0, Y1 + (Y2 - Y1) * t0, X1 + (X2 - X1) * t1, Y1 + (Y2 - Y1) * t1);
      k = j;
    }
  }
  return { visible, hidden };
}

// ── 2D clean-up ─────────────────────────────────────────────────────────────

function lineGroups(flat, angTol, distTol) {
  const groups = new Map();
  for (let i = 0; i < flat.length; i += 4) {
    const x1 = flat[i], y1 = flat[i + 1], x2 = flat[i + 2], y2 = flat[i + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < distTol) continue;
    let th = Math.atan2(y2 - y1, x2 - x1);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - angTol / 2) th -= Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    const rho = -s * x1 + c * y1;
    const key = Math.round(th / angTol) + ':' + Math.round(rho / distTol);
    let g = groups.get(key);
    if (!g) { g = { th, rho, c, s, iv: [], ka: Math.round(th / angTol), kr: Math.round(rho / distTol) }; groups.set(key, g); }
    const s1 = x1 * c + y1 * s, s2 = x2 * c + y2 * s;
    g.iv.push(s1 < s2 ? [s1, s2] : [s2, s1]);
  }
  return groups;
}

function mergeIntervals(iv, gap) {
  iv.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) { if (b > last[1]) last[1] = b; } else out.push([a, b]);
  }
  return out;
}

function subtract(iv, cut, gap) {
  // iv, cut: merged sorted intervals
  const out = [];
  for (let [a, b] of iv) {
    for (const [c, d] of cut) {
      if (d < a - gap || c > b + gap) continue;
      if (c - gap > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (b - a > gap) out.push([a, b]);
  }
  return out;
}

/**
 * Merge collinear overlapping pieces, drop hidden line work that lies under
 * visible line work. Returns { visible, hidden } as arrays of [x1,y1,x2,y2].
 */
export function cleanup(visibleFlat, hiddenFlat, size) {
  const angTol = 2e-4, distTol = Math.max(size * 2e-6, 1e-4), gap = distTol * 2;
  const gv = lineGroups(visibleFlat, angTol, distTol);
  const gh = lineGroups(hiddenFlat, angTol, distTol);
  const toSegs = (g, ivs, out) => {
    for (const [a, b] of ivs) {
      if (b - a < gap) continue;
      const ox = -g.s * g.rho, oy = g.c * g.rho;
      out.push([ox + a * g.c, oy + a * g.s, ox + b * g.c, oy + b * g.s]);
    }
  };
  const visible = [], hidden = [];
  for (const g of gv.values()) { g.iv = mergeIntervals(g.iv, gap); toSegs(g, g.iv, visible); }
  for (const g of gh.values()) {
    let iv = mergeIntervals(g.iv, gap);
    for (let da = -1; da <= 1 && iv.length; da++) {
      for (let dr = -1; dr <= 1 && iv.length; dr++) {
        const v = gv.get((g.ka + da) + ':' + (g.kr + dr));
        if (v) iv = subtract(iv, v.iv, gap * 2);
      }
    }
    toSegs(g, iv, hidden);
  }
  return { visible, hidden };
}

/** Join segments end to end into polylines. Returns [{ pts: [[x,y],...], closed }]. */
export function chain(segs, tol) {
  const key = (x, y) => Math.round(x / tol) + ',' + Math.round(y / tol);
  const nodes = new Map(); // key -> [segment indices]
  const ends = segs.map(s => [key(s[0], s[1]), key(s[2], s[3])]);
  ends.forEach(([a, b], i) => {
    if (a === b) return;
    (nodes.get(a) || nodes.set(a, []).get(a)).push(i);
    (nodes.get(b) || nodes.set(b, []).get(b)).push(i);
  });
  const used = new Uint8Array(segs.length);
  const out = [];
  const walk = (startSeg, startKey) => {
    // follow from startKey through segments while nodes have degree 2
    const pts = [];
    let segI = startSeg, at = startKey;
    const s0 = segs[segI];
    const first = ends[segI][0] === at ? [s0[0], s0[1]] : [s0[2], s0[3]];
    pts.push(first);
    while (true) {
      used[segI] = 1;
      const s = segs[segI];
      const forward = ends[segI][0] === at;
      const next = forward ? ends[segI][1] : ends[segI][0];
      pts.push(forward ? [s[2], s[3]] : [s[0], s[1]]);
      at = next;
      const list = nodes.get(at);
      if (!list || list.length !== 2) break;
      const n = list[0] === segI ? list[1] : list[0];
      if (used[n]) break;
      segI = n;
    }
    return { pts, endKey: at };
  };
  // open chains start at nodes whose degree is not 2
  for (const [k, list] of nodes) {
    if (list.length === 2) continue;
    for (const i of list) if (!used[i]) out.push({ pts: walk(i, k).pts, closed: false });
  }
  // what is left are closed loops
  for (let i = 0; i < segs.length; i++) {
    if (used[i] || ends[i][0] === ends[i][1]) continue;
    const w = walk(i, ends[i][0]);
    const closed = w.endKey === ends[i][0];
    if (closed) w.pts.pop();
    out.push({ pts: w.pts, closed });
  }
  return out;
}

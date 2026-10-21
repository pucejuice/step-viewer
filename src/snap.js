// Snapping for the measuring tools: corners, edge midpoints, circle / arc
// centres and the nearest point on an edge, from each part's B-rep feature
// edges (analysis.featureEdges, 12 floats per edge, model space).
import * as THREE from 'three';

export const SNAP_KINDS = ['corner', 'mid', 'centre', 'edge', 'face'];
const PRIORITY = { corner: 0, centre: 1, mid: 2, edge: 3, face: 4 };
const RADIUS_PX = { corner: 14, centre: 14, mid: 12, edge: 10 };

/** Corners, straight-edge midpoints, circle centres and segments for one part (cached). */
export function snapData(part) {
  if (part._snap) return part._snap;
  const fe = part.analysis.featureEdges;
  const n = fe.length / 12;
  const a = part.analysis;
  const size = Math.hypot(a.bboxMax[0] - a.bboxMin[0], a.bboxMax[1] - a.bboxMin[1], a.bboxMax[2] - a.bboxMin[2]) || 1;
  const tol = size * 1e-6 + 1e-6;
  const key = (x, y, z) => Math.round(x / tol) + ',' + Math.round(y / tol) + ',' + Math.round(z / tol);
  const nodes = new Map(); // key -> { p, segs: [i], end: [0|1] }
  const nodeOf = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    for (let e = 0; e < 2; e++) {
      const o = i * 12 + e * 3;
      const k = key(fe[o], fe[o + 1], fe[o + 2]);
      let nd = nodes.get(k);
      if (!nd) { nd = { p: [fe[o], fe[o + 1], fe[o + 2]], segs: [] }; nodes.set(k, nd); }
      nd.segs.push(i);
      nodeOf[i * 2 + e] = nd;
    }
  }
  const dirOf = (i, from) => {
    const o = i * 12;
    const a0 = [fe[o], fe[o + 1], fe[o + 2]], b0 = [fe[o + 3], fe[o + 4], fe[o + 5]];
    const [p, q] = nodeOf[i * 2] === from ? [a0, b0] : [b0, a0];
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const l = Math.hypot(...d) || 1;
    return d.map(v => v / l);
  };
  // a corner is a B-rep vertex: not exactly two edges meeting, or a sharp turn
  for (const nd of nodes.values()) {
    if (nd.segs.length !== 2) { nd.corner = true; continue; }
    const d1 = dirOf(nd.segs[0], nd), d2 = dirOf(nd.segs[1], nd);
    nd.corner = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) > -Math.cos(25 * Math.PI / 180);
  }
  const corners = [], mids = [], centres = [];
  for (const nd of nodes.values()) if (nd.corner) corners.push(nd.p);
  // a straight B-rep edge is a single segment between two corners
  for (let i = 0; i < n; i++) {
    if (nodeOf[i * 2].corner && nodeOf[i * 2 + 1].corner && nodeOf[i * 2] !== nodeOf[i * 2 + 1]) {
      const o = i * 12;
      mids.push([(fe[o] + fe[o + 3]) / 2, (fe[o + 1] + fe[o + 4]) / 2, (fe[o + 2] + fe[o + 5]) / 2]);
    }
  }
  // chains of smooth (non-corner) nodes: closed circles, or arcs between corners
  const used = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    // walk both ways through non-corner nodes
    const chain = [i];
    used[i] = 1;
    const ends = [nodeOf[i * 2], nodeOf[i * 2 + 1]];
    for (let side = 0; side < 2; side++) {
      let nd = ends[side], prev = i;
      while (nd && !nd.corner) {
        const next = nd.segs[0] === prev ? nd.segs[1] : nd.segs[0];
        if (next === undefined || used[next]) { nd = null; break; }
        used[next] = 1;
        if (side === 0) chain.unshift(next); else chain.push(next);
        nd = nodeOf[next * 2] === nd ? nodeOf[next * 2 + 1] : nodeOf[next * 2];
        prev = next;
      }
    }
    if (chain.length < 4) continue;
    const pts = [];
    for (const s of chain) { const o = s * 12; pts.push([fe[o], fe[o + 1], fe[o + 2]], [fe[o + 3], fe[o + 4], fe[o + 5]]); }
    const c = circleFit(pts);
    if (c) centres.push(c);
  }
  part._snap = { corners, mids, centres, segs: fe, size };
  return part._snap;
}

/** Circle through 3D points (centre, radius) when they lie on one, else null. */
function circleFit(pts) {
  // plane from three spread points
  const p0 = pts[0], p1 = pts[Math.floor(pts.length / 3)], p2 = pts[Math.floor(2 * pts.length / 3)];
  const v1 = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const v2 = new THREE.Vector3(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
  const nrm = new THREE.Vector3().crossVectors(v1, v2);
  if (nrm.lengthSq() < 1e-18) return null;
  // circumcentre of the three points
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1), c = new THREE.Vector3(...p2);
  const ab = b.clone().sub(a), ac = c.clone().sub(a), n = ab.clone().cross(ac);
  const cc = a.clone().add(
    n.clone().cross(ab).multiplyScalar(ac.lengthSq()).add(ac.clone().cross(n).multiplyScalar(ab.lengthSq()))
      .divideScalar(2 * n.lengthSq()));
  const r = cc.distanceTo(a);
  if (!Number.isFinite(r) || r <= 0) return null;
  for (const p of pts) {
    if (Math.abs(cc.distanceTo(new THREE.Vector3(...p)) - r) > r * 0.02) return null;
  }
  return [cc.x, cc.y, cc.z, r];
}

/**
 * Best snap under the cursor. opts.kinds: Set of enabled kinds.
 * Returns { point: Vector3, kind, normal, partId, radius? } or null.
 */
export function findSnap(viewer, clientX, clientY, kinds) {
  const cam = viewer.camera;
  const rc = new THREE.Raycaster();
  rc.setFromCamera(viewer.ndc(clientX, clientY), cam);
  const ray = rc.ray;
  const hit = viewer.pick(clientX, clientY);
  const H = viewer.renderer.domElement.getBoundingClientRect().height || 1;
  // model units per screen pixel at a given depth along the view
  const camDir = new THREE.Vector3();
  cam.getWorldDirection(camDir);
  const perPx = cam.isOrthographicCamera
    ? () => (cam.top - cam.bottom) / cam.zoom / H
    : (p) => Math.max(new THREE.Vector3().subVectors(p, cam.position).dot(camDir), 1e-6) * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / H;
  // A candidate counts only if the camera can see it: cast a ray from the eye
  // to the point and make sure no surface is clearly in front of it.
  const meshes = viewer.parts.filter(p => p && p.mesh.visible && !(viewer.isolated && viewer.ghost && !viewer.isolated.has(p.id))).map(p => p.mesh);
  const sight = new THREE.Raycaster();
  const seen = (p) => {
    const tol = Math.max(perPx(p) * 2, (viewer.sceneRadius || 1) * 1e-5);
    let origin, dist;
    if (cam.isOrthographicCamera) {
      origin = p.clone().addScaledVector(camDir, -(viewer.sceneRadius || 1) * 4);
      dist = (viewer.sceneRadius || 1) * 4;
      sight.set(origin, camDir);
    } else {
      const d = new THREE.Vector3().subVectors(p, cam.position);
      dist = d.length();
      sight.set(cam.position, d.normalize());
    }
    sight.far = dist - tol;
    for (const h of sight.intersectObjects(meshes, false)) {
      if (viewer.section.axis && viewer.clipPlane.distanceToPoint(h.point) < 0) continue;
      return false; // something in front
    }
    return true;
  };
  // ignore points cut away by the section plane
  const ok = viewer.section.axis
    ? (p) => viewer.clipPlane.distanceToPoint(p) >= -1e-6 && seen(p)
    : seen;
  return best(candidateParts(), ok);

  function candidateParts() {
    const out = [];
    for (const p of viewer.parts) {
      if (!p || !p.mesh.visible) continue;
      if (viewer.isolated && viewer.ghost && !viewer.isolated.has(p.id)) continue;
      const s = p.mesh.geometry.boundingSphere;
      const pad = perPx(s.center) * 16;
      if (ray.distanceSqToPoint(s.center) <= (s.radius + pad) ** 2) out.push(p);
    }
    return out;
  }

  function best(candidates, ok) {
    const offers = [];
    const offer = (kind, point, part, extra) => {
      if (!kinds.has(kind)) return;
      const px = Math.sqrt(ray.distanceSqToPoint(point)) / perPx(point);
      if (px > RADIUS_PX[kind]) return;
      offers.push({ score: PRIORITY[kind] * 1000 + px, snap: { point: point.clone(), kind, partId: part.id, ...extra } });
    };
    const v = new THREE.Vector3(), segA = new THREE.Vector3(), segB = new THREE.Vector3(), onSeg = new THREE.Vector3();
    for (const part of candidates) {
      const d = snapData(part);
      for (const c of d.corners) offer('corner', v.set(c[0], c[1], c[2]), part);
      for (const m of d.mids) offer('mid', v.set(m[0], m[1], m[2]), part);
      for (const c of d.centres) offer('centre', v.set(c[0], c[1], c[2]), part, { radius: c[3] });
      if (kinds.has('edge')) {
        const fe = d.segs;
        for (let i = 0; i < fe.length; i += 12) {
          segA.set(fe[i], fe[i + 1], fe[i + 2]); segB.set(fe[i + 3], fe[i + 4], fe[i + 5]);
          ray.distanceSqToSegment(segA, segB, null, onSeg);
          offer('edge', onSeg, part);
        }
      }
    }
    offers.sort((x, y) => x.score - y.score);
    let bestSnap = null;
    // hole centres sit in empty space: check the rim is in view instead of the centre
    for (const o of offers.slice(0, 40)) {
      if (o.snap.kind === 'centre' ? (ok === seen || viewer.clipPlane.distanceToPoint(o.snap.point) >= -1e-6) : ok(o.snap.point)) { bestSnap = o.snap; break; }
    }
    if (!bestSnap && hit && kinds.has('face')) {
      bestSnap = { point: hit.point.clone(), kind: 'face', partId: hit.object.userData.partId };
    }
    if (bestSnap) {
      bestSnap.normal = hit ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
      bestSnap.hitPart = hit ? hit.object.userData.partId : null;
    }
    return bestSnap;
  }
}

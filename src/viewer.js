// three.js scene: cameras, controls, picking, edges, section plane with caps.
// The model is Z-up (as STEP files are); the camera's up vector is +Z.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const VIEWS = {
  front: { dir: [0, 1, 0], up: [0, 0, 1] },
  back: { dir: [0, -1, 0], up: [0, 0, 1] },
  right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, -1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, 1], up: [0, -1, 0] },
  iso: { dir: [-1, 1, -1], up: [0, 0, 1] },
};

const SELECT_COLOR = new THREE.Color(0xff8c1a);
const THEMES = {
  light: { bg: 0xf2f4f7, edge: 0x1f2328, cap: 0xc0392b },
  dark: { bg: 0x1b1e23, edge: 0x0a0a0a, cap: 0xe06c5a },
};

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.modelGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.capGroup = new THREE.Group();
    this.overlay = new THREE.Group(); // measurement markers
    this.scene.add(this.modelGroup, this.edgeGroup, this.capGroup, this.overlay);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
    this.headLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.headLight);

    const aspect = 1;
    this.persp = new THREE.PerspectiveCamera(35, aspect, 0.1, 1e7);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.camera = this.persp;
    this.persp.position.set(1000, -1000, 800);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.parts = []; // { id, mesh, edges, analysis, ... } set by the app
    this.selected = new Set();
    this.opacityOthers = 1;
    this.ghost = false;
    this.isolated = null; // Set of part ids or null
    this.edgesOn = true;
    this.section = { axis: null, value: 0, flip: false, caps: true };
    this.clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    this.theme = 'dark';
    this.onRenderHooks = [];
    this._needsRender = true;
    this.setTheme('dark');

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this._needsRender) { this._needsRender = false; this.render(); }
    };
    loop();
  }

  requestRender() { this._needsRender = true; }

  render() {
    this.headLight.position.copy(this.camera.position);
    this.headLight.target.position.copy(this.controls.target);
    this.headLight.target.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    for (const h of this.onRenderHooks) h();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this._updateOrthoFrustum();
    this.requestRender();
  }

  _updateOrthoFrustum() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const half = this._orthoHalf || 500;
    this.ortho.left = -half * w / h; this.ortho.right = half * w / h;
    this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }

  setTheme(name) {
    this.theme = name;
    const t = THEMES[name];
    this.renderer.setClearColor(t.bg, 1);
    for (const p of this.parts) p.edges.material.color.setHex(t.edge);
    if (this.capMaterial) this.capMaterial.color.setHex(t.cap);
    this.requestRender();
  }

  // ── parts ──────────────────────────────────────────────────────────────
  addPart(part, meshData) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    if (meshData.normals) g.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    g.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    if (!meshData.normals) g.computeVertexNormals();
    g.computeBoundingBox(); g.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      color: part.color, roughness: 0.65, metalness: 0.1, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      clippingPlanes: [],
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData.partId = part.id;
    this.modelGroup.add(mesh);

    // feature edges = B-rep face boundaries (6 positions out of 12 floats per edge)
    const fe = meshData.analysis.featureEdges;
    const ne = fe.length / 12;
    const ep = new Float32Array(ne * 6);
    for (let i = 0; i < ne; i++) for (let k = 0; k < 6; k++) ep[i * 6 + k] = fe[i * 12 + k];
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
    const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: THEMES[this.theme].edge, clippingPlanes: [], transparent: true }));
    edges.userData.partId = part.id;
    edges.visible = this.edgesOn;
    this.edgeGroup.add(edges);

    part.mesh = mesh; part.edges = edges;
    this.parts[part.id] = part;
    this.requestRender();
  }

  clear() {
    for (const p of this.parts) {
      if (!p) continue;
      p.mesh.geometry.dispose(); p.mesh.material.dispose();
      p.edges.geometry.dispose(); p.edges.material.dispose();
    }
    this.modelGroup.clear(); this.edgeGroup.clear();
    this.parts = []; this.selected.clear(); this.isolated = null;
    this._rebuildCaps();
    this.requestRender();
  }

  partVisible(p) { return p.visible && (!this.isolated || this.isolated.has(p.id) || this.ghost); }

  /** Apply visibility, selection colour and transparency to every part. */
  refreshAppearance() {
    const anySel = this.selected.size > 0;
    for (const p of this.parts) {
      if (!p) continue;
      const isoOut = this.isolated && !this.isolated.has(p.id);
      const vis = p.visible && (!isoOut || this.ghost);
      p.mesh.visible = vis;
      p.edges.visible = vis && this.edgesOn;
      const m = p.mesh.material;
      const sel = this.selected.has(p.id);
      m.color.copy(sel ? SELECT_COLOR : p.color);
      m.emissive.setHex(sel ? 0x552200 : 0x000000);
      let op = 1;
      if (isoOut && this.ghost) op = 0.12;
      else if (anySel && !sel) op = this.opacityOthers;
      const tr = op < 0.999;
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.opacity = op; m.depthWrite = !tr;
      p.edges.material.opacity = Math.max(op, 0.15);
      p.mesh.renderOrder = tr ? 3 : 2;
    }
    this.requestRender();
  }

  setEdges(on) { this.edgesOn = on; this.refreshAppearance(); }

  // ── bounds / camera ────────────────────────────────────────────────────
  boundsOf(ids) {
    const box = new THREE.Box3();
    for (const id of ids) {
      const p = this.parts[id];
      if (p && p.mesh.geometry.boundingBox) box.union(p.mesh.geometry.boundingBox);
    }
    return box;
  }

  visibleIds() { return this.parts.filter(p => p && p.mesh.visible).map(p => p.id); }

  fit(ids, dir = null, up = null, { animate = false } = {}) {
    if (!ids || !ids.length) ids = this.visibleIds();
    if (!ids.length) return;
    const box = this.boundsOf(ids);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    const target = sphere.center;
    const d = dir ? new THREE.Vector3(...dir).normalize()
      : new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    // The orbit controls keep +Z up. For top/bottom views (view ∥ Z) tilt the
    // view by a hair so that the requested `up` ends up at the top of the screen.
    if (Math.abs(d.z) > 0.9999) {
      const u = up ? new THREE.Vector3(...up) : new THREE.Vector3(0, 1, 0);
      d.addScaledVector(u, -1e-4 * Math.sign(d.z)).normalize();
    }
    // fit the sphere in the narrower of the vertical and horizontal field of view
    const vfov = THREE.MathUtils.degToRad(this.persp.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.persp.aspect);
    const fov = Math.min(vfov, hfov);
    const dist = r / Math.sin(fov / 2) * 1.1;
    const end = { target: target.clone(), offset: d.clone().multiplyScalar(-dist), half: r * 1.1 * Math.max(1, 1 / this.persp.aspect) };
    this.sceneRadius = Math.max(this.sceneRadius || 0, r);
    cancelAnimationFrame(this._anim);
    if (!animate) { this._applyView(end.target, end.offset, end.half); return; }
    // swing the camera round the model (used by the view cube)
    const start = {
      target: this.controls.target.clone(),
      offset: new THREE.Vector3().subVectors(this.camera.position, this.controls.target),
      half: (this._orthoHalf || end.half) / this.ortho.zoom,
    };
    // Animate like an orbit: turn about Z (shortest way round) while tilting.
    // Interpolating the 3D direction instead can pass over a pole, where +Z up
    // is undefined and the view spins.
    const sph = (v) => ({ r: v.length(), th: Math.atan2(v.y, v.x), ph: Math.acos(THREE.MathUtils.clamp(v.z / v.length(), -1, 1)) });
    const a = sph(start.offset), z = sph(end.offset);
    let dth = z.th - a.th;
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    const EPS = 1e-4;
    const t0 = performance.now(), ms = 360;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      if (t >= 1) { this._applyView(end.target, end.offset, end.half); return; }
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const r = THREE.MathUtils.lerp(a.r, z.r, e);
      const th = a.th + dth * e;
      const ph = THREE.MathUtils.clamp(THREE.MathUtils.lerp(a.ph, z.ph, e), EPS, Math.PI - EPS);
      const offset = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)).multiplyScalar(r);
      this._applyView(start.target.clone().lerp(end.target, e), offset, THREE.MathUtils.lerp(start.half, end.half, e));
      this._anim = requestAnimationFrame(step);
    };
    step();
  }

  _applyView(target, offset, half) {
    const dist = offset.length();
    for (const c of [this.persp, this.ortho]) {
      c.up.set(0, 0, 1);
      c.position.copy(target).add(offset);
      c.lookAt(target);
    }
    this.persp.near = Math.max(dist / 1000, 0.01); this.persp.far = dist * 100; this.persp.updateProjectionMatrix();
    this._orthoHalf = half;
    this.ortho.zoom = 1;
    this._updateOrthoFrustum();
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  setView(name, ids) {
    const v = VIEWS[name];
    this.fit(ids, v.dir, v.up);
  }

  setOrtho(on) {
    const from = this.camera, to = on ? this.ortho : this.persp;
    if (from === to) return;
    to.position.copy(from.position); to.up.copy(from.up); to.lookAt(this.controls.target);
    if (on) {
      // match apparent size at the target distance
      const dist = from.position.distanceTo(this.controls.target);
      this._orthoHalf = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      this.ortho.zoom = 1;
      this._updateOrthoFrustum();
    } else {
      const half = this._orthoHalf / this.ortho.zoom;
      const dist = half / Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      const dir = new THREE.Vector3().subVectors(from.position, this.controls.target).normalize();
      to.position.copy(this.controls.target).addScaledVector(dir, dist);
    }
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.requestRender();
  }

  /** View direction (camera → target) and screen-up vector, in model space. */
  viewBasis() {
    const d = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    return { dir: d.toArray(), up: up.toArray() };
  }

  // ── picking ────────────────────────────────────────────────────────────
  ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  pick(clientX, clientY) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const meshes = this.parts.filter(p => p && p.mesh.visible && !(this.isolated && this.ghost && !this.isolated.has(p.id))).map(p => p.mesh);
    const hits = rc.intersectObjects(meshes, false);
    for (const h of hits) {
      if (this.section.axis && this.clipPlane.distanceToPoint(h.point) < 0) continue;
      return h;
    }
    return null;
  }

  /** World point → CSS pixel position in the canvas. */
  toScreen(v) {
    const p = new THREE.Vector3(...(Array.isArray(v) ? v : v.toArray())).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (p.x + 1) / 2 * r.width, y: (1 - p.y) / 2 * r.height, behind: p.z > 1 };
  }

  // ── section plane ──────────────────────────────────────────────────────
  setSection({ axis = this.section.axis, value = this.section.value, flip = this.section.flip, caps = this.section.caps } = {}) {
    this.section = { axis, value, flip, caps };
    const planes = axis ? [this.clipPlane] : [];
    if (axis) {
      const n = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
      // keep the side where n·p <= value (or >= when flipped)
      if (flip) this.clipPlane.set(n, -value); else this.clipPlane.set(n.negate(), value);
    }
    for (const p of this.parts) {
      if (!p) continue;
      p.mesh.material.clippingPlanes = planes;
      p.edges.material.clippingPlanes = planes;
    }
    this._rebuildCaps();
    this.requestRender();
  }

  /** Stencil caps (three.js webgl_clipping_stencil approach), one cap for all parts. */
  _rebuildCaps() {
    for (const c of this.capGroup.children) { if (c.material) c.material.dispose(); if (c.geometry && c.userData.ownGeom) c.geometry.dispose(); }
    this.capGroup.clear();
    if (!this.section.axis || !this.section.caps) return;
    const planes = [this.clipPlane];
    const base = { depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, clippingPlanes: planes };
    const back = new THREE.MeshBasicMaterial({ ...base, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp });
    const front = new THREE.MeshBasicMaterial({ ...base, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp });
    for (const p of this.parts) {
      if (!p || !p.mesh.visible) continue;
      const b = new THREE.Mesh(p.mesh.geometry, back); b.renderOrder = 1;
      const f = new THREE.Mesh(p.mesh.geometry, front); f.renderOrder = 1;
      this.capGroup.add(b, f);
    }
    const box = this.boundsOf(this.visibleIds());
    const size = box.isEmpty() ? 1000 : box.getSize(new THREE.Vector3()).length() * 2;
    this.capMaterial = new THREE.MeshStandardMaterial({
      color: THEMES[this.theme].cap, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.capMaterial);
    cap.userData.ownGeom = true;
    cap.renderOrder = 1.1;
    cap.onAfterRender = (r) => r.clearStencil();
    // orient the plane onto the clip plane
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    this.clipPlane.projectPoint(c, cap.position);
    cap.lookAt(cap.position.clone().add(this.clipPlane.normal));
    this.capGroup.add(cap);
  }

  // ── screenshot ─────────────────────────────────────────────────────────
  /** Render now and return a canvas with the WebGL image plus the given labels drawn on top. */
  snapshot(labels = []) {
    this.render();
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const scale = src.width / src.getBoundingClientRect().width;
    ctx.font = `${Math.round(12 * scale)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      const lines = l.text.split('\n');
      const lh = 15 * scale;
      const w = Math.max(...lines.map(t => ctx.measureText(t).width)) + 10 * scale;
      const h = lines.length * lh + 6 * scale;
      const x = l.x * scale - w / 2, y = l.y * scale - h / 2;
      ctx.fillStyle = 'rgba(20,24,30,0.85)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#fff';
      lines.forEach((t, i) => ctx.fillText(t, x + 5 * scale, y + 3 * scale + lh * (i + 0.5)));
    }
    return out;
  }
}

// View cube: a small cube in the corner of the 3D view that turns with the
// camera. Its 26 regions (6 faces, 12 edges, 8 corners) are clickable and
// swing the camera to look from that side. Model axes: +Z up, front = -Y.
import * as THREE from 'three';
import { CORNERS } from './corners.js';

const FACE_LABELS = { 'x1': 'RIGHT', 'x-1': 'LEFT', 'y1': 'BACK', 'y-1': 'FRONT', 'z1': 'TOP', 'z-1': 'BOTTOM' };
const T = 0.34; // width of the edge / corner bands, cube spans -1..1

function labelTexture(text, dark) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#e9edf2' : '#2b323c';
  g.font = `600 ${text.length > 5 ? 24 : 28}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Human name of a region, e.g. "Top front right" or "Front". */
function regionName(n) {
  const parts = [];
  if (n[2]) parts.push(n[2] > 0 ? 'top' : 'bottom');
  if (n[1]) parts.push(n[1] < 0 ? 'front' : 'back');
  if (n[0]) parts.push(n[0] > 0 ? 'right' : 'left');
  const s = parts.join(' ');
  return s[0].toUpperCase() + s.slice(1);
}

export class ViewCube {
  /** onPick({ dir, up, name }) is called with the view direction (camera → target). */
  constructor(host, viewer, onPick) {
    this.viewer = viewer;
    this.onPick = onPick;
    this.size = 104;
    this.el = document.createElement('div');
    this.el.className = 'viewcube';
    this.el.title = 'Click a face, edge or corner to view from that side';
    host.appendChild(this.el);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.size, this.size);
    this.el.appendChild(this.renderer.domElement);
    // turn / flip buttons: reach every side, including the underside, in one click
    const bar = document.createElement('div');
    bar.className = 'viewcube-bar';
    bar.innerHTML = `<button data-act="left" title="Turn the view 90° to the left (around the vertical axis)" aria-label="Turn left">⟲</button>
      <button data-act="flip" title="Flip between looking from above and from below" aria-label="Flip top / bottom">⇅</button>
      <button data-act="right" title="Turn the view 90° to the right (around the vertical axis)" aria-label="Turn right">⟳</button>`;
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act) this._turn(act);
    });
    this.el.appendChild(bar);
    this.tip = document.createElement('div');
    this.tip.className = 'viewcube-tip';
    this.el.appendChild(this.tip);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, -3, 4);
    this.scene.add(key);
    this.regions = [];
    this.labels = [];
    this.dark = true;
    this._build();
    this.hover = null;

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this._hover(e));
    el.addEventListener('pointerleave', () => this._setHover(null));
    el.addEventListener('click', (e) => {
      const r = this._regionAt(e);
      if (r) this.onPick({ dir: r.dir, up: r.up, name: r.name });
    });
    viewer.onRenderHooks.push(() => this.render());
  }

  _build() {
    const box = (n) => {
      // extent per axis: full band where n=0, thin band at the side where n=±1
      const size = [], pos = [];
      for (let k = 0; k < 3; k++) {
        if (n[k] === 0) { size.push(2 - 2 * T); pos.push(0); } else { size.push(T); pos.push(n[k] * (1 - T / 2)); }
      }
      return { size, pos };
    };
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const n = [x, y, z];
      const nz = n.filter(v => v !== 0).length;
      if (nz === 0) continue;
      const { size, pos } = box(n);
      const geo = new THREE.BoxGeometry(...size);
      const kind = nz === 1 ? 'face' : nz === 2 ? 'edge' : 'corner';
      const base = new THREE.MeshLambertMaterial({ color: kind === 'face' ? 0xdfe4ea : kind === 'edge' ? 0xc4cbd4 : 0xaab3bf });
      const mat = base;
      if (kind === 'face') {
        // label plane just outside the face; text up is +Z on the sides, and
        // matches the top / bottom view orientation on those faces
        const normal = new THREE.Vector3(...n);
        const up = n[2] === 1 ? new THREE.Vector3(0, 1, 0) : n[2] === -1 ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1);
        const right = new THREE.Vector3().crossVectors(up, normal);
        const key = (n[0] ? 'x' : n[1] ? 'y' : 'z') + (n[0] || n[1] || n[2]);
        const label = new THREE.Mesh(new THREE.PlaneGeometry(2 - 2 * T, 2 - 2 * T),
          new THREE.MeshBasicMaterial({ map: labelTexture(FACE_LABELS[key], false), transparent: true }));
        label.matrixAutoUpdate = false;
        label.matrix.makeBasis(right, up, normal).setPosition(normal.clone().multiplyScalar(1.001));
        this.labels.push(label);
        this.scene.add(label);
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...pos);
      const len = Math.hypot(...n);
      const from = n.map(v => v / len);
      const dir = from.map(v => -v);
      // up vector: +Z, except top / bottom faces (looking straight down / up) use ±Y
      let up = [0, 0, 1];
      if (kind === 'face' && n[2] === 1) up = [0, 1, 0];
      if (kind === 'face' && n[2] === -1) up = [0, -1, 0];
      const corner = kind === 'corner' ? CORNERS.find(c => c.from.every((v, i) => v === n[i])) : null;
      mesh.userData.region = { n, kind, dir, up, name: corner ? corner.label : regionName(n), base, color: base.color.getHex() };
      this.regions.push(mesh);
      this.scene.add(mesh);
    }
    // thin dark outline so the regions read as one cube
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x59626e }));
    this.scene.add(edges);
    // axis hints at the back-left-bottom corner: X red, Y green, Z blue
    const axes = new THREE.Group();
    const mk = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.08, -1.08, -1.08), new THREE.Vector3(...to)]);
      axes.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    };
    mk([0.2, -1.08, -1.08], 0xd9534f); mk([-1.08, 0.2, -1.08], 0x4caf50); mk([-1.08, -1.08, 0.2], 0x3d7be0);
    this.scene.add(axes);
  }

  /** Turn the current view 90° about +Z, or flip it to the other side of the horizontal plane. */
  _turn(act) {
    const { dir, up } = this.viewer.viewBasis();
    let d = dir.slice(), u = up.slice();
    if (act === 'flip') {
      d = [d[0], d[1], -d[2]];
      u = Math.abs(d[2]) > 0.999 ? [u[0], -u[1], 0] : [0, 0, 1];
    } else {
      const s = act === 'left' ? -1 : 1; // view turns right = model turns left
      const rot = ([x, y, z]) => [-s * y, s * x, z];
      d = rot(d); u = rot(u);
      if (Math.abs(d[2]) <= 0.999) u = [0, 0, 1];
    }
    this.onPick({ dir: d, up: u, name: act });
  }

  setTheme(dark) {
    this.dark = dark;
    this.el.classList.toggle('dark', dark);
    this.render();
  }

  _regionAt(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(v, this.camera);
    const hit = rc.intersectObjects(this.regions, false)[0];
    return hit ? hit.object.userData.region : null;
  }

  _hover(e) { this._setHover(this._regionAt(e)); }

  _setHover(region) {
    if (this.hover === region) return;
    if (this.hover) this.hover.base.color.setHex(this.hover.color);
    this.hover = region;
    if (region) region.base.color.setHex(0xffb366);
    this.renderer.domElement.style.cursor = region ? 'pointer' : '';
    this.tip.textContent = region ? region.name : '';
    this.tip.hidden = !region;
    this.render();
  }

  /** Match the main camera's orientation. */
  render() {
    const q = this.viewer.camera.quaternion;
    this.camera.position.set(0, 0, 6).applyQuaternion(q);
    this.camera.quaternion.copy(q);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
  }
}

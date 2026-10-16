// Point-to-point distance (snaps to mesh vertices) and angle between two faces.
import * as THREE from 'three';

const SNAP_PX = 14;
const COLORS = { distance: 0xe0245e, angle: 0x1f8f4e };

export class Measurements {
  constructor(viewer, labelHost, listEl, hintEl) {
    this.viewer = viewer; this.labelHost = labelHost; this.listEl = listEl; this.hintEl = hintEl;
    this.mode = '';
    this.items = [];
    this.pendingPick = null;
    this.counter = 0;
    viewer.onRenderHooks.push(() => this.updateLabels());
  }

  setMode(mode) {
    this.mode = mode;
    this._clearPending();
    this.hint();
  }

  hint(text) {
    if (!this.mode) { this.hintEl.hidden = true; return; }
    this.hintEl.hidden = false;
    this.hintEl.textContent = text || (this.mode === 'distance'
      ? (this.pendingPick ? 'Click the second point' : 'Distance: click the first point (snaps to vertices)')
      : (this.pendingPick ? 'Click the second face' : 'Face angle: click the first face'));
  }

  /** Pick a point; snap to the nearest vertex of the hit triangle within SNAP_PX. */
  pickPoint(x, y) {
    const hit = this.viewer.pick(x, y);
    if (!hit) return null;
    const pos = hit.object.geometry.attributes.position;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    let best = null, bestD = SNAP_PX;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      const s = this.viewer.toScreen(v);
      const d = Math.hypot(s.x + rect.left - x, s.y + rect.top - y);
      if (d < bestD) { bestD = d; best = v; }
    }
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { point: best || hit.point.clone(), snapped: !!best, normal, partId: hit.object.userData.partId };
  }

  click(x, y) {
    const p = this.pickPoint(x, y);
    if (!p) { this.hint('Nothing under the cursor'); return; }
    if (!this.pendingPick) {
      this.pendingPick = p;
      this.pendingMarker = this._marker([p.point], COLORS[this.mode]);
      this.viewer.overlay.add(this.pendingMarker);
      this.viewer.requestRender();
      this.hint();
      return;
    }
    const a = this.pendingPick;
    this._clearPending();
    this.add(this.mode, a, p);
    this.hint();
  }

  add(type, a, b) {
    const id = ++this.counter;
    const group = new THREE.Group();
    const col = COLORS[type];
    group.add(this._marker([a.point, b.point], col));
    const lg = new THREE.BufferGeometry().setFromPoints([a.point, b.point]);
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true }));
    line.renderOrder = 10;
    group.add(line);
    this.viewer.overlay.add(group);
    let text, summary;
    if (type === 'distance') {
      const d = new THREE.Vector3().subVectors(b.point, a.point);
      const L = d.length();
      text = `${L.toFixed(1)} mm\ndX ${d.x.toFixed(1)}  dY ${d.y.toFixed(1)}  dZ ${d.z.toFixed(1)}`;
      summary = `<b>${L.toFixed(2)} mm</b> <span class="muted">dX ${d.x.toFixed(2)}, dY ${d.y.toFixed(2)}, dZ ${d.z.toFixed(2)}${a.snapped && b.snapped ? '' : ' (not snapped)'}</span>`;
    } else {
      const c = THREE.MathUtils.clamp(a.normal.dot(b.normal), -1, 1);
      const ang = THREE.MathUtils.radToDeg(Math.acos(c));
      text = `${ang.toFixed(1)}° between normals\n${(180 - ang).toFixed(1)}° supplement`;
      summary = `<b>${ang.toFixed(2)}°</b> between face normals <span class="muted">(${(180 - ang).toFixed(2)}° supplement)</span>`;
    }
    const label = document.createElement('div');
    label.className = 'mlabel';
    label.textContent = text;
    this.labelHost.appendChild(label);
    const mid = new THREE.Vector3().addVectors(a.point, b.point).multiplyScalar(0.5);
    const item = { id, type, a, b, mid, group, label, text, summary };
    this.items.push(item);
    this.renderList();
    this.viewer.requestRender();
    return item;
  }

  remove(id) {
    const i = this.items.findIndex(m => m.id === id);
    if (i < 0) return;
    const m = this.items[i];
    this.viewer.overlay.remove(m.group);
    m.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    m.label.remove();
    this.items.splice(i, 1);
    this.renderList();
    this.viewer.requestRender();
  }

  clear() {
    this._clearPending();
    for (const m of [...this.items]) this.remove(m.id);
  }

  renderList() {
    this.listEl.innerHTML = '';
    for (const m of this.items) {
      const li = document.createElement('li');
      li.innerHTML = `${m.type === 'distance' ? 'Distance' : 'Angle'}: ${m.summary}`;
      const del = document.createElement('button');
      del.className = 'small'; del.textContent = '✕'; del.title = 'Remove';
      del.addEventListener('click', () => this.remove(m.id));
      li.appendChild(del);
      this.listEl.appendChild(li);
    }
    if (!this.items.length) this.listEl.innerHTML = '<li class="muted" style="list-style:none;margin-left:-20px">No measurements yet.</li>';
  }

  updateLabels() {
    for (const m of this.items) {
      const s = this.viewer.toScreen(m.mid);
      m.label.style.left = s.x + 'px';
      m.label.style.top = s.y + 'px';
      m.label.style.display = s.behind ? 'none' : '';
      m.screen = s;
    }
  }

  labelsForSnapshot() {
    this.updateLabels();
    return this.items.filter(m => !m.screen.behind).map(m => ({ x: m.screen.x, y: m.screen.y, text: m.text }));
  }

  _marker(points, color) {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false, transparent: true }));
    pts.renderOrder = 11;
    return pts;
  }

  _clearPending() {
    this.pendingPick = null;
    if (this.pendingMarker) {
      this.viewer.overlay.remove(this.pendingMarker);
      this.pendingMarker.geometry.dispose(); this.pendingMarker.material.dispose();
      this.pendingMarker = null;
      this.viewer.requestRender();
    }
  }
}

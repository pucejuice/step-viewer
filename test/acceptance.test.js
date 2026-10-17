// Node tests on the open samples: parse with occt-import-js, then check the
// numbers the viewer shows (brief acceptance checks 1-4) and the DXF pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { analyseMesh, faceIdsFromBrep, sumProps } from '../src/meshAnalysis.js';
import { detectUnit } from '../src/units.js';
import { groupParts } from '../src/partsList.js';
import { viewFrame, collectEdges, classify, cleanup, chain } from '../src/dxf/projector.js';

const require = createRequire(import.meta.url);
const occt = await require('occt-import-js')();
const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.15 };

function load(name) {
  const bytes = readFileSync(new URL('../samples/' + name, import.meta.url));
  const format = name.endsWith('.igs') ? 'iges' : 'step';
  const res = format === 'iges' ? occt.ReadIgesFile(bytes, params) : occt.ReadStepFile(bytes, params);
  assert.ok(res.success, name + ' parsed');
  const meshes = res.meshes.map((m) => {
    const positions = new Float32Array(m.attributes.position.array);
    const indices = new Uint32Array(m.index.array);
    return { name: m.name, analysis: analyseMesh(positions, indices, faceIdsFromBrep(indices.length / 3, m.brep_faces)) };
  });
  return { res, meshes, unit: detectUnit(bytes, format) };
}

const names = (node, out = []) => { if (node.name) out.push(node.name); node.children.forEach(c => names(c, out)); return out; };

test('block: size, volume, area, centroid, aluminium mass', () => {
  const { meshes, unit, res } = load('block_100x50x10.step');
  assert.equal(unit, 'mm');
  assert.ok(names(res.root).includes('Block 100x50x10'));
  const a = meshes[0].analysis;
  const size = [0, 1, 2].map(k => a.bboxMax[k] - a.bboxMin[k]);
  [100, 50, 10].forEach((v, k) => assert.ok(Math.abs(size[k] - v) < 0.1, `size ${k}`));
  assert.ok(a.closed);
  assert.ok(Math.abs(a.volume - 50000) / 50000 < 0.005, 'volume within 0.5 %');
  assert.ok(Math.abs(a.area - 13000) < 1);
  a.centroid.forEach((v, k) => assert.ok(Math.abs(v - [50, 25, 5][k]) < 0.01));
  const mass = a.volume * 1e-9 * 2700;
  assert.equal(mass.toFixed(3), '0.135');
  assert.equal(a.featureEdges.length / 12, 12, 'a box has 12 B-rep edges');
});

test('IGES block opens with the same volume', () => {
  const { meshes, unit } = load('block_100x50x10.igs');
  assert.equal(unit, 'mm');
  const s = sumProps(meshes.map(m => m.analysis));
  assert.ok(Math.abs(s.volume - 50000) / 50000 < 0.005);
});

test('assembly: product names and parts list grouping', () => {
  const { res, meshes } = load('grating_panel_assembly.step');
  const n = names(res.root);
  for (const want of ['Grating panel 1000x600', 'Bearing bar 30x3', 'Cross rod dia 6', 'Lifting lug', 'Frame angle L50x50x5 long']) assert.ok(n.includes(want), want);
  const groups = groupParts(res.meshes.map((m, i) => ({ id: i, name: m.name, analysis: meshes[i].analysis })));
  const count = Object.fromEntries(groups.map(g => [g.name, g.count]));
  assert.deepEqual(count, { 'Bearing bar 30x3': 12, 'Cross rod dia 6': 5, 'Lifting lug': 4, 'Frame angle L50x50x5 long': 2, 'Frame angle L50x50x5 short': 2 });
  const rod = groups.find(g => g.name === 'Cross rod dia 6');
  const exact = Math.PI * 9 * 890;
  assert.ok(Math.abs(rod.volume - exact) / exact < 0.005, 'curved solid volume within 0.5 %');
  const angle = groups.find(g => g.name === 'Frame angle L50x50x5 long');
  assert.ok(Math.abs(angle.size[0] - 1000) < 0.1 && Math.abs(angle.size[1] - 50) < 0.1);
});

test('hidden-line projection of the block (synthetic depth image)', () => {
  const { meshes } = load('block_100x50x10.step');
  const a = meshes[0].analysis;
  // front view: looking along +Y; the block's front face (y=0) is nearest
  const f = viewFrame([0, 1, 0], [0, 0, 1]);
  const segs = collectEdges([a], f);
  // depth image: front face at depth 0 everywhere inside the silhouette
  const w = 200, h = 40, px = 0.6, x0 = -10, y0 = -2;
  const data = new Float32Array(w * h).fill(2);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + (i + 0.5) * px, y = y0 + (j + 0.5) * px;
    if (x >= -px && x <= 100 + px && y >= -px && y <= 10 + px) data[j * w + i] = 0;
  }
  const cls = classify(segs, f, { w, h, x0, y0, px, zNear: 0, zFar: 50, data });
  const { visible, hidden } = cleanup(cls.visible, cls.hidden, 100);
  assert.equal(hidden.length, 0, 'back edges coincide with the visible outline');
  const loops = chain(visible, 1e-3);
  assert.equal(loops.length, 1);
  assert.ok(loops[0].closed && loops[0].pts.length === 4, 'outline is one closed rectangle');
});

test('isometric corners: 8 distinct diagonals, nearest-corner match', async () => {
  const { CORNERS, cornerByKey, nearestCorner } = await import('../src/corners.js');
  assert.equal(CORNERS.length, 8);
  assert.equal(new Set(CORNERS.map(c => c.dir.join())).size, 8);
  assert.deepEqual(cornerByKey('tfr').dir, [-1, 1, -1], 'top front right looks down, back and left');
  assert.equal(nearestCorner([0.4, -0.6, 0.7]).key, 'bkl');
  assert.equal(cornerByKey('nonsense').key, 'tfr', 'unknown keys fall back to the default');
});

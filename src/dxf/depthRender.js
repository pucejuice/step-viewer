// Render an orthographic depth image of a set of geometries along a view frame.
// Depth is packed into RGBA8 so it reads back on every WebGL device.
import * as THREE from 'three';
import { maxFilter3 } from './projector.js';

const depthMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    precision highp float;
    void main() {
      float d = gl_FragCoord.z;
      vec3 enc = fract(d * vec3(1.0, 255.0, 65025.0));
      enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
      gl_FragColor = vec4(enc, 1.0);
    }`,
});

/**
 * geometries: THREE.BufferGeometry[] in model space.
 * frame: { r, u, d } from viewFrame(); b: projectedBounds() of the geometry.
 * Returns { w, h, x0, y0, px, zNear, zFar, data } with data max-filtered.
 */
export function renderDepth(renderer, geometries, frame, b, maxRes = 4096) {
  const gl = renderer.getContext();
  const cap = Math.min(maxRes, renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const spanX = Math.max(b.xmax - b.xmin, 1e-6), spanY = Math.max(b.ymax - b.ymin, 1e-6);
  const pad = Math.max(spanX, spanY) * 0.01;
  const px = (Math.max(spanX, spanY) + 2 * pad) / cap;
  const w = Math.min(cap, Math.ceil((spanX + 2 * pad) / px));
  const h = Math.min(cap, Math.ceil((spanY + 2 * pad) / px));
  const x0 = b.xmin - pad, y0 = b.ymin - pad;
  const depthSpan = Math.max(b.zmax - b.zmin, 1e-6);
  const zNear = b.zmin - depthSpan * 0.01, zFar = b.zmax + depthSpan * 0.01;

  const { r, u, d } = frame;
  const cam = new THREE.OrthographicCamera(0, w * px, h * px, 0, 1, 1 + (zFar - zNear));
  // camera origin at the (x0, y0) corner, one unit in front of zNear
  const o = new THREE.Vector3(
    r[0] * x0 + u[0] * y0 + d[0] * (zNear - 1),
    r[1] * x0 + u[1] * y0 + d[1] * (zNear - 1),
    r[2] * x0 + u[2] * y0 + d[2] * (zNear - 1));
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...r), new THREE.Vector3(...u), new THREE.Vector3(-d[0], -d[1], -d[2]));
  m.setPosition(o);
  cam.matrixAutoUpdate = false;
  cam.matrix.copy(m);
  cam.matrixWorld.copy(m);
  cam.matrixWorldInverse.copy(m).invert();

  const scene = new THREE.Scene();
  for (const g of geometries) {
    const mesh = new THREE.Mesh(g, depthMaterial);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevClip = renderer.localClippingEnabled;
  renderer.localClippingEnabled = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear(true, true, true);
  renderer.render(scene, cam);
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.localClippingEnabled = prevClip;
  rt.dispose();

  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    raw[i] = buf[4 * i] / 255 + buf[4 * i + 1] / 65025 + buf[4 * i + 2] / 16581375;
  }
  return { w, h, x0, y0, px, zNear, zFar, data: maxFilter3(raw, w, h) };
}

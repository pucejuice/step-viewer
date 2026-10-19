# STEP Viewer

A static web app for checking fabricators' STEP and IGES models in the browser, on a desktop or a phone. Open a file, click a part, and read its name, size, volume and mass. You can also export orthographic and isometric views to DXF.

**Models are not stored.** *Upload model* opens a file from your device in this browser tab only. It is read locally in WebAssembly, never sent to or saved on a server, and is gone when the tab is closed or refreshed. There is no upload, no server, no analytics and no CDN. The built page has a Content Security Policy (`default-src 'self'`), so the browser itself blocks requests to any other origin.

## Features

- **Upload model:** `.stp .step .igs .iges` from the **Upload model** button or by drag and drop; the model is opened in the browser and not stored. You can open several files into one scene. Shows progress, and names the file in any error. Shows the file's declared unit; all values are in mm.
- **Model tree:** the STEP product names (falling back to `Part 1`, `Part 2`…). Each node has visibility, isolate, a colour swatch and a filter box. Tree and 3D selection stay in sync.
  - members whose names start with the same 3+ characters are folded into one group row (e.g. 12 × *Bearing bar 30x3*) with its own visibility, colour and isolate; this can be turned off;
  - Ctrl/⌘-click adds or removes a row from the selection, Shift-click selects a range; the selection bar then offers Hide, Show, Isolate and **Group**, and a selected row's tick box switches the whole selection;
  - **Group** (or `G`) saves the selection as a named group at the top of the tree, with its own visibility, colour and isolate; groups can be renamed (double-click) or removed, and last for the session.
- **Properties** (for one part, an assembly node, or a multi-selection):
  - path and bounding box (size and min/max corners);
  - volume (mm³ and m³), surface area and centroid, labelled *from mesh, approx.*, with a warning when the mesh is not closed;
  - mass for aluminium 2700, steel 7850, stainless 8000 or a custom density;
  - triangle count;
  - copy to clipboard.
- **Multi-select:** Ctrl/Shift-click, or long press on touch.
- **Parts list:** groups identical parts (same name, or same bounding box and volume within 0.5 %), with quantity, size, volume and mass each and in total. A tick box per group turns that whole group on or off (for example, hide every bolt). CSV export.
- **Turning parts on and off:** tree tick boxes, parts-list tick boxes, Hide / Isolate / Show all, and the `H`, `I` and `A` keys. Hidden parts are left out of the DXF.
- **Viewing:**
  - standard views, fit all, fit selection, and a **view cube** in the corner of the 3D view: click any face, edge or corner to swing the camera there;
  - perspective/orthographic;
  - feature edges (true B-rep edges, not angle-guessed);
  - transparency of unselected parts, and ghosting when isolating;
  - section plane on X/Y/Z with slider, flip and caps;
  - dark background by default, with a light option (remembered on that device).
- **Measuring:**
  - point-to-point distance snapping to mesh vertices, showing dX, dY, dZ and the true distance;
  - angle between two picked faces;
  - measurements stay listed in the scene until cleared.
- **Output:** PNG screenshot (includes measurement labels).
- **DXF drawing export:**
  - front, top, right, left, bottom and back views in a first- or third-angle layout, plus an isometric view and the current camera view;
  - hidden lines dashed on their own layer, set at the top of the DXF tab: *Auto* (on for up to 40 parts), *On* or *Off*;
  - overall dimensions, 1:1 in mm, AutoCAD R2000;
  - DXF settings (hidden lines, views, projection, dimensions…) are remembered on the device, with a reset button;
  - the isometric can be drawn from any of the **8 corners** (top/bottom, front/back, left/right), picked from a grid of cube icons or matched to the 3D view;
  - draw everything that is switched on, or just the selection: **DXF of selection** in the Properties tab draws a single member;
  - see [DXF export](#dxf-export) for how it works.
- **Phone:** touch orbit, pinch zoom and two-finger pan. The tree and the tools panel become drawers, and a chip at the bottom summarises the selection.

Keyboard: `F` fit all, `S` fit selection, `O` ortho, `E` edges, `M` measure, `H` hide selection, `I` isolate selection, `A` show all, `G` group selection, `Esc` clear.

## Run locally

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # Node acceptance tests on the samples
npm run build      # static site in dist/
npm run preview    # serve dist/ at http://localhost:4173
```

Requires Node 20 or later.

## Deploy

`.github/workflows/pages.yml` runs the tests, builds and deploys `dist/` to GitHub Pages on every push to `main`. One-time setup: in the repository go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The site is then served at `https://<owner>.github.io/step-viewer/`. The build uses relative paths, so any sub-path works.

## Libraries (exact versions)

| Library | Version | Licence | Use |
|---|---|---|---|
| [occt-import-js](https://github.com/kovacsv/occt-import-js) | 0.0.23 | LGPL-2.1 (Open CASCADE: LGPL-2.1 with exception) | STEP/IGES reading and meshing, WebAssembly, in a Web Worker |
| [three.js](https://threejs.org) | 0.185.1 | MIT | rendering, OrbitControls, raycasting, clipping, stencil caps |
| [Vite](https://vite.dev) | 8.3.1 (build only) | MIT | bundling |
| [sdxf.js](https://github.com/pucejuice/sdxfjs) | vendored, see `src/vendor/sdxf.js` header | – | DXF writer |

All versions are pinned exactly in `package.json`, and `package-lock.json` is committed. occt-import-js is loaded as a separate, unmodified `.wasm` and JS file, so it can be replaced as the LGPL requires.

## Choice under "Reference"

**I wrote a lean viewer from scratch on occt-import-js and three.js, and did not build on the Online3DViewer engine.** I read Online3DViewer for its approach (it uses the same parser in a worker). Its engine is a general multi-format importer with its own model, material and navigation layers. This brief needs specific engineering behaviour instead:

- mass properties from welded meshes, and an honest closed-mesh check;
- B-rep face boundaries as the displayed edges;
- grouping for parts lists;
- section caps;
- a DXF projection pipeline.

All of these need direct access to the raw meshes and `brep_faces`. A small codebase (about 2 000 lines) that an engineer can audit for "nothing leaves the browser" was also a goal. Adapting the engine would have meant carrying and overriding much more code than this.

## How the numbers are computed

- occt-import-js meshes each B-rep face and converts the geometry to mm. Coincident vertices are welded so that the topology is known.
- **Closed:** every welded edge is shared by exactly two triangles. Otherwise the panel shows a warning.
- **Volume:** divergence theorem (a sum of signed tetrahedra). **Centroid:** the volume-weighted tetrahedron centroids. **Area:** the sum of triangle areas. All are computed in double precision about the box centre.
- **Accuracy:** flat solids are exact. Curved faces are faceted, so cylinders read slightly low: about 0.1 % at *Normal* meshing (the Ø6 rod sample is within 0.1 %). For the most accurate volumes, choose *Fine* under View → Meshing before opening a file.
- **Feature edges:** edges between different B-rep faces, plus open edges, so you see the model's real edges.
- **Grouping:** first by name, then by sorted bounding-box extents and volume within ±0.5 %. Sorting the extents means a part turned 90° still matches.

## DXF export

The DXF tab produces an R2000 drawing in model space at 1:1. `$INSUNITS` is set to mm.

**Layers:**

- `VISIBLE`;
- `HIDDEN`, with a dashed `HIDDEN` linetype;
- `DIMS`: exploded overall dimensions;
- `TEXT`: view labels and a title.

**How the line work is made:**

1. **Edges.** For each view the app takes the B-rep edges, plus silhouette edges for that view. Silhouettes are the edges inside one curved face where the surface turns from facing the viewer to facing away, so cylinders get their outlines. Tangent edges (fillet boundaries) are left out unless you tick *Tangent edges*.
2. **Hidden-line removal.** The GPU renders an orthographic depth image of the parts at 2048 or 4096 px. Each edge is sampled about every 0.7 px and split into visible and hidden runs: a point is hidden when everything around it is nearer to the viewer. Only the visible/hidden split depends on pixel resolution. Coordinates come straight from the mesh vertices.
3. **Clean-up and output.** Collinear pieces are merged, and hidden lines lying under visible lines are removed. The rest is chained into `LWPOLYLINE`s. Curves therefore arrive as polylines at mesh resolution.
4. **Layout.** Views are laid out aligned to the front view, in first-angle (ISO E) or third-angle (ISO A / ANSI) projection. The isometric view is a true orthographic projection along (1, −1, 1). By default it is scaled ×1.225 so that lengths along the axes are true, as in an isometric drawing.

**Limits:**

- A visible/hidden transition can be off by about one pixel of the depth image. That is about 0.7 mm on a 3 m panel at 4096 px.
- Section views and detail dimensions are not produced.
- This is a fast general-arrangement or checking drawing, not a replacement for a CAD drawing.

The DXF writer is [`pucejuice/sdxfjs`](https://github.com/pucejuice/sdxfjs), copied into `src/vendor/sdxf.js` by `node scripts/sync-sdxf.mjs ../sdxfjs/sdxf.js`. Do not edit the vendored copy: change sdxfjs and run the sync again. For this integration, sdxfjs gained:

- dashed linetype elements;
- a correct `$HANDSEED` for large drawings;
- `$INSUNITS` and `$LTSCALE`;
- entity linetype scale;
- a CommonJS export.

All of these are backwards compatible. Exported files pass `ezdxf.readfile` and `doc.audit()` with no errors.

## Samples and tests

`samples/` holds open (CC0) models generated by `samples/generate_samples.py`; see `samples/README.md`. The app's start screen can open them. **Never commit a client model.**

`npm test` parses the samples with the same parser and checks:

- the block's size, volume (within 0.5 % of 50 000 mm³) and aluminium mass (0.135 kg);
- the IGES block;
- the assembly's product names and parts-list counts;
- a hidden-line projection.

Also checked in headless Chromium:

- a 100.0 mm point-to-point measurement along the block's long edge;
- the section plane on each axis, with flip;
- the 390 px phone layout;
- that the only network requests are to the app's own files;
- the 4.5 MB sample opens in about 11 s with software rendering, and picking takes about 3 ms.

## Icons and start-screen art

The start screen's header band and the app icons use the slate facet pattern shared with the sla and ins apps. The facet geometry is in `src/brand/mesh.json`. `python scripts/build_icons.py` (needs Pillow) redraws the icons into `public/icons/`: the pattern with a white isometric-cube glyph, including a maskable icon for Android home screens. `public/manifest.webmanifest` lets phones add the app to the home screen.

## Project layout

```
index.html               UI markup
src/main.js              app wiring: loading, tree, properties, parts list, export
src/worker.js            occt-import-js parse + mesh analysis (Web Worker)
src/meshAnalysis.js      weld, closed check, volume/area/centroid, edges
src/viewer.js            three.js scene, cameras, picking, section + caps
src/measure.js           distance and angle measurements
src/partsList.js         grouping and CSV
src/units.js             STEP/IGES declared unit
src/dxf/                 projection, hidden lines, DXF/SVG output
src/vendor/sdxf.js       vendored sdxf.js (generated)
src/brand/mesh.json      facet pattern for the start screen and icons
public/icons/            app icons (scripts/build_icons.py)
samples/                 open sample models
test/                    Node tests
```

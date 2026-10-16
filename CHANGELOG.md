# Changelog

## Unreleased

- Dark mode by default; choosing Light is remembered on that device.
- Parts list: a tick box per group turns all of those parts on or off.
- **DXF of selection** button draws a single member. DXF files for one part are named after it.
- Hidden lines in the DXF default to *Auto*: on for up to 40 parts, off for big assemblies, where they made 30+ MB files.
- Bodies without a name are listed as "Unnamed solid in <assembly>" in the parts list.
- Keys `H` hide, `I` isolate, `A` show all.
- The DXF preview is drawn as an image, so large drawings preview quickly.
- Start-screen header band and app icons in the facet pattern shared with the sla and ins apps; web app manifest for adding to a phone home screen.

## v1.0.0 — 2026-10-16

First release.

- Open STEP (`.stp`, `.step`) and IGES (`.igs`, `.iges`) files by picker or drag and drop, several at once, parsed in a Web Worker with occt-import-js. Files never leave the browser; the built page carries a Content Security Policy that only allows its own files.
- Shows the length unit declared in each file; everything is displayed in mm.
- Model tree from the STEP product structure with visibility, isolate, colour and filter; selection synced both ways between tree and 3D view.
- Properties of the selection: name, path, bounding box size and corners, volume (mm³, m³), surface area, centroid, triangle count, mass for aluminium / steel / stainless / custom density, with an open-mesh warning. Multi-select with Ctrl/Shift-click or long press; copy to clipboard.
- Parts list grouping identical parts (same name, or same bounding box and volume within 0.5 %), CSV export.
- Standard views, fit all / selection, perspective / orthographic, feature edges (true B-rep edges), transparency, ghosting, section plane on X/Y/Z with flip and caps, dark mode by default with a light option.
- Point-to-point distance with vertex snapping (dX, dY, dZ), angle between faces; measurements listed and kept until cleared; PNG screenshot including labels.
- DXF export (R2000, mm, 1:1) of front / top / side / back / bottom views in first- or third-angle layout, an isometric view and the current camera view, with hidden lines, optional tangent edges and overall dimensions. Written with sdxf.js (vendored from pucejuice/sdxfjs).
- Phone layout with drawers and a selection chip.
- Open-licensed samples, Node acceptance tests, GitHub Actions deploy to Pages.

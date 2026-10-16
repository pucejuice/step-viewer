// Vendor sdxf.js from the pucejuice/sdxfjs repository as an ES module.
// Usage: node scripts/sync-sdxf.mjs [path/to/sdxfjs/sdxf.js]
// The source is kept byte-for-byte; only the CommonJS footer is swapped for an
// ES export so Vite can bundle it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const src = process.argv[2] || '../sdxfjs/sdxf.js';
const text = readFileSync(src, 'utf8');
const marker = '// ── Module export (CommonJS / Node).';
const cut = text.indexOf(marker);
if (cut < 0) throw new Error('CommonJS footer not found in ' + src);
const body = text.slice(0, cut).trimEnd();
const sha = createHash('sha256').update(text).digest('hex').slice(0, 12);
const out = `// Vendored from github.com/pucejuice/sdxfjs (sdxf.js, sha256 ${sha}).
// Do not edit here: change sdxfjs and re-run  node scripts/sync-sdxf.mjs
${body}

export { Drawing, Layer, LineType, Style, Block, Line, LwPolyLine, Circle, Arc, Point, Text, Solid, Collection, Entity, calculate_end_point };
`;
writeFileSync(new URL('../src/vendor/sdxf.js', import.meta.url), out);
console.log('wrote src/vendor/sdxf.js from', src, sha);

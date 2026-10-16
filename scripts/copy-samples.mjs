// Copy the open sample models into public/samples so the app can offer them.
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
const src = new URL('../samples/', import.meta.url);
const dst = new URL('../public/samples/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) if (/\.(step|stp|igs|iges)$/i.test(f)) copyFileSync(new URL(f, src), new URL(f, dst));

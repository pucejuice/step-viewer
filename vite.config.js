import { defineConfig } from 'vite';

// Content Security Policy for the built app: the page may only load its own
// files. No upload, analytics or CDN is possible even by mistake. (Dev server
// is left without it because Vite's hot reload needs inline scripts.)
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const csp = {
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="utf-8">',
    `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
};

// base './' so the build works from any GitHub Pages sub-path
export default defineConfig({
  base: './',
  plugins: [csp],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});

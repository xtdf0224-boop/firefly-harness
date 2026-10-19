import { defineConfig, type Plugin } from 'vite';

/* The packaged app loads from file:// with a desktop bridge in the page: lock what the page may load.
   Model calls never go out from the page (the desktop process makes them), so connect-src stays 'self'.
   Build only — the dev server needs its own client script and HMR socket. */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const csp: Plugin = {
  name: 'firefly-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

// Same setup as AIROOM: Vite's built-in TSX transform, relative base so dist/ opens from any folder.
export default defineConfig({
  base: './',
  plugins: [csp],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023' },
});

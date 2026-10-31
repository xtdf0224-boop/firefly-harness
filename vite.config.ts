import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/* The packaged app loads from file:// with a desktop bridge in the page: lock what the page may load.
   Model calls never go out from the page (the desktop process makes them), so connect-src stays 'self'.
   worker-src: the pet window and capture page may start workers (blob: for inline ones).
   Build only — the dev server needs its own client script and HMR socket. Applies to every page. */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const csp: Plugin = {
  name: 'firefly-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// Same setup as AIROOM: Vite's built-in TSX transform, relative base so dist/ opens from any folder.
// Three pages: the app, the desktop pet window (pet.html) and the hidden capture page (capture.html).
export default defineConfig({
  base: './',
  plugins: [csp],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    rolldownOptions: {
      input: { main: page('index.html'), pet: page('pet.html'), capture: page('capture.html') },
    },
  },
});

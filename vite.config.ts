import { defineConfig } from 'vite';

// Same setup as AIROOM: Vite's built-in TSX transform, relative base so dist/ opens from any folder.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023' },
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root: path.join(repoRoot, 'web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    // The client imports the shared protocol and core from ../src, which pull
    // in Yjs themselves. Two copies of Yjs in one bundle break its constructor
    // checks, so force exactly one.
    dedupe: ['yjs', '@codemirror/state', '@codemirror/view'],
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    // In development the page is served by Vite and the gateway runs on 8080.
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/healthz': 'http://localhost:8080' },
  },
});

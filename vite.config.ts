import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA lives in web/ and builds into dist/, which the Worker serves as static assets.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 800 },   // the home hall's three.js chunk is ~720 KB (190 KB gzipped), loaded on demand
  server: { proxy: { '/api': 'http://localhost:8787', '/mcp': 'http://localhost:8787' } },
});

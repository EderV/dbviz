import react from '@vitejs/plugin-react';
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // libpg-query's emscripten loader is CommonJS, so it must be pre-bundled in
  // dev. The .wasm URL it computes is redirected by the worker (see
  // src/workers/pipeline.worker.ts), so its location doesn't matter.
  optimizeDeps: { include: ['libpg-query', 'elkjs/lib/elk.bundled.js'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
});

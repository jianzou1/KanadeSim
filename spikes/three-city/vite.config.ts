import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    open: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

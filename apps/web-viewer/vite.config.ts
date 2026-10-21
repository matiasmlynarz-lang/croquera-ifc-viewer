import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@croquera/ifc-core': path.resolve(__dirname, '../../packages/ifc-core/src'),
      '@croquera/ifc-viewer': path.resolve(__dirname, '../../packages/ifc-viewer/src'),
    },
  },
  server: {
    port: 3001,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});

// The package: src/index.ts as an ES module, with no game data and no page.

import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    lib: { entry: join(import.meta.dirname, 'src/index.ts'), formats: ['es'], fileName: 'index' },
  },
});

// The package: src/index.ts as an ES module, with no game data and no page.
// `--mode min` adds dist/mugen.min.js, a single file to copy next to a page.

import { join } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const min = mode === 'min';
  return {
    publicDir: false,
    build: {
      outDir: 'dist',
      emptyOutDir: !min,
      minify: min,
      sourcemap: !min,
      target: 'es2022',
      // Vite only strips whitespace from a library; this also shortens names.
      rollupOptions: min ? { output: { minify: true } } : {},
      lib: { entry: join(import.meta.dirname, 'src/index.ts'), formats: ['es'], fileName: () => (min ? 'mugen.min.js' : 'index.js') },
    },
  };
});

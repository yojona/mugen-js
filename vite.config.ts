import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 8110, fs: { allow: ['.'] } },
  test: { include: ['tests/**/*.test.ts'] },
});

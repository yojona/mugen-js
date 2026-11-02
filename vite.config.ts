import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const REF = join(__dirname, 'ref', 'mugen-1.1b1');

/** Dev-only: expose a listing of the reference MUGEN tree for the VFS. */
function refListing(): Plugin {
  const walk = (dir: string, out: string[]) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(relative(REF, p).split('\\').join('/'));
    }
    return out;
  };
  return {
    name: 'ref-listing',
    configureServer(server) {
      server.middlewares.use('/__ref.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(walk(REF, [])));
      });
    },
  };
}

export default defineConfig({
  plugins: [refListing()],
  server: { port: 8120, fs: { allow: ['.'] } },
  test: { include: ['tests/**/*.test.ts'] },
});

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const REF = join(import.meta.dirname, 'ref', 'mugen-1.1b1');
const PAGES = join(import.meta.dirname, 'tools', 'pages');

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
      // The development pages (tools/pages): not part of the example site.
      server.middlewares.use(async (req, res, next) => {
        const name = /^\/(harness|viewer|training|frame)\.html(\?|$)/.exec(req.url ?? '')?.[1];
        if (!name) return next();
        const source = readFileSync(join(PAGES, `${name}.html`), 'utf8').replace(/src="\.\//g, `src="/@fs${PAGES}/`);
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url!, source));
      });
      server.middlewares.use('/__ref.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(walk(REF, [])));
      });
      // Vite's static server answers names with % escapes (k#-kofa, spaces)
      // with index.html: the tree is served here, ranges included.
      server.middlewares.use('/ref/mugen-1.1b1', (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
        const file = join(REF, path);
        if (!file.startsWith(`${REF}/`) || !existsSync(file) || !statSync(file).isFile()) return next();
        const size = statSync(file).size;
        res.setHeader('accept-ranges', 'bytes');
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        if (!m) {
          res.setHeader('content-length', size);
          createReadStream(file).pipe(res);
          return;
        }
        const start = Number(m[1]);
        const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
        res.statusCode = 206;
        res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
        res.setHeader('content-length', end - start + 1);
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [refListing()],
  // The examples are the dev site; the package itself is src/ (vite.lib.config.ts).
  root: 'examples',
  build: {
    outDir: '../dist-examples',
    emptyOutDir: true,
    rollupOptions: { input: join(import.meta.dirname, 'examples/index.html') },
  },
  server: { port: 8120, fs: { allow: ['..'] } },
  test: { root: import.meta.dirname, include: ['tests/**/*.test.ts'] },
});

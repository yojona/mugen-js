// FileSource backed by the local file system (tests, tools, harness).

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FileSource } from './vfs';

export function nodeSource(root: string): FileSource {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(root);
  return {
    list: () => files,
    read: async (p) => new Uint8Array(readFileSync(join(root, p))),
    readRange: async (p, start, end) => {
      const fd = openSync(join(root, p), 'r');
      try {
        const buf = new Uint8Array(Math.max(0, end - start));
        const n = readSync(fd, buf, 0, buf.length, start);
        return buf.subarray(0, n);
      } finally {
        closeSync(fd);
      }
    },
  };
}

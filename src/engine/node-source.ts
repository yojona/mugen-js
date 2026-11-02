// FileSource backed by the local file system (tests, tools, harness).

import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  };
}

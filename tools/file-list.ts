// The file list httpSource asks for: every path of a MUGEN tree as a JSON array.
//   npx tsx tools/file-list.ts <mugen root> > files.json

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: file-list <mugen root>');
  process.exit(1);
}
const files = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort();
console.log(JSON.stringify(files));

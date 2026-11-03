// Virtual file system with MUGEN's (Windows) path semantics:
// case-insensitive, '\' or '/' separators, relative to a base directory with
// fallbacks (e.g. a character's stcommon resolves from its folder, then data/).

export interface FileSource {
  /** All file paths, '/'-separated, relative to the MUGEN root. */
  list(): string[];
  read(path: string): Promise<Uint8Array>;
  /**
   * Bytes [start, end) of a file (fewer at its end). Sources without it fall
   * back to reading the whole file.
   */
  readRange?(path: string, start: number, end: number): Promise<Uint8Array>;
}

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

export function dirname(path: string): string {
  const n = normalize(path);
  const i = n.lastIndexOf('/');
  return i < 0 ? '' : n.slice(0, i);
}

export class Vfs {
  private index = new Map<string, string>();

  constructor(private src: FileSource) {
    for (const p of src.list()) this.index.set(normalize(p).toLowerCase(), p);
  }

  /** Resolve `file` against each base dir in order; returns the real path. */
  resolve(file: string, ...bases: string[]): string | undefined {
    const f = file.trim().replace(/^"|"$/g, '');
    for (const b of [...bases, '']) {
      const hit = this.index.get(normalize(b ? `${b}/${f}` : f).toLowerCase());
      if (hit) return hit;
    }
    return undefined;
  }

  async read(file: string, ...bases: string[]): Promise<Uint8Array> {
    const p = this.resolve(file, ...bases);
    if (!p) throw new Error(`Archivo no encontrado: ${file} (en ${bases.join(', ') || '/'})`);
    return this.src.read(p);
  }

  /** Bytes [start, end) of a file: what a portrait-only SFF read needs. */
  async readRange(file: string, start: number, end: number, ...bases: string[]): Promise<Uint8Array> {
    const p = this.resolve(file, ...bases);
    if (!p) throw new Error(`Archivo no encontrado: ${file} (en ${bases.join(', ') || '/'})`);
    if (this.src.readRange) return this.src.readRange(p, start, end);
    return (await this.src.read(p)).slice(start, end);
  }

  async text(file: string, ...bases: string[]): Promise<string> {
    // MUGEN text files are ANSI (Windows-1252 / Shift-JIS); latin1 keeps bytes intact.
    return new TextDecoder('latin1').decode(await this.read(file, ...bases));
  }
}

/** Files served over HTTP under `baseUrl`, with a JSON listing at `listUrl`. */
export async function httpSource(baseUrl: string, listUrl: string): Promise<FileSource> {
  const files: string[] = await (await fetch(listUrl)).json();
  const url = (p: string) => `${baseUrl}/${p.split('/').map(encodeURIComponent).join('/')}`;
  return {
    list: () => files,
    read: async (p) => {
      const r = await fetch(url(p));
      if (!r.ok) throw new Error(`HTTP ${r.status} al leer ${p}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    readRange: async (p, start, end) => {
      if (end <= start) return new Uint8Array(0);
      const r = await fetch(url(p), { headers: { Range: `bytes=${start}-${end - 1}` } });
      // 416: the range starts past the end of the file.
      if (r.status === 416) return new Uint8Array(0);
      if (!r.ok) throw new Error(`HTTP ${r.status} al leer ${p}`);
      const b = new Uint8Array(await r.arrayBuffer());
      // A server without range support sends the whole file (200).
      return r.status === 206 ? b : b.slice(start, end);
    },
  };
}

// Shared helpers for MUGEN's INI-like text formats (.def, .cns, .cmd, .air, .st).
//
// Rules (matching MUGEN 1.1):
//  - ';' starts a comment anywhere on the line, except inside double quotes.
//  - Section headers are `[Name]`; names keep their original text (trimmed).
//  - Keys are case-insensitive and may repeat; order is preserved.
//  - Sections may repeat (CNS has one [State x, y] per controller).

export interface Entry {
  key: string; // lowercased
  value: string; // raw, trimmed
  line: number; // 1-based source line
}

export interface Section {
  name: string; // original text between brackets, trimmed
  line: number;
  entries: Entry[];
  /** Lines inside the section that were not `key = value` (e.g. AIR elements). */
  raw: { text: string; line: number }[];
}

export interface IniDoc {
  /** Entries before the first section header. */
  preamble: Section;
  sections: Section[];
}

export function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ';' && !inQuote) return line.slice(0, i);
  }
  return line;
}

export function splitLines(text: string): string[] {
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split(/\r\n|\r|\n/);
}

const SECTION_RE = /^\[\s*([^\]]*?)\s*\]/;
const KV_RE = /^([^=]+?)\s*=\s*(.*)$/;

export function parseIni(text: string): IniDoc {
  const preamble: Section = { name: '', line: 0, entries: [], raw: [] };
  const sections: Section[] = [];
  let cur = preamble;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!).trim();
    if (!line) continue;
    const sm = SECTION_RE.exec(line);
    if (sm) {
      cur = { name: sm[1]!, line: i + 1, entries: [], raw: [] };
      sections.push(cur);
      continue;
    }
    const kv = KV_RE.exec(line);
    if (kv) {
      cur.entries.push({ key: kv[1]!.trim().toLowerCase(), value: kv[2]!.trim(), line: i + 1 });
    } else {
      cur.raw.push({ text: line, line: i + 1 });
    }
  }
  return { preamble, sections };
}

/** Case-insensitive lookup of the first section with the given name. */
export function findSection(doc: IniDoc, name: string): Section | undefined {
  const n = name.toLowerCase();
  return doc.sections.find((s) => s.name.toLowerCase() === n);
}

/** First value for a key (MUGEN uses the first occurrence for most params). */
export function getValue(sec: Section | undefined, key: string): string | undefined {
  if (!sec) return undefined;
  const k = key.toLowerCase();
  return sec.entries.find((e) => e.key === k)?.value;
}

export function unquote(v: string): string {
  const m = /^"(.*)"$/.exec(v.trim());
  return m ? m[1]! : v.trim();
}

/** Split a comma-separated value list, trimming each part. Empty parts stay ''. */
export function splitCsv(v: string): string[] {
  return v.split(',').map((s) => s.trim());
}

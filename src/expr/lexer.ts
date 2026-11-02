// Tokenizer for MUGEN expressions (docs: cns.html "Expressions", trigger.html).

export type TokType = 'num' | 'ident' | 'str' | 'op' | 'eof';

export interface Token {
  type: TokType;
  /** Source text; for identifiers this is lowercased. */
  text: string;
  /** Original text for identifiers/strings (strings without quotes). */
  raw: string;
  /** For numbers: true if a decimal point was present (float literal). */
  isFloat?: boolean;
  pos: number;
}

export class ExprError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly pos: number,
  ) {
    super(`${message} (en "${source}", posición ${pos + 1})`);
    this.name = 'ExprError';
  }
}

// Longest operators first.
const OPS = [':=', '**', '!=', '<=', '>=', '&&', '||', '^^', '=', '<', '>', '+', '-', '*', '/', '%', '!', '~', '&', '|', '^', '(', ')', '[', ']', ','];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9.]/.test(c) && /[0-9]/.test(c === '.' ? (src[i + 1] ?? '') : c)) {
      let isFloat = false;
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      if (src[i] === '.') {
        isFloat = true;
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      const text = src.slice(start, i);
      out.push({ type: 'num', text, raw: text, isFloat, pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      // Dots are allowed inside names: const(velocity.walk.fwd.x), stagevar(info.name)
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i]!)) i++;
      const raw = src.slice(start, i);
      out.push({ type: 'ident', text: raw.toLowerCase(), raw, pos: start });
      continue;
    }
    if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new ExprError('Comillas sin cerrar', src, i);
      const raw = src.slice(i + 1, end);
      out.push({ type: 'str', text: raw, raw, pos: start });
      i = end + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Carácter inesperado "${c}"`, src, i);
    out.push({ type: 'op', text: op, raw: op, pos: start });
    i += op.length;
  }
  out.push({ type: 'eof', text: '', raw: '', pos: src.length });
  return out;
}

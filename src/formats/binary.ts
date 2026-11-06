/** Little-endian cursor over a byte buffer. All MUGEN binary formats are LE. */
export class Reader {
  readonly dv: DataView;
  pos = 0;

  constructor(
    readonly bytes: Uint8Array,
    pos = 0,
  ) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.byteLength;
  }
  u8(): number {
    return this.dv.getUint8(this.pos++);
  }
  u16(): number {
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  s16(): number {
    const v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  s32(): number {
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** Fixed-length string, cut at the first NUL. */
  str(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.bytes[this.pos + i]!;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    this.pos += len;
    return s;
  }
  skip(n: number): void {
    this.pos += n;
  }
  slice(start: number, end: number): Uint8Array {
    return this.bytes.subarray(start, Math.min(end, this.bytes.byteLength));
  }
}

export class FormatError extends Error {
  constructor(format: string, msg: string) {
    super(`${format}: ${msg}`);
    this.name = 'FormatError';
  }
}

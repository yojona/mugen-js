// WebGL2 sprite renderer that mirrors MUGEN 1.1's indexed-color pipeline
// (data/indexed.frag + data/rgba.frag): sprites stay as palette indices on the
// GPU and are colored at draw time, so palette swaps and PalFX are free.

import type { Sprite } from '../formats/sff';

export interface PalFx {
  /** Added to color (0..1 scale, MUGEN's add/256). */
  add: [number, number, number];
  /** Multiplies color (MUGEN's mul/256). */
  mul: [number, number, number];
  /** Saturation, 1 = unchanged (MUGEN's color/256). */
  color: number;
  invertAll: boolean;
}

export const NO_PALFX: PalFx = { add: [0, 0, 0], mul: [1, 1, 1], color: 1, invertAll: false };

export type DrawBlend = { kind: 'none' } | { kind: 'add'; src: number; dst: number } | { kind: 'sub' };

export interface DrawParams {
  sprite: Sprite;
  /** Palette as 256 RGBA colors; ignored for truecolor sprites. */
  palette?: Uint8Array;
  /** Screen position of the sprite axis, in game pixels. */
  x: number;
  y: number;
  /** Combined facing/flip and scale. Negative = mirrored. */
  scaleX: number;
  scaleY: number;
  /** Degrees, counter-clockwise as in MUGEN. */
  angle?: number;
  blend?: DrawBlend;
  palfx?: PalFx;
  /** Transparent index 0 is masked (sprites); false draws index 0 opaque. */
  mask?: boolean;
}

// Two modes: an affine sprite quad (uMatrix), or explicit corners for parallax
// trapezoids. Corner mode interpolates u with a per-row q so each scanline maps
// linearly across the sprite (MUGEN's PERSPECTIVE_EVEN in indexed.frag).
const VS = `#version 300 es
in vec2 aPos;
uniform mat3 uMatrix;
uniform vec2 uSize;
uniform bool uCornerMode;
uniform vec2 uCorners[4]; // clip space: top-left, top-right, bottom-left, bottom-right
uniform vec2 uQ;          // q for top and bottom rows
out vec3 vUvq;
void main() {
  if (uCornerMode) {
    vec2 top = mix(uCorners[0], uCorners[1], aPos.x);
    vec2 bot = mix(uCorners[2], uCorners[3], aPos.x);
    float q = mix(uQ.x, uQ.y, aPos.y);
    vUvq = vec3(aPos.x * q, aPos.y, q);
    gl_Position = vec4(mix(top, bot, aPos.y), 0.0, 1.0);
  } else {
    vUvq = vec3(aPos, 1.0);
    vec3 p = uMatrix * vec3(aPos * uSize, 1.0);
    gl_Position = vec4(p.xy, 0.0, 1.0);
  }
}`;

// Same color math as MUGEN's indexed.frag (non-premultiplied path).
const FS = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec3 vUvq;
uniform usampler2D uIndex;
uniform sampler2D uRgba;
uniform sampler2D uPalette;
uniform bool uIndexed;
uniform bool uMask;
uniform vec3 uAdd;
uniform vec3 uMul;
uniform float uColorBal;
uniform bool uInvertAll;
uniform float uSrcAlphaMul;
uniform bool uPremulOut;
out vec4 outColor;
void main() {
  vec2 vUv = vec2(vUvq.x / vUvq.z, vUvq.y);
  vec4 color;
  if (uIndexed) {
    uint idx = texture(uIndex, vUv).r;
    color = texelFetch(uPalette, ivec2(int(idx), 0), 0);
    if (!uMask) color.a = 1.0;
    else if (idx == 0u) color.a = 0.0;
  } else {
    color = texture(uRgba, vUv);
  }
  if (color.a == 0.0) discard;
  if (uColorBal != 1.0) {
    float grey = color.r * .3125 + color.g * .4375 + color.b * .25;
    color.rgb = mix(vec3(grey), color.rgb, uColorBal);
  }
  if (uInvertAll) color.rgb = 1.0 - color.rgb;
  color.rgb = clamp((color.rgb + uAdd) * uMul, 0.0, 1.0);
  color.a *= uSrcAlphaMul;
  if (uPremulOut) color.rgb *= color.a;
  outColor = color;
}`;

interface SpriteTex {
  tex: WebGLTexture;
  indexed: boolean;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private sprites = new WeakMap<Sprite, SpriteTex>();
  private palettes = new WeakMap<Uint8Array, WebGLTexture>();
  private dummyIndex: WebGLTexture;
  private dummyRgba: WebGLTexture;
  /** Game-space size (e.g. 320x240 for localcoord 320,240). */
  width = 320;
  height = 240;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 no disponible');
    this.gl = gl;
    this.prog = link(gl, VS, FS);
    gl.useProgram(this.prog);
    for (const n of ['uCornerMode', 'uCorners', 'uQ', 'uMatrix', 'uSize', 'uIndex', 'uRgba', 'uPalette', 'uIndexed', 'uMask', 'uAdd', 'uMul', 'uColorBal', 'uInvertAll', 'uSrcAlphaMul', 'uPremulOut']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    gl.uniform1i(this.u.uIndex!, 0);
    gl.uniform1i(this.u.uRgba!, 1);
    gl.uniform1i(this.u.uPalette!, 2);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.dummyIndex = this.texture(gl.R8UI, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.dummyRgba = this.texture(gl.RGBA8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  resize(width: number, height: number, zoom: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * zoom);
    this.canvas.height = Math.round(height * zoom);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Restrict drawing to a rectangle in game pixels (undefined = no clip). */
  setClip(rect: [number, number, number, number] | undefined): void {
    const gl = this.gl;
    if (!rect) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const kx = this.canvas.width / this.width;
    const ky = this.canvas.height / this.height;
    const x1 = Math.round(Math.min(rect[0], rect[2]) * kx);
    const x2 = Math.round(Math.max(rect[0], rect[2]) * kx);
    const y1 = Math.round(Math.min(rect[1], rect[3]) * ky);
    const y2 = Math.round(Math.max(rect[1], rect[3]) * ky);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x1, this.canvas.height - y2, Math.max(0, x2 - x1), Math.max(0, y2 - y1));
  }

  clear(r: number, g: number, b: number): void {
    const gl = this.gl;
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Draw a sprite stretched over an arbitrary quad (parallax floors). Corners
   * in game pixels: top-left, top-right, bottom-left, bottom-right.
   */
  drawQuad(p: Omit<DrawParams, 'x' | 'y' | 'scaleX' | 'scaleY' | 'angle'> & { corners: [number, number][] }): void {
    const kx = 2 / this.width;
    const ky = -2 / this.height;
    const c = p.corners.flatMap(([x, y]) => [x * kx - 1, y * ky + 1]);
    const topW = Math.abs(p.corners[1]![0] - p.corners[0]![0]);
    const botW = Math.abs(p.corners[3]![0] - p.corners[2]![0]);
    this.cornerMode = { corners: c, q: [Math.max(topW, 1e-3), Math.max(botW, 1e-3)] };
    try {
      this.draw({ ...p, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    } finally {
      this.cornerMode = undefined;
    }
  }
  private cornerMode: { corners: number[]; q: [number, number] } | undefined;

  draw(p: DrawParams): void {
    const gl = this.gl;
    const s = p.sprite;
    if (s.width === 0 || s.height === 0) return;
    gl.uniform1i(this.u.uCornerMode!, this.cornerMode ? 1 : 0);
    if (this.cornerMode) {
      gl.uniform2fv(this.u.uCorners!, this.cornerMode.corners);
      gl.uniform2f(this.u.uQ!, this.cornerMode.q[0], this.cornerMode.q[1]);
    }
    const st = this.spriteTexture(s);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.indexed ? st.tex : this.dummyIndex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, st.indexed ? this.dummyRgba : st.tex);
    if (st.indexed) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture(p.palette ?? GREY_PALETTE));
    }

    // Model: translate(x,y) * rotate(-angle) * scale(sx,sy) * translate(-axis)
    const a = ((p.angle ?? 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const sx = p.scaleX;
    const sy = p.scaleY;
    // Columns of the 2x2 part, then translation.
    const m00 = cos * sx;
    const m10 = -sin * sx;
    const m01 = sin * sy;
    const m11 = cos * sy;
    const tx = p.x - (m00 * s.axisX + m01 * s.axisY);
    const ty = p.y - (m10 * s.axisX + m11 * s.axisY);
    // Game space -> clip space.
    const kx = 2 / this.width;
    const ky = -2 / this.height;
    gl.uniformMatrix3fv(this.u.uMatrix!, false, [m00 * kx, m10 * ky, 0, m01 * kx, m11 * ky, 0, tx * kx - 1, ty * ky + 1, 1]);
    gl.uniform2f(this.u.uSize!, s.width, s.height);
    gl.uniform1i(this.u.uIndexed!, st.indexed ? 1 : 0);
    gl.uniform1i(this.u.uMask!, p.mask === false ? 0 : 1);
    const fx = p.palfx ?? NO_PALFX;
    gl.uniform3fv(this.u.uAdd!, fx.add);
    gl.uniform3fv(this.u.uMul!, fx.mul);
    gl.uniform1f(this.u.uColorBal!, fx.color);
    gl.uniform1i(this.u.uInvertAll!, fx.invertAll ? 1 : 0);

    const blend = p.blend ?? { kind: 'none' };
    gl.enable(gl.BLEND);
    if (blend.kind === 'add') {
      // out = src * S/256 + dst * D/256
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendColor(0, 0, 0, Math.min(blend.dst, 256) / 256);
      gl.blendFunc(gl.ONE, gl.CONSTANT_ALPHA);
      gl.uniform1f(this.u.uSrcAlphaMul!, Math.min(blend.src, 256) / 256);
      gl.uniform1i(this.u.uPremulOut!, 1);
    } else if (blend.kind === 'sub') {
      // out = dst - src
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(this.u.uSrcAlphaMul!, 1);
      gl.uniform1i(this.u.uPremulOut!, 1);
    } else {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(this.u.uSrcAlphaMul!, 1);
      gl.uniform1i(this.u.uPremulOut!, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draw an untextured rectangle outline or fill (debug: collision boxes). */
  rect(x1: number, y1: number, x2: number, y2: number, rgba: [number, number, number, number]): void {
    const pal = solidPalette(rgba);
    this.draw({ sprite: SOLID_SPRITE, palette: pal, x: Math.min(x1, x2), y: Math.min(y1, y2), scaleX: Math.abs(x2 - x1), scaleY: Math.abs(y2 - y1) });
  }

  private spriteTexture(s: Sprite): SpriteTex {
    let t = this.sprites.get(s);
    if (t) return t;
    const gl = this.gl;
    t = s.rgba
      ? { tex: this.texture(gl.RGBA8, s.width, s.height, gl.RGBA, gl.UNSIGNED_BYTE, s.rgba), indexed: false }
      : { tex: this.texture(gl.R8UI, s.width, s.height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, s.indices!), indexed: true };
    this.sprites.set(s, t);
    return t;
  }

  private paletteTexture(pal: Uint8Array): WebGLTexture {
    let t = this.palettes.get(pal);
    if (!t) {
      t = this.texture(this.gl.RGBA8, 256, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pal);
      this.palettes.set(pal, t);
    }
    return t;
  }

  /** Drop a cached palette texture after mutating its bytes (palette swaps). */
  invalidatePalette(pal: Uint8Array): void {
    const t = this.palettes.get(pal);
    if (t) this.gl.deleteTexture(t);
    this.palettes.delete(pal);
  }

  private texture(internal: number, w: number, h: number, format: number, type: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
}

const GREY_PALETTE = (() => {
  const p = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) p.set([i, i, i, i ? 255 : 0], i * 4);
  return p;
})();

const SOLID_SPRITE: Sprite = { group: -1, number: -1, width: 1, height: 1, axisX: 0, axisY: 0, palette: 0, indices: new Uint8Array([1]) };
const solidCache = new Map<string, Uint8Array>();
function solidPalette(c: [number, number, number, number]): Uint8Array {
  const k = c.join(',');
  let p = solidCache.get(k);
  if (!p) {
    p = new Uint8Array(1024);
    p.set(c, 4);
    solidCache.set(k, p);
  }
  return p;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

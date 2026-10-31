/* The puppet's WebGL2 renderer: one picture per pose, bent in the fragment shader (no cut-out layers, so no
   seams). Each output pixel looks up where its colour comes from: the head is turned back around the neck,
   everything above the hips is lowered by the breath, hair and accents are shifted by their weight maps. Blink
   and mouth are blends with pictures that match the base pixel for pixel outside the eyes / mouth.
   Textures are premultiplied, resampled once to about the canvas size with the browser's good scaler. */
import type { Rig } from './rig';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBase, uPrev, uBlink, uTalk, uWeights;
uniform float uSize, uHip, uChest, uFade, uHasPrev, uBlinkAmt, uMouth, uMouthKind;
uniform float uBreath, uTilt, uHairAmp, uHairPhase, uLag, uAccent;
uniform vec2 uPivot, uNeck;
uniform vec4 uMouthBox;

// 0 at y >= lo (lower on the picture), 1 at y <= hi, smooth in between.
float ramp(float y, float lo, float hi) {
  float t = clamp((lo - y) / (lo - hi), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec4 at(sampler2D s, vec2 p) { return texture(s, p / uSize); }

void main() {
  vec2 p = vUv * uSize;
  vec4 w = texture(uWeights, vUv);
  // Head sway: turn the lookup back around the neck, fading in above it.
  float a = -uTilt * ramp(p.y, uNeck.x, uNeck.y);
  vec2 d = p - uPivot;
  float ca = cos(a), sa = sin(a);
  vec2 s = uPivot + vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
  // Breath: everything above the hips rises (so the colour comes from a little lower).
  s.y += uBreath * ramp(p.y, uHip, uChest);
  // Hair: a slow wave running down the strands, plus the lag while she is dragged; accents flick on their own.
  s.x -= w.r * (uHairAmp * sin(uHairPhase - p.y * 0.009) + uLag);
  s.x -= w.g * (uAccent + uLag * 0.5);
  vec4 c = at(uBase, s);
  if (uHasPrev > 0.5 && uFade < 1.0) c = mix(at(uPrev, s), c, uFade);
  if (uBlinkAmt > 0.001) c = mix(c, at(uBlink, s), uBlinkAmt);
  if (uMouth > 0.001) {
    if (uMouthKind < 0.5) {
      // A mouth only partly open: the open picture squashed into a band around the mouth's middle line. Only
      // that band shows it (so the lookup never reaches past the mouth); above and below it the face stays.
      vec2 mc = (uMouthBox.xy + uMouthBox.zw) * 0.5;
      vec2 hb = (uMouthBox.zw - uMouthBox.xy) * 0.5 + 1.0;
      float open_ = clamp(uMouth, 0.2, 1.0);
      vec2 q = abs(s - mc);
      float band = hb.y * open_;
      float inside = (1.0 - smoothstep(hb.x - 1.5, hb.x + 0.5, q.x)) * (1.0 - smoothstep(band - 0.75, band + 0.75, q.y));
      vec4 m = at(uTalk, vec2(s.x, mc.y + (s.y - mc.y) / open_));
      c = mix(c, m, inside * smoothstep(0.0, 0.2, uMouth));
    } else {
      // A glow that brightens with the voice.
      c = mix(c, at(uTalk, s), uMouth);
    }
  }
  outColor = c;
}`;

export interface Frame {
  fade: number;
  blink: number;
  mouth: number;
  /** px (rig space) */
  breath: number;
  /** radians */
  tilt: number;
  hairAmp: number;
  hairPhase: number;
  lag: number;
  accent: number;
}

/** The textures of one pose. `blink` / `talk` are absent when the pose has none. */
export interface PoseTex { base: WebGLTexture; weights: WebGLTexture; blink?: WebGLTexture; talk?: WebGLTexture }

const UNIFORMS = ['uBase', 'uPrev', 'uBlink', 'uTalk', 'uWeights', 'uSize', 'uHip', 'uChest', 'uFade', 'uHasPrev', 'uBlinkAmt', 'uMouth', 'uMouthKind',
  'uBreath', 'uTilt', 'uHairAmp', 'uHairPhase', 'uLag', 'uAccent', 'uPivot', 'uNeck', 'uMouthBox'] as const;
type Uniform = typeof UNIFORMS[number];

export class PuppetGL {
  private readonly prog: WebGLProgram;
  private readonly u: Record<Uniform, WebGLUniformLocation | null>;
  private readonly buf: WebGLBuffer;
  private readonly textures = new Set<WebGLTexture>();

  private constructor(private readonly gl: WebGL2RenderingContext) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    this.prog = prog;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<Uniform, WebGLUniformLocation | null>;
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);
    ['uBase', 'uPrev', 'uBlink', 'uTalk', 'uWeights'].forEach((n, i) => gl.uniform1i(this.u[n as Uniform], i));
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
  }

  /** null when WebGL2 is not there (old GPU, blocked driver): the caller falls back to plain pictures. */
  static create(canvas: HTMLCanvasElement): PuppetGL | null {
    try {
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
      return gl ? new PuppetGL(gl) : null;
    } catch {
      return null;
    }
  }

  /** Upload a picture (already resampled, premultiplied). */
  texture(src: ImageBitmap): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.add(t);
    return t;
  }

  drop(t: WebGLTexture | undefined) {
    if (!t || !this.textures.has(t)) return;
    this.gl.deleteTexture(t);
    this.textures.delete(t);
  }

  resize(px: number) {
    const c = this.gl.canvas as HTMLCanvasElement;
    if (c.width !== px || c.height !== px) { c.width = px; c.height = px; }
  }

  draw(rig: Rig, cur: PoseTex, prev: PoseTex | null, f: Frame) {
    const { gl, u } = this;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const bind = (unit: number, t: WebGLTexture) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
    bind(0, cur.base);
    bind(1, prev?.base ?? cur.base);
    bind(2, cur.blink ?? cur.base);
    bind(3, cur.talk ?? cur.base);
    bind(4, cur.weights);
    gl.uniform1f(u.uSize, rig.size);
    gl.uniform1f(u.uHip, rig.hip);
    gl.uniform1f(u.uChest, rig.chest);
    gl.uniform2f(u.uPivot, rig.pivot[0], rig.pivot[1]);
    gl.uniform2f(u.uNeck, rig.neck[0], rig.neck[1]);
    gl.uniform4f(u.uMouthBox, ...rig.mouth.box);
    gl.uniform1f(u.uMouthKind, rig.mouth.kind === 'glow' ? 1 : 0);
    gl.uniform1f(u.uFade, f.fade);
    gl.uniform1f(u.uHasPrev, prev ? 1 : 0);
    gl.uniform1f(u.uBlinkAmt, cur.blink ? f.blink : 0);
    gl.uniform1f(u.uMouth, cur.talk ? f.mouth : 0);
    gl.uniform1f(u.uBreath, f.breath);
    gl.uniform1f(u.uTilt, f.tilt);
    gl.uniform1f(u.uHairAmp, f.hairAmp);
    gl.uniform1f(u.uHairPhase, f.hairPhase);
    gl.uniform1f(u.uLag, f.lag);
    gl.uniform1f(u.uAccent, f.accent);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  get lost() { return this.gl.isContextLost(); }

  dispose() {
    for (const t of this.textures) this.gl.deleteTexture(t);
    this.textures.clear();
    this.gl.deleteBuffer(this.buf);
    this.gl.deleteProgram(this.prog);
  }
}

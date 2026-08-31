/*
The Effects Lab engine (format 2). docs/V6/V6_EFFECTS_V2_PLAN.md is the
design; this file is section 3 of it.

A preset is two GLSL bodies and a list of dials:

  feed   what goes INTO the feedback frame this frame. `ret` (vec3) is the
         new frame at `uv`. Reads any input.
  show   what reaches the screen. `ret` (vec3) and `alpha` (float, 1 by
         default): the effect's colour and how much of it covers what is
         behind it (the camera, when the stage puts the camera behind).

Every input is a function taking `uv` in SCREEN fractions, x right, y down,
the same space as the landmarks; the flips live in here, never in a preset:

  cam(uv)         the live camera (mirrored, as the landmarks are)
  camBlur(uv)     the camera blurred (stage.cam_blur pixels)
  mask(uv)        the body mask, temporally smoothed, 0..1
  maskSoft(uv)    the mask blurred by stage.mask_feather (screen heights)
  maskGrad(uv)    the soft mask's gradient (x, y), points into the body
  frame(uv)       the feedback frame from the previous step
  cutout(uv)      cam(uv) * mask(uv)
  hist(k, uv)     the camera k frames ago, k 0..stage.history - 1 (max 8)
  stamps(uv)      the stamp accumulator (stage.stamp_every seconds)
  background(uv)  the background captured while nobody was in view
  hsv(h, s, v), lum(rgb), chroma(rgb)
  tf_<joint>_x/y/z/v, tf_present, tf_dist, tf_speed   the body, as uniforms
  time, res, aspect (height / width), the preset's dials by name

Buffers: the feedback frame (ping-pong), the camera texture, the mask
(ping-pong for the temporal smoothing), the soft mask, the blurred camera,
the history ring, the stamp accumulator (ping-pong for its decay), the
background, the screen texture. Everything is drawn with one fullscreen
quad; there is no mesh in this version (the plan's "membrane" adds one).

The final pass composites: show over (matte over cam) when the stage has
the camera behind, else show over black; black keyed to alpha for the
Spout render; then the body lines on top.
*/
import { compileProgram, createTexture2D, attachToFramebuffer, quad, floatPrecision } from './gl.js';
import { BodyPass } from './body.js';

const HIST_MAX = 25;  // one sampler2DArray with HIST_MAX layers: a single texture unit however many slots
const JOINTS = ['head', 'torso', 'lwrist', 'rwrist', 'lelbow', 'relbow', 'lhip', 'rhip', 'lhand', 'rhand',
  'nose', 'leye', 'reye', 'lear', 'rear', 'mouth', 'lshoulder', 'rshoulder', 'lknee', 'rknee', 'lankle', 'rankle'];
export const BODY_UNIFORMS = JOINTS.flatMap((j) => ['x', 'y', 'z', 'v', 'p'].map((s) => `tf_${j}_${s}`)).concat(['tf_present', 'tf_dist', 'tf_speed', 'tf_size']);

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(void) { gl_Position = vec4(aPos, 0.0, 1.0); vUv = aPos * 0.5 + 0.5; }`;

function prelude(precision, dials) {
  const histDecl = `uniform mediump sampler2DArray t_hist_arr; uniform int hist_head; uniform float hist_age[${HIST_MAX}];`;
  const histCase = `  int idx = ((hist_head - k) % hist_n + hist_n) % hist_n;
  return texture(t_hist_arr, vec3(_f(uv), float(idx))).rgb;`;
  return `#version 300 es
precision ${precision} float; precision highp int; precision mediump sampler2D;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D t_cam, t_cam_blur, t_mask, t_mask_soft, t_frame, t_frame_soft, t_frame_blur, t_stamps, t_background;
${histDecl}
uniform vec2 res; uniform float time; uniform float aspect; uniform int hist_n;
${BODY_UNIFORMS.map((n) => `uniform float ${n};`).join('\n')}
${dials.map((n) => `uniform float ${n};`).join('\n')}
vec2 _f(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }
vec3 cam(vec2 uv) { return texture(t_cam, _f(uv)).rgb; }
vec3 camBlur(vec2 uv) { return texture(t_cam_blur, _f(uv)).rgb; }
float mask(vec2 uv) { return texture(t_mask, _f(uv)).r; }
float maskSoft(vec2 uv) { return texture(t_mask_soft, _f(uv)).r; }
vec2 maskGrad(vec2 uv) {
  vec2 e = vec2(2.0 / res.x, 2.0 / res.y);
  return vec2(maskSoft(uv + vec2(e.x, 0.0)) - maskSoft(uv - vec2(e.x, 0.0)), maskSoft(uv + vec2(0.0, e.y)) - maskSoft(uv - vec2(0.0, e.y)));
}
vec3 frame(vec2 uv) { return texture(t_frame, _f(uv)).rgb; }
vec3 frameSoft(vec2 uv) { return texture(t_frame_soft, _f(uv)).rgb; }
vec3 frameBlur(vec2 uv) { return texture(t_frame_blur, _f(uv)).rgb; }
// the soft mask's gradient felt over reach (screen heights): points INTO the body
vec2 maskGrad(vec2 uv, float reach) {
  vec2 e = vec2(reach * aspect, reach) * 0.5;
  return vec2(maskSoft(uv + vec2(e.x, 0.0)) - maskSoft(uv - vec2(e.x, 0.0)), maskSoft(uv + vec2(0.0, e.y)) - maskSoft(uv - vec2(0.0, e.y)));
}
// how much body lies within dist (screen heights) of uv: 1 inside, falling to 0 beyond, no rings
float maskNear(vec2 uv, float dist) {
  float s = mask(uv);
  for (int r = 1; r <= 4; r++) {
    float rad = dist * float(r) * 0.25;
    for (int k = 0; k < 4; k++) { float a = float(k) * 1.5708 + float(r) * 0.39; s += maskSoft(uv + vec2(cos(a) * aspect, sin(a)) * rad); }
  }
  return clamp(s / 9.0, 0.0, 1.0);
}
// value noise, 0..1, smooth in all three axes; the third is time
float _hash(vec3 p) { p = fract(p * 0.1031 + vec3(0.1, 0.2, 0.3)); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(_hash(i), _hash(i + vec3(1, 0, 0)), f.x), mix(_hash(i + vec3(0, 1, 0)), _hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(_hash(i + vec3(0, 0, 1)), _hash(i + vec3(1, 0, 1)), f.x), mix(_hash(i + vec3(0, 1, 1)), _hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// a swirling flow from the noise: divergence-free, so what it carries never piles up or thins
vec2 _curl1(vec2 p, float t) {
  float e = 0.05;
  float dx = noise3(vec3(p + vec2(e, 0.0), t)) - noise3(vec3(p - vec2(e, 0.0), t));
  float dy = noise3(vec3(p + vec2(0.0, e), t)) - noise3(vec3(p - vec2(0.0, e), t));
  return vec2(dy, -dx) / (2.0 * e);
}
// Two layers at incommensurate speeds, each on a slowly drifting domain. One layer of lattice
// noise eases to a stop everywhere at once as time crosses each lattice step (every cell
// rotated, paused, rotated, in step -- Tim, 2026-08-30); the drift keeps the cells travelling
// and the second layer never pauses at the same moment as the first.
vec2 curl(vec2 p, float t) {
  vec2 a = _curl1(p + vec2(t * 0.31, -t * 0.23), t);
  vec2 b = _curl1(p * 1.93 + vec2(17.0, 31.0) + vec2(-t * 0.17, t * 0.29), t * 1.61 + 5.0);
  return a * 0.67 + b * 0.33;
}
// the body's wells: the fetch point pulled toward each joint, so the picture flows AWAY from it.
// strength = base + speed_gain x the joint's speed; sharp = how tightly it is felt (bigger = closer)
vec2 _well(vec2 uv, vec2 j, float v, float p, float push, float sharp, float base, float speed_gain) {
  // p: the joint's presence, faded by the page as it is found and lost, so a well never snaps on or off
  vec2 d = (uv - j) * vec2(1.0 / aspect, 1.0);
  float k = p * clamp(base + speed_gain * v, 0.0, 1.0) / (1.0 + dot(d, d) * sharp);
  return -(uv - j) * push * k;
}
vec2 wells(vec2 uv, float push, float sharp, float base, float speed_gain) {
  vec2 s = vec2(0.0);
  s += _well(uv, vec2(tf_head_x, tf_head_y), tf_head_v, tf_head_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lshoulder_x, tf_lshoulder_y), tf_lshoulder_v, tf_lshoulder_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_rshoulder_x, tf_rshoulder_y), tf_rshoulder_v, tf_rshoulder_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lelbow_x, tf_lelbow_y), tf_lelbow_v, tf_lelbow_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_relbow_x, tf_relbow_y), tf_relbow_v, tf_relbow_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lwrist_x, tf_lwrist_y), tf_lwrist_v, tf_lwrist_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_rwrist_x, tf_rwrist_y), tf_rwrist_v, tf_rwrist_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lhand_x, tf_lhand_y), tf_lhand_v, tf_lhand_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_rhand_x, tf_rhand_y), tf_rhand_v, tf_rhand_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lhip_x, tf_lhip_y), tf_lhip_v, tf_lhip_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_rhip_x, tf_rhip_y), tf_rhip_v, tf_rhip_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lknee_x, tf_lknee_y), tf_lknee_v, tf_lknee_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_rknee_x, tf_rknee_y), tf_rknee_v, tf_rknee_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_lankle_x, tf_lankle_y), tf_lankle_v, tf_lankle_p, push, sharp, base, speed_gain);
  s += _well(uv, vec2(tf_rankle_x, tf_rankle_y), tf_rankle_v, tf_rankle_p, push, sharp, base, speed_gain);
  return s;
}
vec3 cutout(vec2 uv) { return cam(uv) * mask(uv); }
vec3 stamps(vec2 uv) { return texture(t_stamps, _f(uv)).rgb; }
vec3 background(vec2 uv) { return texture(t_background, _f(uv)).rgb; }
vec3 hist(int k, vec2 uv) {
  if (hist_n <= 0) return cam(uv);
  k = clamp(k, 0, hist_n - 1);
${histCase}
}
// seconds since slot k was captured, continuous (the page's clock, not the ring's turns)
float histAge(int k) { return hist_age[clamp(k, 0, 24)]; }
vec3 hsv(float h, float s, float v) {
  vec3 k = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
  vec3 p = abs(fract(vec3(h) + k) * 6.0 - 3.0);
  return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float chroma(vec3 c) { float mx = max(c.r, max(c.g, c.b)); return mx > 0.0 ? (mx - min(c.r, min(c.g, c.b))) / mx : 0.0; }
`;
}

class Pass {
  constructor(gl, fs, label) {
    this.gl = gl;
    this.prog = compileProgram(gl, VS, fs, label);
    this.aPos = gl.getAttribLocation(this.prog, 'aPos');
    this.u = {};
  }
  loc(name) { if (!(name in this.u)) this.u[name] = this.gl.getUniformLocation(this.prog, name); return this.u[name]; }
}

export class LabEngine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('getContext("webgl2") returned null: the Effects Lab needs WebGL 2');
    this.gl = gl;
    this.precision = floatPrecision(gl);
    this.quad = quad(gl);
    this.body = new BodyPass(gl);
    this.width = canvas.width; this.height = canvas.height;
    this.time = 0; this.lastMs = performance.now();
    this.uniforms = {};                     // tf_* and the dials, by name
    this.dialNames = [];
    this.stage = { camera_behind: false, matte: { on: false, feather_in: 0.015, feather_out: 0.04, inside: 1.0, outside: 0.0 },
                   opacity: 1.0, history: 0, history_every: 0, history_source: 'camera', stamp_every: 0, stamp_fade: 1.0, cam_blur: 12, frame_blur: 24, mask_feather: 0.02, mask_smooth: 0.35, diffuse: 0 };
    this.keyBlack = false;
    this.chains = []; this.chainsAdditive = true;          // the lines: outline, bones, hands
    this.discs = []; this.discColor = [1, 1, 1]; this.discSoft = true;   // [{x, y (up), rad, a}] the landmark discs
    this.fill = { color: [1, 1, 1], alpha: 0 };              // the mask as a faint shape
    this.seedsMode = 'frame';                                // where the per-frame seeds go: 'frame' (into the feedback), 'top' (over the screen), 'takes' (nowhere per frame; ring captures always get them)
    this.camImage = null; this.maskImage = null;
    this.haveCam = false; this.haveMask = false;
    this.stampClock = 0; this.captured = false; this.wantCapture = false;
    this.stats = { frameMs: 0, uploadMs: 0, gpu: null };
    // GPU time per frame, in three sequential spans, read back when the GPU has finished them
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.timerPending = [];      // [{name, q}] queries issued, results not yet read
    this.timerLast = {};         // the latest result per span, ms
    this.frameScale = 1;         // the feedback frame's size as a fraction of the screen (stage.frame_scale)
    this.error = null;

    // the fixed passes
    this.pCopy = new Pass(gl, this._fs(`uniform sampler2D src; uniform float gain; uniform float flipX; uniform float flipY;
      void main(void) { vec2 uv = vec2(flipX > 0.5 ? 1.0 - vUv.x : vUv.x, flipY > 0.5 ? 1.0 - vUv.y : vUv.y); fragColor = vec4(texture(src, uv).rgb * gain, 1.0); }`), 'copy');
    // the mask coming in: the model's confidence, which dips on dark clothing (0.5..0.7 where it should be 1).
    // Hardened here, so anything at least half certain is fully inside; the feathers shape the edge only.
    this.pMix = new Pass(gl, this._fs(`uniform sampler2D a; uniform sampler2D b; uniform float k; uniform float flipX; uniform float flipY;
      void main(void) { vec2 uv = vec2(flipX > 0.5 ? 1.0 - vUv.x : vUv.x, flipY > 0.5 ? 1.0 - vUv.y : vUv.y);
        vec3 nb = smoothstep(0.35, 0.6, texture(b, uv).rgb);
        fragColor = vec4(mix(texture(a, vUv).rgb, nb, k), 1.0); }`), 'mix');
    this.pBlur = new Pass(gl, this._fs(`uniform sampler2D src; uniform vec2 dir; uniform float radius;
      void main(void) { vec3 acc = vec3(0.0); float wsum = 0.0;
        for (int i = -8; i <= 8; i++) { float w = exp(-float(i * i) / 24.0); acc += texture(src, vUv + dir * float(i) * radius / 8.0).rgb * w; wsum += w; }
        fragColor = vec4(acc / wsum, 1.0); }`), 'blur');
    this.pStamp = new Pass(gl, this._fs(`uniform sampler2D acc; uniform sampler2D cam; uniform sampler2D msk; uniform float fade; uniform float add;
      void main(void) { vec3 a = texture(acc, vUv).rgb * fade; vec3 c = texture(cam, vUv).rgb; float m = texture(msk, vUv).r;
        fragColor = vec4(mix(a, c, m * add), 1.0); }`), 'stamp');
    this.pSeed = new Pass(gl, this._fs(`uniform sampler2D msk; uniform vec4 fill; uniform vec4 discs[64]; uniform int nd; uniform vec3 discCol; uniform float discSoft; uniform float aspect;
      void main(void) {
        vec3 c = fill.rgb * fill.a * texture(msk, vUv).r;
        for (int i = 0; i < 64; i++) {
          if (i >= nd) break;
          vec4 d = discs[i];
          float r = length((vUv - d.xy) * vec2(1.0 / aspect, 1.0));
          float k = discSoft > 0.5 ? 1.0 - smoothstep(0.0, d.z, r) : (r < d.z ? 1.0 : 0.0);
          c += discCol * d.w * k;
        }
        fragColor = vec4(c, 1.0);
      }`), 'seed');
    this.pFinal = new Pass(gl, this._fs(`uniform sampler2D show; uniform sampler2D cam; uniform sampler2D msk;
      uniform float camBehind; uniform float opacity; uniform float keyBlack;
      uniform float matteOn; uniform float fin; uniform float fout; uniform float camIn; uniform float camOut;
      void main(void) {
        vec4 s = texture(show, vUv);
        vec3 fx = s.rgb; float fa = clamp(s.a, 0.0, 1.0) * opacity;
        vec3 under = vec3(0.0); float ua = 0.0;
        if (camBehind > 0.5) {
          vec3 c = texture(cam, vUv).rgb;
          // the camera layer's own opacity: camIn inside the mask, camOut outside it, feathered between
          float t = 1.0;
          if (matteOn > 0.5) {
            float m = texture(msk, vUv).r;
            float sum = fin + fout;
            float lo = sum > 0.0 ? 0.5 - 0.5 * (fout / sum) : 0.5, hi = sum > 0.0 ? 0.5 + 0.5 * (fin / sum) : 0.5;
            t = clamp((m - lo) / max(1e-4, hi - lo), 0.0, 1.0); t = t * t * (3.0 - 2.0 * t);
          }
          ua = mix(camOut, camIn, t);
          under = c * ua;                        // over black on a screen; premultiplied for the stream
        }
        vec3 col = fx * fa + under * (1.0 - fa);
        // black as transparency (the Spout stream): the camera layer is as solid as its own opacity says, the light
        // as solid as it is bright, black is clear. Otherwise the layers' own coverage.
        float a = keyBlack > 0.5 ? max(ua, max(col.r, max(col.g, col.b))) : max(fa, ua);
        fragColor = vec4(col, a);
      }`), 'final');

    this._alloc();
    this.setPreset({ dials: {}, feed: 'ret = frame(uv) * 0.9 + cutout(uv) * 0.1;', show: 'ret = frame(uv);' });
  }

  _fs(body) { return `#version 300 es\nprecision ${this.precision} float; precision mediump sampler2D;\nin vec2 vUv; out vec4 fragColor;\n${body}`; }

  /* A render target. createTexture2D makes mipmaps once, black, and filters
     through them; rendering writes level 0 only, so anything sampled smaller
     than its own size read black (the frame into its blurs, the camera into
     its blur, the probe). No mipmaps here: linear, level 0. */
  _tex(w, h) {
    const gl = this.gl, t = createTexture2D(gl, w, h);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }
  _fbtex(w, h) { const gl = this.gl; const fb = gl.createFramebuffer(); const tex = this._tex(w, h); attachToFramebuffer(gl, fb, tex); return { fb, tex, w, h }; }

  _alloc() {
    const gl = this.gl, W = this.width, H = this.height;
    const hw = Math.max(2, W >> 1), hh = Math.max(2, H >> 1);
    // the feedback frame at frame_scale of the screen: the feed pass is the costly one, and it is
    // a smooth field; at 0.5 it costs a quarter and the show pass samples it up to the screen
    const fw = Math.max(2, Math.round(W * this.frameScale)), fh = Math.max(2, Math.round(H * this.frameScale));
    this.frameA = this._fbtex(fw, fh); this.frameB = this._fbtex(fw, fh);
    this.frameTmp = this._fbtex(fw, fh); this.frameTmp2 = this._fbtex(fw, fh);   // for the diffusion blur
    this.screen = this._fbtex(W, H);
    this.camTex = this._tex(W, H); this.camUp = this._fbtex(W, H);        // camUp: the camera at canvas size, mirrored as needed
    this.maskRaw = this._tex(W, H); this.maskA = this._fbtex(hw, hh); this.maskB = this._fbtex(hw, hh);
    this.maskSoft = this._fbtex(hw, hh); this.tmpHalf = this._fbtex(hw, hh);
    this.camBlur = this._fbtex(hw, hh); this.tmpHalf2 = this._fbtex(hw, hh);
    this.frameSoft = this._fbtex(hw, hh); this.frameBlur = this._fbtex(hw, hh);
    this.stampA = this._fbtex(W, H); this.stampB = this._fbtex(W, H);
    this.background = this._fbtex(W, H);
    // the ring: one 2D array texture, one framebuffer retargeted per layer
    if (this.histArr) gl.deleteTexture(this.histArr);
    this.histArr = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.histArr);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, hw, hh, HIST_MAX);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.histFb = gl.createFramebuffer();
    this.histW = hw; this.histH = hh;
    this.histHead = 0; this.histCount = 0;
    this.histBorn = new Array(HIST_MAX).fill(-1);   // performance clock seconds each slot was captured; -1 = never
    for (const t of [this.frameA, this.frameB, this.screen, this.stampA, this.stampB, this.background, this.maskA, this.maskB, this.maskSoft, this.camBlur, this.frameSoft, this.frameBlur]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  setSize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h; this.canvas.width = w; this.canvas.height = h;
    this._alloc();
  }

  /* preset = { dials: {name: {value}}, feed, show }. Throws with the compiler's
     message; the running preset keeps running. */
  setPreset(preset) {
    const gl = this.gl;
    const dials = Object.keys(preset.dials || {});
    const taken = new Set(['cam', 'camBlur', 'mask', 'maskSoft', 'maskGrad', 'maskNear', 'frame', 'frameSoft', 'frameBlur', 'cutout', 'stamps', 'background', 'hist',
      'hsv', 'lum', 'chroma', 'noise3', 'curl', 'wells', 'histAge', 'hist_head', 'hist_age', 'res', 'time', 'aspect', 'hist_n', 'uv', 'ret', 'alpha', ...BODY_UNIFORMS,
      'floor', 'ceil', 'fract', 'mix', 'min', 'max', 'abs', 'sin', 'cos', 'tan', 'pow', 'exp', 'log', 'sqrt', 'length', 'clamp', 'step', 'smoothstep', 'dot', 'cross',
      'normalize', 'texture', 'mod', 'sign', 'round', 'trunc', 'in', 'out', 'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'if', 'else', 'for', 'while', 'return',
      'const', 'uniform', 'sampler2D', 'main', 'discard', 'break', 'continue', 'true', 'false']);
    for (const n of dials) {
      if (taken.has(n)) throw new Error(`dial "${n}" has the name of an input; rename it`);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n)) throw new Error(`dial "${n}" is not a valid name (letters, digits, underscore)`);
    }
    const pre = prelude(this.precision, dials);
    const feedFs = pre + `\nvoid main(void) { vec2 uv = _f(vUv); vec3 ret = vec3(0.0);\n${preset.feed || ''}\n fragColor = vec4(ret, 1.0); }`;
    const showFs = pre + `\nvoid main(void) { vec2 uv = _f(vUv); vec3 ret = vec3(0.0); float alpha = 1.0;\n${preset.show || ''}\n fragColor = vec4(ret, alpha); }`;
    const feed = new Pass(gl, feedFs, 'feed');       // throws first, before anything is replaced
    const show = new Pass(gl, showFs, 'show');
    if (this.pFeed) gl.deleteProgram(this.pFeed.prog);
    if (this.pShow) gl.deleteProgram(this.pShow.prog);
    this.pFeed = feed; this.pShow = show;
    this.dialNames = dials;
    for (const n of dials) this.uniforms[n] = preset.dials[n].value;
    this.error = null;
  }

  setDial(name, value) { this.uniforms[name] = value; }

  /* Clears the feedback frame and the stamps (a preset change, or a key). */
  clear() {
    const gl = this.gl;
    for (const t of [this.frameA, this.frameB, this.stampA, this.stampB]) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    if (this.histBorn) this.histBorn.fill(-1);
    this.histCount = 0; this.histClock = 0;
  }
  captureBackground() { this.wantCapture = true; }

  _run(pass, target, bind) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
    gl.useProgram(pass.prog);
    let unit = 0;
    const tex = (name, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.bindSampler(unit, null); gl.uniform1i(pass.loc(name), unit); unit++; };
    bind(tex, pass);
    gl.disable(gl.BLEND);
    this.quad.draw(pass.aPos);
  }

  _upload(tex, img) {
    const gl = this.gl;
    // uploaded as it comes, row 0 at the top; the copy passes that read it (camUp, the mask mix) turn it
    // the way the frame buffers are (row 0 at the bottom). One place, whatever the source type.
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); } catch (e) { return false; }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return true;
  }

  _blur(src, dst, tmp, radiusPx) {
    const gl = this.gl;
    const r = Math.max(0, radiusPx);
    this._run(this.pBlur, tmp, (tex, p) => { tex('src', src); gl.uniform2f(p.loc('dir'), 1 / tmp.w, 0); gl.uniform1f(p.loc('radius'), r / (this.width / tmp.w)); });
    this._run(this.pBlur, dst, (tex, p) => { tex('src', tmp.tex); gl.uniform2f(p.loc('dir'), 0, 1 / tmp.h); gl.uniform1f(p.loc('radius'), r / (this.height / tmp.h)); });
  }

  /* GPU spans: begin/end one query per span, sequential; results arrive a frame or two later. */
  _spanBegin(name) {
    const ext = this.timerExt; if (!ext) return;
    const gl = this.gl, q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.timerPending.push({ name, q });
  }
  _spanEnd() { if (this.timerExt) this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT); }
  _spansCollect() {
    const ext = this.timerExt; if (!ext) return;
    const gl = this.gl;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { for (const p of this.timerPending) gl.deleteQuery(p.q); this.timerPending = []; return; }
    const keep = [];
    for (const p of this.timerPending) {
      if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { this.timerLast[p.name] = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6; gl.deleteQuery(p.q); }
      else keep.push(p);
    }
    this.timerPending = keep;
    const t = this.timerLast;
    if (t.prep != null && t.feed != null && t.show != null) this.stats.gpu = { prep: +t.prep.toFixed(2), feed: +t.feed.toFixed(2), show: +t.show.toFixed(2), total: +(t.prep + t.feed + t.show).toFixed(2) };
  }

  render() {
    const gl = this.gl, t0 = performance.now();
    const dt = Math.min(0.1, (t0 - this.lastMs) / 1000); this.lastMs = t0; this.time += dt;
    const st = this.stage;
    const fs = Math.min(1, Math.max(0.25, st.frame_scale == null ? 1 : st.frame_scale));
    if (fs !== this.frameScale) { this.frameScale = fs; this._alloc(); }
    this._spansCollect();
    this._spanBegin('prep');

    // 1. inputs
    const tu = performance.now();
    // camImage / maskImage: an ImageBitmap (decoded off the main thread by the page) or an <img>; null = nothing new this frame
    if (this.camImage && (this.camImage.width || this.camImage.naturalWidth)) this.haveCam = this._upload(this.camTex, this.camImage);
    if (this.maskImage && (this.maskImage.width || this.maskImage.naturalWidth)) this.haveMask = this._upload(this.maskRaw, this.maskImage);
    this.stats.uploadMs = performance.now() - tu;   // the image uploads: CPU time, the rest is submitted to the GPU
    if (this.camImage) this.lastCam = this.camImage;
    if (this.maskImage) this.lastMask = this.maskImage;
    // the camera at canvas size (the setup feed is already mirrored)
    if (this.haveCam) this._run(this.pCopy, this.camUp, (tex, p) => { tex('src', this.camTex); gl.uniform1f(p.loc('gain'), 1); gl.uniform1f(p.loc('flipX'), 0); gl.uniform1f(p.loc('flipY'), 1); });
    // the mask, mirrored into screen space and smoothed over time
    if (this.maskImage && this.haveMask) {
      // k = the weight of the NEW mask: 1 at mask_smooth 0 (raw every frame), 0.65 at 0.35
      const k = 1 - Math.max(0, Math.min(0.99, st.mask_smooth));
      this._run(this.pMix, this.maskB, (tex, p) => { tex('a', this.maskA.tex); tex('b', this.maskRaw); gl.uniform1f(p.loc('k'), k); gl.uniform1f(p.loc('flipX'), 1); gl.uniform1f(p.loc('flipY'), 1); });
      const s = this.maskA; this.maskA = this.maskB; this.maskB = s;
      this._blur(this.maskA.tex, this.maskSoft, this.tmpHalf, st.mask_feather * this.height);
    }
    if (this.haveCam) this._blur(this.camUp.tex, this.camBlur, this.tmpHalf2, st.cam_blur);
    // the history ring: every frame by default, or one capture per history_every seconds.
    // history_source 'cutout' stores the masked person WITH the stage's seeds drawn on
    // (each slot is then one "take": its own layer, gone when the ring turns past it).
    const histN = Math.max(0, Math.min(HIST_MAX, st.history | 0));
    if (histN > 0 && this.haveCam) {
      this.histClock = (this.histClock || 0) + dt;
      const every = st.history_every || 0;
      if (every <= 0 || this.histClock >= every) {
        this.histClock = 0;
        this.histHead = (this.histHead + 1) % histN;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFb);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.histArr, 0, this.histHead);
        const buf = { fb: this.histFb, w: this.histW, h: this.histH };
        if (st.history_source === 'cutout' && this.haveMask) {
          // cam times mask via the stamp pass with fade 0: acc*0 + cam*m
          this._run(this.pStamp, buf, (tex, p) => { tex('acc', this.camUp.tex); tex('cam', this.camUp.tex); tex('msk', this.maskA.tex); gl.uniform1f(p.loc('fade'), 0); gl.uniform1f(p.loc('add'), 1); });
          this._drawSeeds(buf);                    // the outline (and whatever seeds are on) burned into the take
        } else {
          this._run(this.pCopy, buf, (tex, p) => { tex('src', this.camUp.tex); gl.uniform1f(p.loc('gain'), 1); gl.uniform1f(p.loc('flipX'), 0); gl.uniform1f(p.loc('flipY'), 0); });
        }
        this.histBorn[this.histHead] = this.time;
        this.histCount = Math.min(histN, this.histCount + 1);
      }
    }
    // the stamps: decay every frame, add the cutout every stamp_every seconds
    if (st.stamp_every > 0 && this.haveCam && this.haveMask) {
      this.stampClock += dt;
      const add = this.stampClock >= st.stamp_every ? 1 : 0;
      if (add) this.stampClock = 0;
      this._run(this.pStamp, this.stampB, (tex, p) => { tex('acc', this.stampA.tex); tex('cam', this.camUp.tex); tex('msk', this.maskA.tex); gl.uniform1f(p.loc('fade'), st.stamp_fade); gl.uniform1f(p.loc('add'), add); });
      const s = this.stampA; this.stampA = this.stampB; this.stampB = s;
    }
    // the background: captured on request (the page asks when nobody is in view)
    if (this.wantCapture && this.haveCam) {
      this._run(this.pCopy, this.background, (tex, p) => { tex('src', this.camUp.tex); gl.uniform1f(p.loc('gain'), 1); gl.uniform1f(p.loc('flipX'), 0); gl.uniform1f(p.loc('flipY'), 0); });
      this.wantCapture = false; this.captured = true;
    }

    // the frame's two blurred copies: fine (the seeds stand out against it) and heavy (the soft masses)
    this._blur(this.frameA.tex, this.frameSoft, this.tmpHalf, 3);
    this._blur(this.frameA.tex, this.frameBlur, this.tmpHalf2, st.frame_blur == null ? 24 : st.frame_blur);

    this._spanEnd();
    // 2. the preset's passes
    this._spanBegin('feed');
    const bindAll = (tex, p) => {
      tex('t_cam', this.camUp.tex); tex('t_cam_blur', this.camBlur.tex); tex('t_mask', this.maskA.tex); tex('t_mask_soft', this.maskSoft.tex);
      tex('t_frame', this.frameA.tex); tex('t_frame_soft', this.frameSoft.tex); tex('t_frame_blur', this.frameBlur.tex);
      tex('t_stamps', this.stampA.tex); tex('t_background', this.background.tex);
      // the ring: one array texture on one unit; ages per slot k (newest first), continuous
      gl.activeTexture(gl.TEXTURE0 + 15); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.histArr); gl.bindSampler(15, null);
      gl.uniform1i(p.loc('t_hist_arr'), 15);
      gl.uniform1i(p.loc('hist_head'), this.histHead);
      const ages = new Float32Array(HIST_MAX);
      for (let k = 0; k < HIST_MAX; k++) {
        const idx = histN > 0 ? ((this.histHead - k) % histN + histN) % histN : 0;
        const born = this.histBorn[idx];
        ages[k] = born >= 0 ? this.time - born : 1e6;   // a never-filled slot is infinitely old: invisible to any fade
      }
      gl.uniform1fv(p.loc('hist_age'), ages);
      gl.uniform2f(p.loc('res'), this.frameA.w, this.frameA.h);   // the frame's own size: pixel offsets in a preset are frame pixels
      gl.uniform1f(p.loc('time'), this.time);
      gl.uniform1f(p.loc('aspect'), this.height / this.width);
      gl.uniform1i(p.loc('hist_n'), histN);
      for (const n of BODY_UNIFORMS) gl.uniform1f(p.loc(n), this.uniforms[n] || 0);
      for (const n of this.dialNames) gl.uniform1f(p.loc(n), this.uniforms[n] || 0);
    };
    this._run(this.pFeed, this.frameB, bindAll);
    const s = this.frameA; this.frameA = this.frameB; this.frameB = s;
    // the seeds: what the body writes into the frame this step, added to what the feed left.
    // In 'takes' mode nothing is drawn per frame: the ring captures burn the seeds into each take and that is all.
    if (this.seedsMode === 'frame') this._drawSeeds(this.frameA);
    // diffusion: the frame itself blurred a little every step, so the discrete iterations of the
    // transport melt into each other instead of standing as distinct layers (stage.diffuse, px per step)
    if (st.diffuse > 0) {
      this._blur(this.frameA.tex, this.frameTmp, this.frameTmp2, st.diffuse);
      const d = this.frameA; this.frameA = this.frameTmp; this.frameTmp = d;
    }
    this._spanEnd();
    this._spanBegin('show');
    this._run(this.pShow, this.screen, (tex, p) => { bindAll(tex, p); gl.uniform2f(p.loc('res'), this.width, this.height); });

    // 3. to the canvas: the layers, the key, the lines on top
    const m = st.matte || {};
    this._run(this.pFinal, null, (tex, p) => {
      tex('show', this.screen.tex); tex('cam', this.camUp.tex); tex('msk', this.maskSoft.tex);
      gl.uniform1f(p.loc('camBehind'), st.camera_behind && this.haveCam ? 1 : 0);
      gl.uniform1f(p.loc('opacity'), st.opacity);
      gl.uniform1f(p.loc('keyBlack'), this.keyBlack ? 1 : 0);
      gl.uniform1f(p.loc('matteOn'), m.on && this.haveMask ? 1 : 0);
      gl.uniform1f(p.loc('fin'), m.feather_in || 0); gl.uniform1f(p.loc('fout'), m.feather_out || 0);
      gl.uniform1f(p.loc('camIn'), m.inside == null ? 1 : m.inside); gl.uniform1f(p.loc('camOut'), m.outside == null ? 0 : m.outside);
    });
    if (this.seedsMode === 'top') this._drawSeeds(null);
    this._spanEnd();
    this.stats.frameMs = performance.now() - t0;
  }

  /* The mean and the peak of each buffer, read back at 32x18. The numbers behind
     "is anything there": which stage is empty when the screen shows nothing. */
  probe() {
    const gl = this.gl;
    if (!this.probeFb) this.probeFb = this._fbtex(32, 18);
    const read = (tex) => {
      this._run(this.pCopy, this.probeFb, (t, p) => { t('src', tex); gl.uniform1f(p.loc('gain'), 1); gl.uniform1f(p.loc('flipX'), 0); gl.uniform1f(p.loc('flipY'), 0); });
      const px = new Uint8Array(32 * 18 * 4);
      gl.readPixels(0, 0, 32, 18, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, mx = 0;
      for (let i = 0; i < px.length; i += 4) { const v = Math.max(px[i], px[i + 1], px[i + 2]); sum += v; if (v > mx) mx = v; }
      return [+(sum / (px.length / 4) / 255).toFixed(3), +(mx / 255).toFixed(3)];
    };
    const err = gl.getError();   // the first error since the last probe, 0 = none
    const dim = (i) => (i ? [i.width || i.naturalWidth, i.height || i.naturalHeight] : null);
    return { glError: err, size: [this.width, this.height], camSize: dim(this.lastCam), maskSize: dim(this.lastMask),
      buf: { cam: read(this.camUp.tex), mask: read(this.maskA.tex), maskSoft: read(this.maskSoft.tex), frame: read(this.frameA.tex), frameSoft: read(this.frameSoft.tex), frameBlur: read(this.frameBlur.tex), screen: read(this.screen.tex) } };
  }

  /* The lines, the discs and the mask fill, additive, into target (a frame buffer) or the canvas (null). */
  _drawSeeds(target) {
    const gl = this.gl;
    const haveDiscs = this.discs.length > 0, haveFill = this.fill.alpha > 0 && this.haveMask;
    if (!this.chains.length && !haveDiscs && !haveFill) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
    gl.enable(gl.BLEND);
    if (this.chains.length) this.body.drawChains(this.chains, target ? target.w : this.width, target ? target.h : this.height, this.chainsAdditive);
    if (haveDiscs || haveFill) {
      const n = Math.min(64, this.discs.length), arr = new Float32Array(64 * 4);
      for (let i = 0; i < n; i++) { const d = this.discs[i]; arr[i * 4] = d.x; arr[i * 4 + 1] = d.y; arr[i * 4 + 2] = d.rad; arr[i * 4 + 3] = d.a; }
      gl.useProgram(this.pSeed.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.maskA.tex); gl.bindSampler(0, null); gl.uniform1i(this.pSeed.loc('msk'), 0);
      const f = this.fill;
      gl.uniform4f(this.pSeed.loc('fill'), f.color[0], f.color[1], f.color[2], haveFill ? f.alpha : 0);
      gl.uniform4fv(this.pSeed.loc('discs'), arr); gl.uniform1i(this.pSeed.loc('nd'), n);
      gl.uniform3f(this.pSeed.loc('discCol'), this.discColor[0], this.discColor[1], this.discColor[2]);
      gl.uniform1f(this.pSeed.loc('discSoft'), this.discSoft ? 1 : 0);
      gl.uniform1f(this.pSeed.loc('aspect'), this.height / this.width);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.quad.draw(this.pSeed.aPos);
    }
  }
}

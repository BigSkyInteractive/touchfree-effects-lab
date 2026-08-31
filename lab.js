/*
Effects Lab: the page. docs/V6/V6_EFFECTS_V2_PLAN.md is the design.

The page feeds the engine (engine/lab.js) three things every frame: the
camera picture (the setup MJPEG, already mirrored), the body mask (the
mask stream, unmirrored; the engine flips it), and the body as uniforms
(tf_<joint>_x/y/z/v from body_state). A preset (presets_config.json) is
two GLSL bodies and its dials; a dial may be bound to a body source. The
stage block says what of the body is drawn as lines and which layers are
on. The panel (panel.js) is two tabs, Look and Stage.

Files: lab_config.json (which preset loads, the sources' ranges, the
landmark ingest) and presets_config.json (the presets). Both are written
through /api/kiosk/content-config; a preset save writes only its own
entry into the file as it is on disk. R re-reads both from disk and
applies only what changed. Keys missing from a file take the defaults in
DEFAULTS below; nothing faults on a missing key.

Keys: G panel, R reload from disk, H numbers, B capture the background
now, C clear the feedback frame, arrows previous / next preset.
*/
import { LabEngine, BODY_UNIFORMS } from './engine/lab.js';
import { createPanel } from './panel.js';
import { createSilhouette } from './silhouette.js';
import { createMjpegStream } from './streams.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const faultBox = $('fault');
function fault(msg) {
  console.error('[lab] ' + msg);
  faultBox.textContent = 'EFFECTS LAB FAULT\n\n' + msg;
  faultBox.style.display = 'block';
  throw new Error(msg);
}
window.addEventListener('error', (e) => { if (faultBox.style.display !== 'block') { faultBox.textContent = 'EFFECTS LAB FAULT\n\n' + (e.message || e); faultBox.style.display = 'block'; } });
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (faultBox.style.display !== 'block') { faultBox.textContent = 'EFFECTS LAB FAULT\n\n' + (r && r.message ? r.message : r); faultBox.style.display = 'block'; } });
let toastTimer = 0;
export function toast(html) { const t = $('toast'); t.innerHTML = html; t.style.opacity = '1'; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2600); }

// ---- landmark tables (edge/body_detector.LANDMARK_NAMES order) ----------------------------
const LANDMARK_NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_eye_inner', 'left_eye_outer',
  'right_eye_inner', 'right_eye_outer', 'mouth_left', 'mouth_right', 'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb',
  'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'];
const JOINTS = {
  head: [0], torso: [5, 6, 11, 12], lwrist: [9], rwrist: [10], lelbow: [7], relbow: [8], lhip: [11], rhip: [12],
  nose: [0], leye: [1], reye: [2], lear: [3], rear: [4], mouth: [21, 22], lshoulder: [5], rshoulder: [6], lknee: [13], rknee: [14], lankle: [15], rankle: [16],
};
const SETS = { core: [5, 6, 11, 12], wrists: [9, 10], head: [0], all: LANDMARK_NAMES.map((_, i) => i) };
const WRISTS = [9, 10];
const BONE_CHAINS = [[5, 7, 9], [6, 8, 10], [11, 13, 15], [12, 14, 16], [5, 6, 12, 11, 5], [3, 18, 1, 17, 0, 19, 2, 20, 4], [21, 22]];
const HAND_CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17]];
export const SOURCES = [
  ['distance', 'Body distance (metres, Body 3D)'], ['shoulder_width', 'Shoulder width (closer = wider)'], ['core_speed', 'Torso speed'],
  ['wrist_speed', 'Wrist speed'], ['head_speed', 'Head speed'], ['all_speed', 'Whole body speed'], ['wrist_height', 'Hands raised'],
  ['spread', 'Arms spread'], ['wrist_near', 'A hand pushed forward'],
].map(([key, label]) => ({ key, label }));

// ---- defaults: a file may lack any of these; nothing faults --------------------------------
const DEFAULTS = {
  current: 'outlines', key_black: 'on',
  sources: Object.fromEntries(SOURCES.map((s) => [s.key, { in: [0, 1], invert: false, smooth: 0.7 }])),
  body: { min_visibility: 0.5, smoothing: 0.35, max_step: 0.25, idle_ms: 1200, z_in: [0.3, -0.5], speed_in: 1.2 },
};
const STAGE_DEFAULTS = {
  // the body as seeds: each part with its own width, colour and alpha; into_frame writes them
  // into the feedback frame (the effect grows from them), off draws them over the screen
  body: {
    draw: 'frame', smooth: 0.7,   // 'frame' = seeds into the feedback each step, 'top' = over the screen, 'takes' = only burned into ring captures
    outline: { on: false, width: 0.005, color: [0.55, 0.85, 1.0], alpha: 0.18 },
    bones: { on: false, width: 0.02, color: [1.0, 0.85, 0.55], alpha: 0.45 },
    hands: { on: false, width: 0.01, color: [0.7, 0.9, 1.0], alpha: 0.5 },
    landmarks: { on: false, hands: false, use: ['left_eye', 'right_eye'], size: 0.015, color: [1.0, 0.9, 0.7], alpha: 0.6, soft: true },
    fill: { alpha: 0, color: [0.55, 0.85, 1.0] },
  },
  camera_behind: false, opacity: 1.0,
  matte: { on: false, feather_in: 0.015, feather_out: 0.04, inside: 1.0, outside: 0.0 },   // the camera's opacity inside and outside the mask
  history: 0, history_every: 0, history_source: 'camera', stamp_every: 0, stamp_fade: 1.0, cam_blur: 12, frame_blur: 24, mask_feather: 0.02, mask_smooth: 0, frame_scale: 1.0, diffuse: 0,
};
function withDefaults(obj, def) {
  const out = Array.isArray(def) ? (Array.isArray(obj) ? obj.slice() : def.slice()) : {};
  if (Array.isArray(def)) return out;
  for (const k of Object.keys(def)) {
    const d = def[k], v = obj ? obj[k] : undefined;
    out[k] = d && typeof d === 'object' && !Array.isArray(d) ? withDefaults(v, d) : (v === undefined ? (Array.isArray(d) ? d.slice() : d) : v);
  }
  if (obj) for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}
function contentPageName() { const m = location.pathname.match(/\/user\/Content\/([^/]+)\//); return m ? decodeURIComponent(m[1]) : null; }
async function fetchJson(file) {
  let r;
  try { r = await fetch('./' + file, { cache: 'no-store' }); } catch (e) { fault(file + ' could not be fetched: ' + e); }
  if (!r.ok) fault(file + ': HTTP ' + r.status);
  try { return await r.json(); } catch (e) { fault(file + ' is not valid JSON: ' + e); }
  return null;
}
function postConfig(file, obj) {
  const page = contentPageName();
  if (!page) { toast('Save needs the TouchFree app behind the page'); return Promise.resolve(false); }
  return fetch('/api/kiosk/content-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page, file, config: obj }) })
    .then((r) => r.json()).then((d) => { if (!d.ok) toast('Save failed: ' + (d.error || 'unknown')); return !!d.ok; })
    .catch((e) => { toast('Save failed<small>' + e + '</small>'); return false; });
}

// ---- state ----------------------------------------------------------------------------------
let cfg = null, presets = null, factory = null, engine = null, panel = null;
/* The presets the page shows: the factory file's (shipped with the code, updated with it)
   under the operator's (presets_config.json, written by Save); an operator entry with the
   same name wins, so edits survive updates and Delete returns a shipped preset to its
   shipped state. */
function mergePresets(op) { return { about: op.about, presets: { ...(factory ? factory.presets : {}), ...(op.presets || {}) } }; }
let current = null, preset = null;            // the loaded preset's name and its working copy
let aspect = 16 / 9, haveBody = false, lastBodyMs = 0, lastTs = 0, pose3d = null, rendererString = '(unknown)';
const body = {}; let hands = {};
const src = {}, raw = {};                     // the sources, smoothed 0..1, and their raw readings
let bodySize = 0.3;                           // tf_size, see feedBody
let hudOn = /[?&]hud=1/.test(location.search);
let panelError = '';
const silhouette = createSilhouette();
/* The two picture streams (streams.js): parsed and decoded by the page, newest frame
   only, nothing queued. The mask stream is the server's default mode (clean; raw was
   steadier on 2026-08-29 only because the filter's motion gate was mis-scaled, fixed
   and re-measured 2026-08-30: clean 0.01 px at rest, raw 0.03). */
const camStream = createMjpegStream('/api/camera/mjpeg', 'camera');   // the content stream: the camera's rate (60/s measured 2026-08-30), mirrored, X-Timestamp on every part. The setup stream is the dashboard's, throttled to 13/s
const maskStream = createMjpegStream('/api/body/mask/mjpeg', 'mask');
let camBound = false, camRetry = 0;

/* How far the mask is behind the landmarks, measured in the page: the mask's centroid x
   (from the tracer) against the torso's x (as it arrives on the WebSocket), the lag that
   fits best over the last three seconds, 0..800 ms. The number Tim sees as "the mask
   jerks half a second behind" made measurable. */
const torsoTrail = [], maskTrail = [];        // [{t, x}], t = performance.now()
function trimTrail(a, now) { while (a.length && now - a[0].t > 3500) a.shift(); }
function maskLag() {
  const now = performance.now(); trimTrail(torsoTrail, now); trimTrail(maskTrail, now);
  if (torsoTrail.length < 20 || maskTrail.length < 20) return null;
  const xAt = (t) => {   // torso x at time t, interpolated
    let lo = 0, hi = torsoTrail.length - 1;
    if (t <= torsoTrail[0].t || t >= torsoTrail[hi].t) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (torsoTrail[mid].t <= t) lo = mid; else hi = mid; }
    const a = torsoTrail[lo], b = torsoTrail[hi]; const k = (t - a.t) / Math.max(1, b.t - a.t);
    return a.x + (b.x - a.x) * k;
  };
  const span = Math.max(...maskTrail.map((m) => m.x)) - Math.min(...maskTrail.map((m) => m.x));
  if (span < 0.02) return { lagMs: null, note: 'no movement to compare' };   // standing still: no lag can be read
  let best = null;
  for (let lag = 0; lag <= 800; lag += 8) {
    let err = 0, n = 0;
    for (const m of maskTrail) { const x = xAt(m.t - lag); if (x === null) continue; err += Math.abs(m.x - x); n++; }
    if (n < 10) continue;
    err /= n;
    if (!best || err < best.err) best = { lagMs: lag, err };
  }
  return best ? { lagMs: best.lagMs, fitPx: +(best.err * 1080).toFixed(1) } : null;
}

function checkGpu() {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) fault('getContext("webgl2") returned null. The Effects Lab needs WebGL 2.');
  const dbg = probe.getExtension('WEBGL_debug_renderer_info');
  rendererString = dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(unknown)';
  if (/swiftshader|llvmpipe|software/i.test(rendererString) && !/[?&]soft=1/.test(location.search)) fault('Software renderer: ' + rendererString);
  probe.getExtension('WEBGL_lose_context')?.loseContext();
}

// ---- the camera and the mask ------------------------------------------------------------------
/* The setup feed produces frames only once a camera profile is bound, and the only thing
   that binds it is GET /api/camera/detect. Right after the server starts that answers 409
   until the camera is up (2026-08-29: the page asked once, got 409, and had no video for
   the whole session), so a failure is retried every two seconds until it succeeds. The
   stream itself reconnects on its own if it drops. */
function openCamera() {
  if (camBound) return;
  clearTimeout(camRetry);
  fetch('/api/camera/detect').then((r) => r.json().then((d) => ({ status: r.status, d }))).then(({ status, d }) => {
    if (!d.ok || !d.detection || d.detection.status !== 'detected') throw new Error((d.error || 'no camera detected') + ' (HTTP ' + status + ')');
    camBound = true; camStream.open();
  }).catch((e) => { toast('Camera: ' + e.message + '<small>trying again in 2 s</small>'); camRetry = setTimeout(openCamera, 2000); });
}

// ---- the body ---------------------------------------------------------------------------------
function onBodyState(ts, payload) {
  if (!payload) return;
  const kps = payload.keypoints || [], fw = payload.frame_w || 0, fh = payload.frame_h || 0;
  pose3d = payload.pose3d || null;
  if (!kps.length || !fw || !fh) { haveBody = false; return; }
  haveBody = true; lastBodyMs = performance.now();
  const dt = lastTs ? Math.max(1, ts - lastTs) / 1000 : 0; lastTs = ts;
  const b = cfg.body;
  { // the torso's x as it arrives, for the mask lag estimate
    let sx = 0, n = 0; for (const i of [5, 6, 11, 12]) { const kp = kps[i]; if (kp && kp[3] >= b.min_visibility) { sx += kp[0] / fw; n++; } }
    if (n) torsoTrail.push({ t: performance.now(), x: sx / n });
  }
  for (let i = 0; i < LANDMARK_NAMES.length; i++) {
    const kp = kps[i];
    // hysteresis: a joint hovering at the threshold must not flip in and out (it snapped the
    // skeleton, the wells and the boil's anchor several times a second, 2026-08-30)
    const v = kp ? kp[3] : 0;
    if (!kp || v < b.min_visibility * 0.7) { if (body[i]) body[i].seen = false; continue; }
    if (body[i] && !body[i].seen && v < b.min_visibility) continue;   // below the enter level: stay out
    const tx = kp[0] / fw, ty = kp[1] / fh, tz = Number.isFinite(kp[2]) ? kp[2] : 0;
    const s = body[i];
    if (!s) { if (v < b.min_visibility) continue; body[i] = { x: tx, y: ty, z: tz, tx, ty, tz, speed: 0, primed: false, seen: true }; continue; }
    s.seen = true;
    const dx = (tx - s.tx) * aspect, dy = ty - s.ty;
    if (Math.abs(tx - s.tx) > b.max_step || Math.abs(ty - s.ty) > b.max_step) { s.x = tx; s.y = ty; s.z = tz; s.speed = 0; s.primed = false; }
    else if (dt > 0) s.speed = s.speed * 0.6 + (Math.sqrt(dx * dx + dy * dy) / dt) * 0.4;
    s.tx = tx; s.ty = ty; s.tz = tz; s.primed = true;
  }
  const h = payload.hands || {}, next = {};
  for (const side of Object.keys(h)) {
    const px = h[side] && h[side].landmarks_px, rw = h[side] && h[side].landmarks_raw;
    if (!px || px.length < 21) continue;
    next[side] = { pts: px.map((p, i) => [p[0] / fw, p[1] / fh, rw && rw[i] ? rw[i][2] : 0]) };
  }
  hands = next;
}
function easeBody() { const k = cfg.body.smoothing; for (const i in body) { const s = body[i]; s.x += (s.tx - s.x) * k; s.y += (s.ty - s.y) * k; s.z += (s.tz - s.z) * k; } }
const vis = (i) => body[i] && body[i].primed && body[i].seen !== false;
function nearness(z) { const [far, near] = cfg.body.z_in; return far === near ? 0 : clamp((far - z) / (far - near), 0, 1); }
function speedNorm(sp) { return clamp(sp / cfg.body.speed_in, 0, 1); }
function setMean(ids) {
  let x = 0, y = 0, z = 0, sp = 0, n = 0;
  for (const i of ids) { const s = body[i]; if (s && s.primed) { x += s.x; y += s.y; z += s.z; sp += s.speed; n++; } }
  return n ? { x: x / n, y: y / n, z: z / n, speed: sp / n, n } : null;
}
function readRaw(key) {
  const speedOf = (k) => { if (!haveBody) return null; const m = setMean(SETS[k]); return m ? m.speed : null; };
  switch (key) {
    case 'distance': return pose3d && pose3d.valid && Number.isFinite(pose3d.distance_m) ? pose3d.distance_m : null;
    case 'shoulder_width': return vis(5) && vis(6) ? Math.hypot((body[5].x - body[6].x) * aspect, body[5].y - body[6].y) : null;
    case 'core_speed': return speedOf('core');
    case 'wrist_speed': return speedOf('wrists');
    case 'head_speed': return speedOf('head');
    case 'all_speed': return speedOf('all');
    case 'wrist_height': { if (!vis(5) || !vis(6)) return null; const ws = WRISTS.filter(vis); if (!ws.length) return null;
      const sh = (body[5].y + body[6].y) / 2; return Math.max(...ws.map((w) => sh - body[w].y)); }
    case 'spread': { if (!vis(9) || !vis(10) || !vis(5) || !vis(6)) return null;
      return Math.abs(body[9].x - body[10].x) / Math.max(0.02, Math.abs(body[5].x - body[6].x)); }
    case 'wrist_near': { const ws = WRISTS.filter(vis); return ws.length ? Math.max(...ws.map((w) => nearness(body[w].z))) : null; }
    default: return null;
  }
}
function updateSources() {
  for (const s of SOURCES) {
    const c = cfg.sources[s.key]; const r = readRaw(s.key); raw[s.key] = r;
    let n = 0;
    if (r !== null && r !== undefined) { const [lo, hi] = c.in; n = hi === lo ? 0 : clamp((r - lo) / (hi - lo), 0, 1); if (c.invert) n = 1 - n; }
    src[s.key] = (src[s.key] || 0) + (n - (src[s.key] || 0)) * (1 - clamp(c.smooth, 0, 0.99));
  }
}
const jointEase = {};     // per joint: held position and eased presence, so nothing snaps
function feedBody() {
  const u = engine.uniforms;
  const dt = Math.min(0.1, 1 / Math.max(20, fps || 60));
  const kPos = 1 - Math.exp(-dt / 0.15);      // the held position follows in ~0.15 s
  const kAnchor = 1 - Math.exp(-dt / 0.4);    // the torso anchor drifts, never jumps (~1 s to settle)
  const kIn = 1 - Math.exp(-dt / 0.12), kOut = 1 - Math.exp(-dt / 0.45);   // influence fades in fast, out slow
  const put = (name, m) => {
    let j = jointEase[name];
    if (!j) j = jointEase[name] = { x: 0.5, y: 0.5, z: 0, v: 0, p: 0, held: false };
    const anchor = name === 'torso';
    if (m) {
      const k = anchor ? kAnchor : kPos;
      if (!j.held) { j.x = m.x; j.y = m.y; }                        // first sighting: no glide across the screen
      else { j.x += (m.x - j.x) * k; j.y += (m.y - j.y) * k; }
      j.z = nearness(m.z); j.v += (speedNorm(m.speed) - j.v) * kPos; j.held = true;
      j.p += (1 - j.p) * kIn;
    } else {
      j.p += (0 - j.p) * kOut; j.v += (0 - j.v) * kOut;             // the position is held where it was
      if (j.p < 0.01) j.held = false;
    }
    u[`tf_${name}_x`] = j.held ? j.x : -10; u[`tf_${name}_y`] = j.held ? j.y : -10;
    u[`tf_${name}_z`] = j.z; u[`tf_${name}_v`] = j.v; u[`tf_${name}_p`] = j.held ? j.p : 0;
  };
  for (const name of Object.keys(JOINTS)) put(name, setMean(JOINTS[name]));
  for (const [name, wi] of [['lhand', 9], ['rhand', 10]]) {
    let m = null;
    for (const side of Object.keys(hands)) { const p = hands[side].pts; if (vis(wi) && Math.hypot((p[0][0] - body[wi].x) * aspect, p[0][1] - body[wi].y) < 0.08) { const w = body[wi]; m = { x: p[9][0], y: p[9][1], z: w.z, speed: w.speed }; } }
    put(name, m);
  }
  const torso = setMean(JOINTS.torso), all = setMean(SETS.all);
  u.tf_present = haveBody ? 1 : 0; u.tf_dist = torso ? nearness(torso.z) : 0; u.tf_speed = all ? speedNorm(all.speed) : 0;
  // tf_size: the body's size on screen, in screen heights: the torso height (shoulders to hips), which does
  // not change when the person turns, unlike the shoulder width. Smoothed, and held when a joint is missing.
  const sh = setMean([5, 6]), hp = setMean([11, 12]);
  if (sh && hp) { const t = Math.hypot((sh.x - hp.x) * aspect, sh.y - hp.y); bodySize += (t - bodySize) * 0.1; }
  u.tf_size = bodySize;
  // the dials bound to sources
  for (const [name, d] of Object.entries(preset ? preset.dials : {})) {
    if (d.bind && d.bind !== 'none' && d.range) { const s = src[d.bind] || 0; setDial(name, d.range[0] + (d.range[1] - d.range[0]) * s); }
    else setDial(name, d.value);
  }
}

// ---- the lines: outline, bones, hands, as chains -------------------------------------------
function curveChain(pts, closed, amount, sub) {
  const n = pts.length; if (amount <= 0 || n < 3) return pts;
  const get = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const spans = closed ? n : n - 1, out = [];
  for (let i = 0; i < spans; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let k = 0; k < sub; k++) {
      const t = k / sub, t2 = t * t, t3 = t2 * t;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const lx = p1.x + (p2.x - p1.x) * t, ly = p1.y + (p2.y - p1.y) * t;
      out.push({ x: lx + (cr(p0.x, p1.x, p2.x, p3.x) - lx) * amount, y: ly + (cr(p0.y, p1.y, p2.y, p3.y) - ly) * amount });
    }
  }
  out.push(closed ? { ...out[0] } : pts[n - 1]);
  return out;
}
function relaxRun(pts, closed, radius, step) {
  const n = pts.length; if (radius < 1 || n < 8) return pts;
  const at = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]); const out = [];
  for (let i = 0; i < n; i += step) { let x = 0, y = 0, c = 0; for (let k = -radius; k <= radius; k++) { const q = at(i + k); x += q.x; y += q.y; c++; } out.push({ x: x / c, y: y / c }); }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
/* The body as seeds for the engine: the outline, bones and hands as chains, the
   landmarks as discs, the mask as a fill. Each part carries its own width,
   colour and alpha from stage.body. Points are handed over y up (the frame
   and the canvas are). */
function buildBody() {
  const B = engine.stage.body, chains = [], discs = [];
  const smooth = clamp(B.smooth || 0, 0, 1);
  const push = (part, pts, closed) => {
    if (pts.length < 2) return;
    const curved = curveChain(pts, closed, smooth, 4);
    const c = part.color || [1, 1, 1];
    const points = curved.map((q) => ({ x: q.x, y: 1 - q.y, w: part.width, r: c[0], g: c[1], b: c[2], a: part.alpha }));
    if (closed && points.length > 2) points.pop();
    chains.push({ points, closed });
  };
  if (B.outline.on) {
    for (const run of silhouette.runs()) push(B.outline, relaxRun(run.pts.map((q) => ({ x: q[0], y: q[1] })), run.closed, Math.round(smooth * 4), Math.max(1, Math.round(smooth * 3))), run.closed);
  }
  if (B.bones.on) {
    for (const ch of BONE_CHAINS) {
      const closed = ch[0] === ch[ch.length - 1]; let run = [];
      const flush = (isClosed) => { if (run.length > 1) push(B.bones, run, isClosed); run = []; };
      for (let k = 0; k < ch.length; k++) { const i = ch[k]; if (!vis(i)) { flush(false); continue; } run.push({ x: body[i].x, y: body[i].y }); }
      if (closed && run.length === ch.length) { run.pop(); flush(true); } else flush(false);
    }
  }
  if (B.hands.on) for (const side of Object.keys(hands)) { const pts = hands[side].pts; for (const ch of HAND_CHAINS) push(B.hands, ch.filter((i) => pts[i]).map((i) => ({ x: pts[i][0], y: pts[i][1] })), false); }
  const L = B.landmarks;
  if (L.on) {
    for (const name of L.use || []) { const i = LANDMARK_NAMES.indexOf(name); if (i >= 0 && vis(i)) discs.push({ x: body[i].x, y: 1 - body[i].y, rad: L.size, a: L.alpha }); }
    if (L.hands) for (const side of Object.keys(hands)) for (const q of hands[side].pts) discs.push({ x: q[0], y: 1 - q[1], rad: L.size * 0.6, a: L.alpha });
  }
  engine.chains = chains;
  engine.discs = discs; engine.discColor = L.color || [1, 1, 1]; engine.discSoft = L.soft !== false;
  engine.fill = { color: B.fill.color || [1, 1, 1], alpha: B.fill.alpha || 0 };
  engine.seedsMode = B.draw || (B.into_frame === false ? 'top' : 'frame');   // into_frame is the old form of this setting
}

// ---- presets ---------------------------------------------------------------------------------
function presetNames() { return Object.keys(presets.presets).sort((a, b) => (a.startsWith('_') ? 1 : 0) - (b.startsWith('_') ? 1 : 0) || a.localeCompare(b)); }
function loadPreset(name) {
  const p = presets.presets[name];
  if (!p) { toast('no preset named ' + name); return false; }
  const copy = JSON.parse(JSON.stringify(p));
  copy.dials = copy.dials || {}; copy.stage = withDefaults(copy.stage, STAGE_DEFAULTS);
  try { engine.setPreset(copy); }
  catch (e) { const msg = String(e && e.message ? e.message : e); panelError = msg; toast('Preset "' + name + '" failed to compile<small>' + msg.split('\n')[0].slice(0, 160) + '</small>'); console.error('[lab] ' + msg); if (panel) panel.setError(msg); return false; }
  current = name; preset = copy; cfg.current = name;
  engine.stage = copy.stage; engine.clear();
  for (const d of Object.values(copy.dials)) if (d.stage && d.stage in copy.stage) d.value = copy.stage[d.stage];   // the stage is the owner; the dial mirrors it
  if (panel) { panel.setError(''); panel.refresh(); }
  toast(name);
  return true;
}
/* The working copy's dials, text and stage, saved under name: only this
   entry is written, into the file as it is on disk. */
async function savePreset(name) {
  name = (name || '').trim(); if (!name || !preset) return false;
  const disk = await fetchJson('presets_config.json');
  disk.presets = disk.presets || {};
  disk.presets[name] = JSON.parse(JSON.stringify({ format: 2, dials: preset.dials, feed: preset.feed, show: preset.show, stage: preset.stage }));
  const ok = await postConfig('presets_config.json', disk);
  if (!ok) return false;
  presets = mergePresets(disk); current = name; cfg.current = name;
  await postConfig('lab_config.json', cfg);
  toast('Saved "' + name + '"');
  if (panel) panel.refresh();
  return true;
}
async function deletePreset(name) {
  const disk = await fetchJson('presets_config.json');
  if (!disk.presets || !disk.presets[name]) return false;
  delete disk.presets[name];
  const ok = await postConfig('presets_config.json', disk);
  if (ok) { presets = mergePresets(disk); if (panel) panel.refresh(); }   // a shipped preset reappears in its shipped state
  return ok;
}
/* A dial may drive a Stage value instead of a shader uniform: its definition carries
   "stage": "<key>" (stamp_every, stamp_fade, ...). The engine's stage is the one owner;
   the dial writes through to it, and loadPreset reads the dial's shown value back from
   the stage so the two can never disagree. */
function setDial(name, v) {
  const d = preset && preset.dials[name];
  if (d && d.stage) { engine.stage[d.stage] = v; return; }
  engine.setDial(name, v);
}
/* Recompile the working copy's text (the panel's Apply). Returns true or the message. */
function applyText() {
  try { engine.setPreset(preset); engine.stage = preset.stage; return true; }
  catch (e) { return String(e && e.message ? e.message : e); }
}
async function reloadFromDisk() {
  factory = await fetchJson('factory_presets.json');
  const p = mergePresets(await fetchJson('presets_config.json')); presets = p;
  const c = withDefaults(await fetchJson('lab_config.json'), DEFAULTS);
  cfg.sources = c.sources; cfg.body = c.body; cfg.key_black = c.key_black; applyKeyBlack();
  if (current && presets.presets[current]) loadPreset(current);
  if (panel) panel.refresh();
  toast('Reloaded from disk');
}

const transparentPage = /[?&]transparent=1/.test(location.search);
function applyKeyBlack() {
  const on = cfg.key_black === 'on' || (cfg.key_black === 'auto' && transparentPage);
  engine.keyBlack = on; document.documentElement.classList.toggle('transparent', on);
}

// ---- the loop -----------------------------------------------------------------------------------
let lastHudMs = 0, noBodySince = 0, fps = 0, frames = 0, lastFpsMs = performance.now();
const bootMs = performance.now(); let lastProbeMs = 0;
/* One line to the console (and so to data/logs/edge_server.log as page[content_profile]):
   [mean, peak] of each buffer, what the body feeds, the fps. Every 2 s for the first
   10 s, then only while the HUD is on. */
function streamStats(s) { const t = s.stats(); return { connected: t.connected, perSec: +t.partsPerSec.toFixed(1), decodeMs: +t.decodeMs.toFixed(1), dropped: t.dropped, lagMs: t.lagMs, size: [t.width, t.height], error: t.error || undefined }; }
function logProbe(now) {
  if (now - lastProbeMs < 2000) return;
  if (now - bootMs > 10000 && !hudOn) return;
  lastProbeMs = now;
  let pr; try { pr = engine.probe(); } catch (e) { pr = { error: String(e) }; }
  console.log('[lab probe] ' + JSON.stringify({ preset: current, fps: +fps.toFixed(0), renderMs: +engine.stats.frameMs.toFixed(1), uploadMs: +engine.stats.uploadMs.toFixed(1), gpuMs: engine.stats.gpu, frame_scale: engine.frameScale, body: haveBody, haveCam: engine.haveCam, haveMask: engine.haveMask,
    window: [window.innerWidth, window.innerHeight, window.devicePixelRatio], chains: engine.chains.length, discs: engine.discs.length, into_frame: engine.seedsIntoFrame,
    stage: { camera_behind: engine.stage.camera_behind, opacity: engine.stage.opacity, matte: engine.stage.matte.on },
    keys: { ...keyLog }, streams: { camera: streamStats(camStream), mask: streamStats(maskStream) }, maskLag: maskLag(), ...pr }));
}
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  if (haveBody && now - lastBodyMs > cfg.body.idle_ms) { haveBody = false; for (const i in body) delete body[i]; hands = {}; pose3d = null; }
  easeBody(); updateSources();
  const camFrame = camStream.take(), maskFrame = maskStream.take();   // the newest decoded frame of each, or null: nothing new
  engine.camImage = camFrame ? camFrame.bitmap : null;
  engine.maskImage = maskFrame ? maskFrame.bitmap : null;
  if (maskFrame) { silhouette.sample(maskFrame.bitmap); const ms = silhouette.stats(); if (ms.live && ms.area > 0.002) maskTrail.push({ t: now, x: ms.cx }); }
  feedBody(); buildBody();
  // the background: captured once nobody has been in view for 1.5 s
  if (!haveBody) { if (!noBodySince) noBodySince = now; else if (now - noBodySince > 1500 && !engine.captured) engine.captureBackground(); }
  else noBodySince = 0;
  try { engine.render(); } catch (e) { console.error('[lab] render: ' + (e && e.message ? e.message : e)); }
  logProbe(now);
  if (panel && panel.visible()) panel.drawViews();
  frames++; if (now - lastFpsMs >= 1000) { fps = frames * 1000 / (now - lastFpsMs); frames = 0; lastFpsMs = now; }
  if (hudOn && now - lastHudMs > 250) {
    lastHudMs = now;
    $('hud').textContent = `fps ${fps.toFixed(0)}  frame ${engine.stats.frameMs.toFixed(2)} ms  preset ${current}\n` +
      `body ${haveBody ? Object.keys(body).length + ' pts' : 'none'}  cam ${engine.haveCam ? 'yes' : 'no'}  mask ${engine.haveMask ? 'yes' : 'no'}  background ${engine.captured ? 'captured' : 'not yet'}\n` +
      `sources ${SOURCES.filter((s) => src[s.key] > 0.001).map((s) => `${s.key} ${src[s.key].toFixed(2)}`).join('  ') || '-'}\n${rendererString}`;
  }
}

const keyLog = { count: 0, last: '', handled: '' };   // what reaches the page: read it in the probe line
function onKey(e) {
  keyLog.count++; keyLog.last = e.key + (e.target && e.target.tagName ? '@' + e.target.tagName : '');
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  const names = presetNames(), at = names.indexOf(current);
  if (e.key === 'ArrowRight') { keyLog.handled = 'next: ' + names[(at + 1) % names.length]; loadPreset(names[(at + 1) % names.length]); return; }
  if (e.key === 'ArrowLeft') { keyLog.handled = 'prev: ' + names[(at - 1 + names.length) % names.length]; loadPreset(names[(at - 1 + names.length) % names.length]); return; }
  if (k === 'g') { panel.toggle(); $('g').style.opacity = panel.visible() ? '0' : '1'; return; }
  if (k === 'h') { hudOn = !hudOn; $('hud').style.display = hudOn ? 'block' : 'none'; return; }
  if (k === 'r') { reloadFromDisk(); return; }
  if (k === 'b') { engine.captureBackground(); toast('Background captured'); return; }
  if (k === 'c') { engine.clear(); return; }
}

const api = {
  cfg: () => cfg, presets: () => presets, presetNames, current: () => current, preset: () => preset,
  loadPreset, savePreset, deletePreset, applyText, reloadFromDisk, setDial,
  sources: () => ({ src, raw }), SOURCES,
  engine: () => engine, fxCanvas: () => $('fx'),
  applyKeyBlack, saveConfig: () => postConfig('lab_config.json', cfg).then((ok) => { if (ok) toast('Saved lab_config.json'); return ok; }),
  status: () => ({ fps, body: haveBody, cam: engine.haveCam, mask: engine.haveMask, renderMs: engine.stats.frameMs, gpu: rendererString, streams: { camera: streamStats(camStream), mask: streamStats(maskStream) }, maskLag: maskLag() }),
  templateFrom: (name) => JSON.parse(JSON.stringify(presets.presets[name] || presets.presets.outlines)),
  LANDMARKS: LANDMARK_NAMES,
  setWorking: (p) => { preset = p; },
};

(async function boot() {
  checkGpu();
  cfg = withDefaults(await fetchJson('lab_config.json'), DEFAULTS);
  factory = await fetchJson('factory_presets.json');
  presets = mergePresets(await fetchJson('presets_config.json'));
  if (!presets.presets || !Object.keys(presets.presets).length) fault('presets_config.json has no presets');
  const canvas = $('fx');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight; aspect = canvas.width / canvas.height;
  engine = new LabEngine(canvas);
  window.addEventListener('resize', () => { engine.setSize(window.innerWidth, window.innerHeight); aspect = window.innerWidth / window.innerHeight; });
  applyKeyBlack();
  if (!loadPreset(cfg.current in presets.presets ? cfg.current : presetNames()[0]) && !loadPreset('outlines')) fault('no preset compiles; the compiler said: ' + panelError);
  panel = createPanel({ root: $('panel'), api });
  window.addEventListener('keydown', onKey);
  if (hudOn) $('hud').style.display = 'block';
  openCamera(); maskStream.open();
  (function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.type === 'body_state') onBodyState(m.ts, m.payload); else if (m.type === 'camera_setup_state' && panel) panel.onCameraState(m.payload); };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => { try { ws.close(); } catch (e) { /* closing */ } };
  })();
  requestAnimationFrame(frame);
})();

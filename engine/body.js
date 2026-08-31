/*
The body in the frame: bones, fingers, face contours and the silhouette
outline as RIBBONS with per-point width, colour and alpha, drawn into the
feedback buffer after the warp. Each segment is a quad with its own width
at each end (nearer = wider, from z) and its own alpha (faster = brighter,
from speed). This is the seed the preset's warp and shaders grow from.

Round ends (2026-08-28, Tim: one solid line with curves, not square ends):
a segment whose end is flagged as a cap is extended by half its width past
the point, and the fragment shader draws the distance to the segment's
centreline as a capsule, so the end is a semicircle and the edge is
anti-aliased. Which ends get a cap is the page's call: the two ends of an
open chain, and, on a chain that is not curve-smoothed, one side of every
interior joint so a bend has no notch. A smoothed chain is dense enough
that its interior joints need none, and giving them caps would bead the
line under additive blending.

Segments arrive in screen fractions (x right, y down); the buffer is
vertically flipped relative to the screen and the composite pass unflips
it, so a screen point (sx, sy) sits at clip ((sx - 0.5) * 2, (sy - 0.5) * 2)
in the buffer. Widths are fractions of screen height.
*/
import { compileProgram, floatPrecision } from './gl.js';

export class BodyPass {
  constructor(gl) {
    this.gl = gl;
    const p = floatPrecision(gl);
    this.prog = compileProgram(gl, `#version 300 es
in vec2 aPos; in vec4 aColor; in vec2 aLocal; in vec3 aGeom;
out vec4 vColor; out vec2 vLocal; out vec3 vGeom;
void main(void) { vColor = aColor; vLocal = aLocal; vGeom = aGeom; gl_Position = vec4(aPos, 0.0, 1.0); }`,
    `#version 300 es
precision ${p} float;
in vec4 vColor; in vec2 vLocal; in vec3 vGeom; out vec4 fragColor;
void main(void) {
  // vLocal: (t along the segment, s across it), pixels. vGeom: (half width
  // at the start, half width at the end, length), pixels.
  float t = vLocal.x, s = vLocal.y, hw0 = vGeom.x, hw1 = vGeom.y, L = max(vGeom.z, 0.0001);
  float d, hw;
  if (t < 0.0)      { d = length(vec2(t, s));     hw = hw0; }
  else if (t > L)   { d = length(vec2(t - L, s)); hw = hw1; }
  else              { d = abs(s);                 hw = mix(hw0, hw1, t / L); }
  float a = 1.0 - smoothstep(hw - 0.75, hw + 0.75, d);
  if (a <= 0.0) discard;
  fragColor = vec4(vColor.rgb, vColor.a * a);
}`, 'body ribbon');
    this.aPos = gl.getAttribLocation(this.prog, 'aPos');
    this.aCol = gl.getAttribLocation(this.prog, 'aColor');
    this.aLoc = gl.getAttribLocation(this.prog, 'aLocal');
    this.aGeo = gl.getAttribLocation(this.prog, 'aGeom');
    this.posBuf = gl.createBuffer();
    this.colBuf = gl.createBuffer();
    this.locBuf = gl.createBuffer();
    this.geoBuf = gl.createBuffer();
    this.cap = 0;
  }

  /* chains: [{points: [{x, y, w, r, g, b, a}], closed}], one CONTINUOUS line
     each: every point has one shared pair of edge vertices on the mitred
     normal, so consecutive pieces share their edges and a bend has no
     crack and no double-drawn overlap. Round caps at the two ends of an
     open chain. Widths in screen-height fractions; W, H in pixels. */
  drawChains(chains, W, H, additive) {
    let total = 0;
    for (const c of chains) if (c.points.length > 1) total += (c.points.length + (c.closed ? 1 : 0)) * 6 + 12;
    if (!total) return;
    const gl = this.gl;
    if (this.cap < total) {
      this.cap = total;
      this.pos = new Float32Array(total * 2);
      this.col = new Float32Array(total * 4);
      this.loc = new Float32Array(total * 2);
      this.geo = new Float32Array(total * 3);
    }
    let pi = 0, ci = 0, li = 0, gi = 0;
    const put = (px, py, t, sAcross, q, h0, h1, len) => {
      this.pos[pi++] = (px / W) * 2 - 1; this.pos[pi++] = (py / H) * 2 - 1;
      this.col[ci++] = q.r; this.col[ci++] = q.g; this.col[ci++] = q.b; this.col[ci++] = q.a;
      this.loc[li++] = t; this.loc[li++] = sAcross;
      this.geo[gi++] = h0; this.geo[gi++] = h1; this.geo[gi++] = len;
    };
    for (const c of chains) {
      const src = c.points;
      const n = src.length;
      if (n < 2) continue;
      // pixels, and drop points that sit on top of the previous one
      const P = [];
      for (let i = 0; i < n; i++) {
        const x = src[i].x * W, y = src[i].y * H;
        if (P.length && Math.hypot(x - P[P.length - 1].x, y - P[P.length - 1].y) < 0.25) continue;
        P.push({ x, y, hw: src[i].w * H * 0.5, q: src[i] });
      }
      if (c.closed && P.length > 2 && Math.hypot(P[0].x - P[P.length - 1].x, P[0].y - P[P.length - 1].y) < 0.25) P.pop();
      const m = P.length;
      if (m < 2) continue;
      // the edge vertices: at each point, the mitre of the two adjacent
      // segment normals, its length limited so a sharp bend does not spike
      const L = [], R = [];
      for (let i = 0; i < m; i++) {
        const hasPrev = c.closed || i > 0, hasNext = c.closed || i < m - 1;
        const a = P[hasPrev ? (i - 1 + m) % m : i], b = P[i], d = P[hasNext ? (i + 1) % m : i];
        let n1x = 0, n1y = 0, n2x = 0, n2y = 0;
        if (hasPrev) { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; n1x = -dy / l; n1y = dx / l; }
        if (hasNext) { const dx = d.x - b.x, dy = d.y - b.y, l = Math.hypot(dx, dy) || 1; n2x = -dy / l; n2y = dx / l; }
        if (!hasPrev) { n1x = n2x; n1y = n2y; }
        if (!hasNext) { n2x = n1x; n2y = n1y; }
        let mx = n1x + n2x, my = n1y + n2y;
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) { mx = n1x; my = n1y; } else { mx /= ml; my /= ml; }
        const cosHalf = Math.max(0.5, mx * n1x + my * n1y);     // limit the mitre to 2x the width
        const g = (b.hw + 1) / cosHalf;                          // + the anti-aliasing margin
        L.push({ x: b.x + mx * g, y: b.y + my * g });
        R.push({ x: b.x - mx * g, y: b.y - my * g });
      }
      // the strip: two triangles per span; s runs across, t sits mid-segment
      const spans = c.closed ? m : m - 1;
      for (let i = 0; i < spans; i++) {
        const j = (i + 1) % m;
        const A = P[i], B = P[j];
        const gA = A.hw + 1, gB = B.hw + 1;
        put(L[i].x, L[i].y, 0.5, gA, A.q, A.hw, A.hw, 1);
        put(R[i].x, R[i].y, 0.5, -gA, A.q, A.hw, A.hw, 1);
        put(L[j].x, L[j].y, 0.5, gB, B.q, B.hw, B.hw, 1);
        put(R[i].x, R[i].y, 0.5, -gA, A.q, A.hw, A.hw, 1);
        put(R[j].x, R[j].y, 0.5, -gB, B.q, B.hw, B.hw, 1);
        put(L[j].x, L[j].y, 0.5, gB, B.q, B.hw, B.hw, 1);
      }
      // round caps at the two ends of an open chain: a capsule quad past each end
      if (!c.closed) {
        for (const [idx, other] of [[0, 1], [m - 1, m - 2]]) {
          const E = P[idx], O = P[other];
          let ux = E.x - O.x, uy = E.y - O.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
          const nx = -uy, ny = ux, g = E.hw + 1;
          // local frame: t from 0 at the point outward to g (the cap branch of the shader, t < 0)
          const ax = E.x, ay = E.y, bx = E.x + ux * g, by = E.y + uy * g;
          put(ax + nx * g, ay + ny * g, 0, g, E.q, E.hw, E.hw, 1);
          put(ax - nx * g, ay - ny * g, 0, -g, E.q, E.hw, E.hw, 1);
          put(bx + nx * g, by + ny * g, -g, g, E.q, E.hw, E.hw, 1);
          put(ax - nx * g, ay - ny * g, 0, -g, E.q, E.hw, E.hw, 1);
          put(bx - nx * g, by - ny * g, -g, -g, E.q, E.hw, E.hw, 1);
          put(bx + nx * g, by + ny * g, -g, g, E.q, E.hw, E.hw, 1);
        }
      }
    }
    this._flush(pi, ci, li, gi, additive);
  }

  _flush(pi, ci, li, gi, additive) {
    const gl = this.gl;
    const count = pi / 2;
    if (!count) return;
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.pos.subarray(0, pi), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(this.aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.col.subarray(0, ci), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.aCol, 4, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(this.aCol);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.locBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.loc.subarray(0, li), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.aLoc, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(this.aLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.geo.subarray(0, gi), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.aGeo, 3, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(this.aGeo);
    gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  /* segments: [{x0, y0, x1, y1, w0, w1, r, g, b, a, cap0?, cap1?}], width in
     screen-height fractions, cap0/cap1 = round end at the start/end; W, H
     the buffer size in pixels. */
  draw(segments, W, H, additive) {
    if (!segments.length) return;
    const gl = this.gl;
    const n = segments.length * 6;
    if (this.cap < n) {
      this.cap = n;
      this.pos = new Float32Array(n * 2);
      this.col = new Float32Array(n * 4);
      this.loc = new Float32Array(n * 2);
      this.geo = new Float32Array(n * 3);
    }
    let pi = 0, ci = 0, li = 0, gi = 0;
    const put = (px, py, t, sAcross, s, h0, h1, len) => {
      this.pos[pi++] = (px / W) * 2 - 1; this.pos[pi++] = (py / H) * 2 - 1;
      this.col[ci++] = s.r; this.col[ci++] = s.g; this.col[ci++] = s.b; this.col[ci++] = s.a;
      this.loc[li++] = t; this.loc[li++] = sAcross;
      this.geo[gi++] = h0; this.geo[gi++] = h1; this.geo[gi++] = len;
    };
    for (const s of segments) {
      const x0 = s.x0 * W, y0 = s.y0 * H, x1 = s.x1 * W, y1 = s.y1 * H;
      const dxp = x1 - x0, dyp = y1 - y0;
      const len = Math.hypot(dxp, dyp);
      if (len < 0.25) continue;
      const ux = dxp / len, uy = dyp / len;         // along
      const nx = -uy, ny = ux;                      // across
      const h0 = s.w0 * H * 0.5, h1 = s.w1 * H * 0.5;
      // the quad reaches past a capped end by its half width, so the
      // semicircle has room; the extra pixel keeps the anti-aliasing inside
      const e0 = s.cap0 ? h0 + 1 : 0, e1 = s.cap1 ? h1 + 1 : 0;
      const g0 = h0 + 1, g1 = h1 + 1;               // across, with the anti-aliasing margin
      const ax = x0 - ux * e0, ay = y0 - uy * e0, bx = x1 + ux * e1, by = y1 + uy * e1;
      // corners: start +/- across, end +/- across
      put(ax + nx * g0, ay + ny * g0, -e0, g0, s, h0, h1, len);
      put(ax - nx * g0, ay - ny * g0, -e0, -g0, s, h0, h1, len);
      put(bx + nx * g1, by + ny * g1, len + e1, g1, s, h0, h1, len);
      put(ax - nx * g0, ay - ny * g0, -e0, -g0, s, h0, h1, len);
      put(bx - nx * g1, by - ny * g1, len + e1, -g1, s, h0, h1, len);
      put(bx + nx * g1, by + ny * g1, len + e1, g1, s, h0, h1, len);
    }
    this._flush(pi, ci, li, gi, additive);
  }
}

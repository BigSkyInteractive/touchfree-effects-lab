/*
The body silhouette as a path: the server's body mask stream
(/api/body/mask/mjpeg, docs/V6/V6_BODY_DATA_PIPELINE.md section 7c) traced
into one closed outline, in the page's screen fractions, for the waves to
plot in place of the skeleton walk (Tim, 2026-08-26: use the silhouette
mask as the waveform instead of the landmarks and skeleton).

THE CONNECTION IS THE REQUEST: opening the stream is what makes the pose
model produce masks, and the landmarker is rebuilt when a consumer arrives
or leaves (about 120 ms, once). So the stream is open only while the wave
source is the silhouette.

The mask arrives as PNG frames at capture resolution, 0 background, 255
person, in the UNMIRRORED sensor frame (the landmarks are mirrored at the
reporting layer; the mask is not), so x is flipped here to land on the
person the way the landmarks do. It is sampled into a small canvas, held at
128, and the outline traced with Moore neighbour tracing, clockwise, the
person kept on the right. Specks are skipped by starting only from a pixel
with a full neighbourhood.

Liveness is never read from the <img>'s load event (it does not fire for a
hidden element); the page gates on body_state presence instead.
*/

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];   // E, SE, S, SW, W, NW, N, NE

export function createSilhouette({ width = 192, height = 108 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = width + 2, H = height + 2;               // one pixel of padding all round
  const grid = new Uint8Array(W * H);
  let lastPts = [];
  let lastRuns = [];        // the outline split where it meets the frame's edge
  let stats = { live: false, area: 0, points: 0, cx: 0.5, cy: 0.5 };   // cx, cy: the mask's centroid, mirrored screen fractions

  /* The outline as [[x, y], ...] in mirrored screen fractions, closed
     (the first point repeated at the end), or [] when there is no mask or
     no person in it. */
  /* src: the decoded mask frame (an ImageBitmap from streams.js). */
  function sample(src) {
    const s = src;
    if (!s || !(s.width || s.naturalWidth)) { stats.live = false; return []; }
    // Each new mask frame is blended into the previous ones (35% new), so
    // the traced edge does not shiver with the mask's pixel-level wobble
    // (Tim, 2026-08-28: the jittering outline was nausea-inducing).
    ctx.globalAlpha = 0.35;
    try { ctx.drawImage(s, 0, 0, width, height); }
    catch (e) { ctx.globalAlpha = 1; return lastPts; }   // a frame mid-decode: keep the last outline
    ctx.globalAlpha = 1;
    const px = ctx.getImageData(0, 0, width, height).data;
    grid.fill(0);
    let area = 0, accX = 0, accY = 0;
    for (let y = 0; y < height; y++) {
      const row = (y + 1) * W + 1;
      const src = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (px[src + x * 4] > 127) { grid[row + x] = 1; area++; accX += x; accY += y; }
      }
    }
    stats.live = true;
    stats.area = area / (width * height);
    if (area) { stats.cx = 1 - (accX / area + 0.5) / width; stats.cy = (accY / area + 0.5) / height; }   // mirrored, like the outline
    if (area < width * height * 0.002) { stats.points = 0; lastPts = []; return lastPts; }

    // Start: the first pixel in raster order whose 3x3 neighbourhood is
    // full enough to be the body and not a speck.
    let sx = -1, sy = -1;
    outer: for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (!grid[y * W + x]) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += grid[(y + dy) * W + x + dx];
        if (n >= 5) { sx = x; sy = y; break outer; }
      }
    }
    if (sx < 0) { stats.points = 0; lastPts = []; return lastPts; }

    // Moore neighbour tracing, clockwise. Arriving in direction d, search
    // from d + 6 (a quarter turn back) clockwise; the object stays on the
    // right. Stops on returning to the start pixel with the same first
    // move (Jacob's criterion), or at a hard cap.
    const pts = [];
    let cx = sx, cy = sy, d = 0, firstMove = -1;
    const cap = 4 * (width + height) * 4;
    for (let steps = 0; steps < cap; steps++) {
      pts.push([1 - (cx - 0.5) / width, (cy - 0.5) / height, cx, cy]);   // mirrored x; padding removed; grid coords kept for the border test
      let found = -1;
      for (let k = 0; k < 8; k++) {
        const nd = (d + 6 + k) % 8;
        const nx = cx + DIRS[nd][0], ny = cy + DIRS[nd][1];
        if (grid[ny * W + nx]) { found = nd; break; }
      }
      if (found < 0) break;                          // an isolated pixel
      if (firstMove < 0) firstMove = found;
      else if (cx === sx && cy === sy && found === firstMove) break;
      cx += DIRS[found][0]; cy += DIRS[found][1]; d = found;
    }
    // The outline split at the frame's edge: a point on the border is the
    // picture's edge, not the body's, so the line stops there and the body
    // reads as continuing outside the frame (Tim, 2026-08-28). A loop that
    // never touches the border stays one closed run.
    const onBorder = (i) => {
      const x = pts[i][2], y = pts[i][3];
      return x <= 1 || x >= width || y <= 1 || y >= height;
    };
    const runs = [];
    if (pts.length > 2) {
      const n = pts.length;
      let anyBorder = false;
      for (let i = 0; i < n; i++) if (onBorder(i)) { anyBorder = true; break; }
      if (!anyBorder) runs.push({ pts: pts.map((q) => [q[0], q[1]]), closed: true });
      else {
        // start after a border point so no run wraps across the seam
        let start = 0;
        while (start < n && !onBorder(start)) start++;
        let run = [];
        for (let k = 1; k <= n; k++) {
          const i = (start + k) % n;
          if (onBorder(i)) { if (run.length > 1) runs.push({ pts: run, closed: false }); run = []; }
          else run.push([pts[i][0], pts[i][1]]);
        }
        if (run.length > 1) runs.push({ pts: run, closed: false });
      }
    }
    lastRuns = runs;
    if (pts.length > 2) pts.push(pts[0]);
    stats.points = pts.length;
    lastPts = pts.map((q) => [q[0], q[1]]);
    return lastPts;
  }
  /* The outline as runs: [{pts: [[x, y], ...], closed}], split at the frame's edge. */
  function runsOut() { return lastRuns; }

  return { sample, runs: runsOut, stats: () => stats };
}

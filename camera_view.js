/*
The camera view in the Effect Controls panel: the setup MJPEG feed with the
landmarks drawn over it EXACTLY as the dashboard's Camera View pane draws
them (ui/js/camera_setup_overlay.js): the same edge tables, the same
colours, the same line widths and dot radii, the same visibility gate, the
same face mesh dots and the same tracking box. The overlay draws in frame
pixels on a canvas the size of the frame and lets CSS scale it; this view
draws into a fitted canvas through a scale transform, which scales every
width and radius the same way CSS would. Change one, change the other (Tim,
2026-08-26: "same colour, same sizes").

ONE addition to the pane's drawing: the pose model's eleven head points
(nose, eyes, ears, mouth) ARE drawn here, in the body's cyan, as points
only, not joined (Tim, 2026-08-26: the view must show the body's face
landmarks, the pane leaves them out on purpose; 2026-08-28: no lines
between them). The 478-point face mesh is drawn as well when Face
expression is on. The standing circle and vignette are framing aids of
the setup pane and are not drawn here.

The feed is consumer-gated on the server: opening /api/camera/setup/mjpeg is
what switches the setup encode on and what makes camera_setup_state start
arriving, and closing it switches both off. So the view opens the feed only
while the panel is visible and drops it when the panel closes.

camera_setup_state carries body_keypoints_px ([x, y, visibility] x 33),
hands_px (both hands, by side), hand_landmarks_px (the hand-control hand),
face_landmarks_px (478) and roi, all in the FRAME's mirrored pixel space,
null where the camera could not see a point. The MJPEG may decode at
another size, so the landmarks are scaled by frame_w -> naturalWidth.
*/

// ---- verbatim from ui/js/camera_setup_overlay.js ----------------------------
// Every body landmark, the head points included (the pane filters
// FACE_POINTS out; this view does not).
const BODY_INDICES = Array.from({ length: 33 }, (_, i) => i);
const BODY_EDGES = [
  [5, 6], [5, 11], [6, 12], [11, 12],         // torso
  [5, 7], [7, 9],                             // left arm
  [6, 8], [8, 10],                            // right arm
  [11, 13], [13, 15],                         // left leg
  [12, 14], [14, 16],                         // right leg
  [9, 23], [9, 25], [9, 27], [23, 25],        // left palm
  [10, 24], [10, 26], [10, 28], [24, 26],     // right palm
  [15, 29], [29, 31], [15, 31],               // left foot
  [16, 30], [30, 32], [16, 32],               // right foot
  // the head's landmarks are drawn as points only, never joined (Tim, 2026-08-28)
];
const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];
const HAND_TIPS = new Set([4, 8, 12, 16, 20]);
const VIS_MIN = 0.3;

function drawBodySkeleton(ctx, kp) {
  ctx.strokeStyle = 'rgba(0, 220, 255, 0.85)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const [a, b] of BODY_EDGES) {
    const ka = kp[a], kb = kp[b];
    if (!ka || !kb) continue;
    if (ka[2] < VIS_MIN || kb[2] < VIS_MIN) continue;
    ctx.moveTo(ka[0], ka[1]);
    ctx.lineTo(kb[0], kb[1]);
  }
  ctx.stroke();
}

function drawBodyLandmarks(ctx, kp) {
  ctx.fillStyle = 'rgba(0, 220, 255, 0.95)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 1;
  for (const i of BODY_INDICES) {
    const k = kp[i];
    if (!k || k[2] < VIS_MIN) continue;
    ctx.beginPath();
    ctx.arc(k[0], k[1], 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawHandSkeleton(ctx, lm) {
  ctx.strokeStyle = 'rgba(255, 165, 60, 0.9)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const [a, b] of HAND_EDGES) {
    const la = lm[a], lb = lm[b];
    if (!la || !lb) continue;
    ctx.moveTo(la[0], la[1]);
    ctx.lineTo(lb[0], lb[1]);
  }
  ctx.stroke();
}

function drawHandLandmarks(ctx, lm) {
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 1;
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    if (!p) continue;
    let r = 4;
    let fill = 'rgba(255, 200, 100, 0.95)';
    if (i === 0) { r = 7; fill = 'rgba(255, 230, 130, 1)'; }
    else if (HAND_TIPS.has(i)) { r = 6; fill = 'rgba(255, 220, 110, 1)'; }
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawFaceMesh(ctx, lm) {
  ctx.fillStyle = 'rgba(90, 220, 200, 0.85)';
  const r = 1.4;
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRoi(ctx, r, activeHand) {
  if (!r || r.w <= 0 || r.h <= 0) return;
  const tracking = (r.mode === 'tracking');
  ctx.strokeStyle = tracking ? 'rgba(0, 255, 80, 0.9)' : 'rgba(255, 200, 0, 0.85)';
  ctx.lineWidth = 4;
  ctx.setLineDash(tracking ? [] : [12, 8]);
  ctx.beginPath();
  ctx.roundRect(r.x1, r.y1, r.w, r.h, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  const label = (activeHand && activeHand !== 'none') ? activeHand.toUpperCase() : null;
  if (label) {
    const fontSize = 28;
    ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
    const padX = 12, padY = 6;
    const textW = ctx.measureText(label).width;
    const boxW = textW + padX * 2;
    const boxH = fontSize + padY * 2;
    const bx = r.x1 + 8;
    const by = r.y1 + 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.fillStyle = tracking ? 'rgb(0, 255, 80)' : 'rgb(255, 200, 0)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, bx + padX, by + padY + fontSize - 6);
  }
}
// ---- end of the overlay's drawing -------------------------------------------

export function createCameraView(canvas, statusEl) {
  const ctx = canvas.getContext('2d');
  let feedImg = null, pendingFeed = null;
  let lastFrameMs = 0;
  let setup = null;
  let open = false;
  let bound = false;    // /api/camera/detect said a camera is bound
  let bindError = '';
  let watchdog = 0;

  function newFeed() {
    const img = new Image();
    img.onload = () => {
      lastFrameMs = Date.now();
      if (pendingFeed === img) { feedImg = img; pendingFeed = null; }
    };
    img.onerror = () => { if (pendingFeed === img) pendingFeed = null; };
    img.src = '/api/camera/setup/mjpeg?t=' + Date.now();
    return img;
  }

  function openFeed() {
    if (open) return;
    open = true;
    // The setup feed produces frames only once a camera profile is bound,
    // and the ONLY thing that binds it is GET /api/camera/detect
    // (edge/server.py, pipeline.set_setup_profile in the detect handler).
    bound = false; bindError = '';
    fetch('/api/camera/detect')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error || 'camera detection failed');
        if (!d.detection || d.detection.status !== 'detected') throw new Error('no camera was detected');
        bound = true;
        if (open) feedImg = pendingFeed = newFeed();
      })
      .catch((e) => { bindError = String(e && e.message ? e.message : e); console.error('[camera view] ' + bindError); });
    watchdog = setInterval(() => {
      // Three seconds, and only when nothing is already on its way in. A
      // reconnect costs a stream teardown, so it is a last resort, not a tick.
      if (!open || !bound || pendingFeed) return;
      if (Date.now() - lastFrameMs > 3000) pendingFeed = newFeed();
    }, 1000);
  }

  function closeFeed() {
    if (!open) return;
    open = false;
    clearInterval(watchdog);
    for (const img of [feedImg, pendingFeed]) if (img) { img.onload = null; img.onerror = null; img.src = ''; }
    feedImg = pendingFeed = null;
    setup = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function onState(payload) {
    setup = payload;
    lastFrameMs = Date.now();     // same gate and throttle as the JPEG
  }

  function draw() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const live = feedImg && feedImg.naturalWidth > 0 && Date.now() - lastFrameMs < 3000;
    if (statusEl) {
      statusEl.textContent = !open ? 'camera: closed'
        : live ? `camera: ${feedImg.naturalWidth}x${feedImg.naturalHeight}` +
                 (setup && setup.body_keypoints_px && setup.body_keypoints_px.length ? ' · body' : ' · no body')
        : bindError ? 'camera: ' + bindError
        : bound ? 'camera: profile bound, waiting for frames'
        : 'camera: asking /api/camera/detect (needs the TouchFree app)';
    }
    if (!live) return;
    const fw = feedImg.naturalWidth, fh = feedImg.naturalHeight;
    const s = Math.min(W / fw, H / fh);
    const dw = fw * s, dh = fh * s;
    const dx = (W - dw) / 2, dy = (H - dh) / 2;
    try { ctx.drawImage(feedImg, 0, 0, fw, fh, dx, dy, dw, dh); }
    catch (e) { return; }      // a frame mid-decode: keep the last good one
    if (!setup) return;
    // Draw in the frame's own pixel space, scaled onto the fitted picture,
    // so every width and radius above matches the Camera View pane.
    const k = setup.frame_w ? fw / setup.frame_w : 1;
    ctx.setTransform(s * k, 0, 0, s * k, dx, dy);
    const kp = setup.body_keypoints_px;
    if (kp && kp.length > 0) { drawBodySkeleton(ctx, kp); drawBodyLandmarks(ctx, kp); }
    if (setup.hands_px) {
      for (const side of Object.keys(setup.hands_px)) {
        const lm = setup.hands_px[side];
        if (lm && lm.length === 21) { drawHandSkeleton(ctx, lm); drawHandLandmarks(ctx, lm); }
      }
    }
    if (setup.hand_landmarks_px && setup.hand_landmarks_px.length === 21) {
      drawHandSkeleton(ctx, setup.hand_landmarks_px); drawHandLandmarks(ctx, setup.hand_landmarks_px);
    }
    if (setup.face_landmarks_px && setup.face_landmarks_px.length > 0) drawFaceMesh(ctx, setup.face_landmarks_px);
    if (setup.roi && (setup.roi.mode === 'tracking' || setup.roi.mode === 'lost')) drawRoi(ctx, setup.roi, setup.active_hand);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return { open: openFeed, close: closeFeed, onState, draw, isOpen: () => open };
}

/*
The Effects Lab panel: two tabs.

  Look    the loaded preset's dials (a slider and a number each, with the
          body source it is bound to and the range), the preset list with
          Save / Save as / New from template / Delete, and a Text button
          that opens the two GLSL bodies for authoring, with Apply and the
          compiler's message.
  Stage   what of the body is drawn as lines, the layers (camera behind,
          matte, opacity), the buffers (history, stamps, blurs, mask
          smoothing), black-as-transparency, and the sources' live readings.

Nothing here is a control the loaded preset did not declare.
*/
import { createCameraView } from './camera_view.js';

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function button(label, onClick, cls) { const b = el('button', cls || '', label); b.type = 'button'; b.addEventListener('click', onClick); return b; }
function check(get, set, label) {
  const l = el('label', 'chk'); const c = el('input'); c.type = 'checkbox'; c.checked = !!get();
  c.addEventListener('change', () => set(c.checked)); l.append(c, document.createTextNode(label || ''));
  l.refresh = () => { c.checked = !!get(); }; return l;
}
function number(get, set, { min = 0, max = 1, step = 0.01, width, slider = false } = {}) {
  const n = el('input'); n.type = 'number'; n.step = String(step); n.min = String(min); n.max = String(max); n.value = String(get());
  if (width) n.style.width = width;
  n.addEventListener('keydown', (e) => e.stopPropagation());
  const fmt = (v) => String(Number(v).toFixed(6)).replace(/\.?0+$/, '');
  if (!slider) {
    n.addEventListener('input', () => { const v = Number(n.value); if (Number.isFinite(v)) set(v); });
    n.refresh = () => { if (document.activeElement !== n) n.value = fmt(get()); }; return n;
  }
  // a slider and the number, one value
  const wrap = el('span', 'sn'); const r = el('input'); r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(get());
  r.addEventListener('input', () => { const v = Number(r.value); set(v); n.value = fmt(v); });
  n.addEventListener('input', () => { const v = Number(n.value); if (Number.isFinite(v)) { set(v); r.value = String(v); } });
  wrap.append(r, n);
  wrap.refresh = () => { if (document.activeElement !== n) n.value = fmt(get()); if (document.activeElement !== r) r.value = String(get()); }; return wrap;
}
const snum = (get, set, opts) => number(get, set, { ...(opts || {}), slider: true });
function select(options, get, set, labels) {
  const s = el('select'); for (const o of options) { const opt = el('option', null, labels ? labels[o] || o : o); opt.value = o; s.appendChild(opt); }
  s.value = get(); s.addEventListener('change', () => set(s.value)); s.refresh = () => { s.value = get(); }; return s;
}

export function createPanel({ root, api }) {
  let visible = false, tab = 'look', timer = 0, textOpen = false;
  const refreshers = [];

  // ---- header ---------------------------------------------------------------------------
  const hdr = el('div', 'hdr');
  const tabs = el('div'); const tabBtns = {};
  for (const [k, label] of [['look', 'Look'], ['stage', 'Stage']]) { tabBtns[k] = button(label, () => setTab(k), 'tab'); tabs.appendChild(tabBtns[k]); }
  const presetSel = select([], () => api.current() || '', (v) => api.loadPreset(v));
  presetSel.refresh = () => {
    const names = api.presetNames(); const cur = api.current() || '';
    if (presetSel.dataset.sig !== names.join('|')) { presetSel.dataset.sig = names.join('|'); presetSel.textContent = ''; for (const n of names) { const o = el('option', null, n); o.value = n; presetSel.appendChild(o); } }
    presetSel.value = cur;
  };
  const saveName = el('input'); saveName.type = 'text'; saveName.placeholder = 'name'; saveName.style.width = '180px';
  saveName.addEventListener('keydown', (e) => e.stopPropagation());
  refreshers.push(() => { if (document.activeElement !== saveName) saveName.value = api.current() || ''; });
  const errLine = el('div', 'err');
  const toastEl = el('span', 'note');
  let toastTimer = 0;
  const toast = (m) => { toastEl.textContent = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.textContent = ''; }, 2400); };
  hdr.append(el('div', 'title', 'Effects Lab'), tabs, el('span', null, 'preset'), presetSel,
    button('Save', () => api.savePreset(api.current()).then((ok) => ok && refreshAll()), 'save'),
    el('span', null, 'as'), saveName, button('Save as', () => api.savePreset(saveName.value).then((ok) => ok && refreshAll())),
    button('Duplicate', () => {
      const base = api.current() || 'preset';
      let n = 2, name = base + ' 2';
      while (api.presets().presets[name]) { n++; name = base + ' ' + n; }
      api.savePreset(name).then((ok) => { if (ok) { saveName.value = name; refreshAll(); toast('duplicated as "' + name + '": edit away, the original is kept'); } });
    }),
    button('New from template', () => { const p = api.templateFrom('_template'); api.setWorking(p); const r = api.applyText(); if (r !== true) errLine.textContent = r; saveName.value = ''; refreshAll(); toast('a new preset from the template: give it a name and Save as'); }),
    button('Delete', () => { const n = api.current(); if (n && !n.startsWith('_') && confirm('Delete "' + n + '"?')) api.deletePreset(n).then(() => refreshAll()); }),
    toastEl, button('close (G)', () => hide()));
  refreshers.push(presetSel.refresh);

  // ---- body: main + side --------------------------------------------------------------------
  const bodyEl = el('div', 'body'); const main = el('div', 'main'); const side = el('div', 'side');
  // the splitter: drag to make the output and camera views wider or narrower; remembered per browser
  const split = el('div', 'splitter');
  try { const w = localStorage.getItem('lab_side_w'); if (w) bodyEl.style.setProperty('--side-w', w + 'px'); } catch (e) { /* storage unavailable */ }
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId); split.classList.add('dragging');
    const move = (ev) => {
      const r = bodyEl.getBoundingClientRect();
      const w = Math.round(Math.min(r.width * 0.7, Math.max(240, r.right - ev.clientX)));
      bodyEl.style.setProperty('--side-w', w + 'px');
      try { localStorage.setItem('lab_side_w', String(w)); } catch (e2) { /* storage unavailable */ }
    };
    const up = () => { split.classList.remove('dragging'); split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); };
    split.addEventListener('pointermove', move); split.addEventListener('pointerup', up);
  });
  const pages = { look: el('div'), stage: el('div') }; main.append(pages.look, pages.stage); bodyEl.append(main, split, side);
  // the camera with the landmarks and bones, drawn exactly as the dashboard's Camera View pane draws them (camera_view.js)
  const cameraBox = el('div', 'view'); const cameraCanvas = el('canvas'); const cameraLabel = el('div', 'vlabel', 'camera'); cameraBox.append(cameraCanvas, cameraLabel);
  const previewBox = el('div', 'view'); const previewCanvas = el('canvas'); previewBox.append(previewCanvas, el('div', 'vlabel', 'output')); side.append(previewBox, cameraBox);   // the output on top, the camera under it, as the old page has them
  const camera = createCameraView(cameraCanvas, cameraLabel);
  const previewCtx = previewCanvas.getContext('2d');
  function drawViews() {
    camera.draw();
    const srcC = api.fxCanvas(), W = previewCanvas.clientWidth, H = previewCanvas.clientHeight;
    if (!W || !H || !srcC.width) return;
    if (previewCanvas.width !== W || previewCanvas.height !== H) { previewCanvas.width = W; previewCanvas.height = H; }
    const s = Math.min(W / srcC.width, H / srcC.height), dw = srcC.width * s, dh = srcC.height * s;
    previewCtx.fillStyle = '#000'; previewCtx.fillRect(0, 0, W, H); previewCtx.drawImage(srcC, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  function setTab(k) { tab = k; for (const t in pages) pages[t].style.display = t === k ? '' : 'none'; for (const t in tabBtns) tabBtns[t].classList.toggle('on', t === k); refreshAll(); }

  // ---- Look: the dials ------------------------------------------------------------------------
  const dialsBox = el('div'); pages.look.append(el('h3', null, 'Dials: what this preset declares'), dialsBox);
  const textBox = el('div'); textBox.style.display = 'none';
  const feedTa = el('textarea'), showTa = el('textarea');
  for (const ta of [feedTa, showTa]) { ta.spellcheck = false; ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } }); }
  function apply() { const p = api.preset(); if (!p) return; p.feed = feedTa.value; p.show = showTa.value; const r = api.applyText(); errLine.textContent = r === true ? '' : r; if (r === true) toast('applied'); }
  textBox.append(el('h3', null, 'feed: what enters the feedback frame each step (ret = the new frame at uv)'), feedTa,
    el('h3', null, 'show: what reaches the screen (ret, and alpha = how much it covers what is behind)'), showTa,
    el('div', 'note', 'Inputs: cam(uv) camBlur(uv) mask(uv) maskSoft(uv) maskGrad(uv) maskGrad(uv, reach) maskNear(uv, dist) frame(uv) frameSoft(uv) frameBlur(uv) cutout(uv) hist(k, uv) stamps(uv) background(uv) noise3(p) curl(p, t) wells(uv, push, sharp, base, speed_gain) hsv(h,s,v) lum(c) chroma(c) tf_<joint>_x/y/z/v tf_present time res aspect (= height/width), and the dials by name. uv: x right, y down, 0..1.'),
    button('Apply (Ctrl+Enter)', apply, 'save'), errLine);
  pages.look.append(button('Text: the two shader bodies', () => { textOpen = !textOpen; textBox.style.display = textOpen ? '' : 'none'; refreshAll(); }), textBox);
  const dialsBinds = ['none', ...api.SOURCES.map((s) => s.key)];
  const dialsLabels = Object.fromEntries(api.SOURCES.map((s) => [s.key, s.label])); dialsLabels.none = 'no binding';
  let dialsFor = null;
  function buildDials() {
    const p = api.preset(); const sig = p ? api.current() + '|' + Object.keys(p.dials).join(',') : '';
    if (sig === dialsFor) return; dialsFor = sig;
    dialsBox.textContent = '';
    if (!p) return;
    if (!Object.keys(p.dials).length) dialsBox.appendChild(el('div', 'note', 'this preset declares no dials'));
    for (const [name, d] of Object.entries(p.dials)) {
      const row = el('div', 'row');
      const nm = el('div', 'name', d.label || name); const hint = el('small', null, d.hint ? d.hint + ' (' + name + ')' : name); nm.appendChild(hint);
      const range = el('input'); range.type = 'range'; range.min = String(d.min ?? 0); range.max = String(d.max ?? 1); range.step = String(d.step ?? 0.01); range.value = String(d.value);
      const num = number(() => d.value, (v) => { d.value = v; range.value = String(v); api.engine().setDial(name, v); }, { min: d.min ?? 0, max: d.max ?? 1, step: d.step ?? 0.01 });
      range.addEventListener('input', () => { d.value = Number(range.value); num.value = range.value; api.engine().setDial(name, d.value); });
      const bind = el('div', 'bind');
      const bsel = select(dialsBinds, () => d.bind || 'none', (v) => { if (v === 'none') { delete d.bind; delete d.range; } else { d.bind = v; d.range = d.range || [d.min ?? 0, d.max ?? 1]; } refreshAll(); }, dialsLabels);
      bind.append(el('span', null, 'follows'), bsel);
      const lo = number(() => (d.range ? d.range[0] : d.min ?? 0), (v) => { if (d.range) d.range[0] = v; }, { min: d.min ?? 0, max: d.max ?? 1, step: d.step ?? 0.01 });
      const hi = number(() => (d.range ? d.range[1] : d.max ?? 1), (v) => { if (d.range) d.range[1] = v; }, { min: d.min ?? 0, max: d.max ?? 1, step: d.step ?? 0.01 });
      const bar = el('div'); bar.style.cssText = 'height:6px;width:80px;background:rgba(180,210,235,0.12);border-radius:3px;overflow:hidden';
      const fill = el('div'); fill.style.cssText = 'height:100%;width:0;background:#63b3ed'; bar.appendChild(fill);
      bind.append(el('span', null, 'from'), lo, el('span', null, 'to'), hi, bar);
      row.append(nm, range, num, bind);
      row.refresh = () => { num.refresh(); bsel.refresh(); lo.refresh(); hi.refresh(); const on = !!(d.bind && d.bind !== 'none'); lo.style.display = hi.style.display = bar.style.display = on ? '' : 'none'; if (!on) range.value = String(d.value); };
      row.tick = () => { if (d.bind && d.bind !== 'none') { const s = api.sources().src[d.bind] || 0; fill.style.width = Math.round(s * 100) + '%'; const v = api.engine().uniforms[name]; if (v !== undefined) { range.value = String(v); if (document.activeElement !== num) num.value = String(Number(v).toFixed(4)); } } };
      dialsBox.appendChild(row);
    }
    feedTa.value = p.feed || ''; showTa.value = p.show || '';
  }
  refreshers.push(() => { if (tab === 'look') { buildDials(); for (const r of dialsBox.children) if (r.refresh) r.refresh(); } });

  // ---- Stage --------------------------------------------------------------------------------
  const stageBox = el('div'); pages.stage.appendChild(stageBox);
  const stageRows = [];
  function srow(label, ...controls) { const row = el('div', 'row stage'); const ctl = el('div', 'ctl'); ctl.append(...controls); row.append(el('div', 'name', label), ctl); row.refresh = () => { for (const c of controls) if (c.refresh) c.refresh(); }; stageBox.appendChild(row); stageRows.push(row); return row; }
  const part0 = () => ({ on: false, width: 0, color: [0, 0, 0], alpha: 0 });
  const EMPTY_STAGE = { body: { into_frame: true, smooth: 0, outline: part0(), bones: part0(), hands: part0(), landmarks: { on: false, hands: false, use: [], size: 0, color: [0, 0, 0], alpha: 0, soft: true }, fill: { alpha: 0, color: [0, 0, 0] } },
    camera_behind: false, opacity: 1, matte: { on: false, feather_in: 0, feather_out: 0, inside: 1, outside: 0 }, history: 0, stamp_every: 0, stamp_fade: 1, cam_blur: 0, frame_blur: 0, mask_feather: 0, mask_smooth: 0, frame_scale: 1, diffuse: 0 };
  const S = () => (api.preset() ? api.preset().stage : EMPTY_STAGE);   // no preset loaded: the rows show zeros, nothing faults
  stageBox.appendChild(el('h3', null, 'The body as seeds: what it writes into the feedback frame, or draws on top'));
  srow('Seeds', check(() => S().body.into_frame, (v) => { S().body.into_frame = v; }, 'into the feedback frame (the effect grows from them); off = drawn over the screen'),
    el('span', null, 'curve smoothing'), snum(() => S().body.smooth, (v) => { S().body.smooth = v; }));
  const rgb = (get) => [0, 1, 2].map((i) => snum(() => get().color[i], (v) => { get().color[i] = v; }));
  const part = (label, key) => {
    const P = () => S().body[key];
    srow(label, check(() => P().on, (v) => { P().on = v; }, 'on'), el('span', null, 'width'), snum(() => P().width, (v) => { P().width = v; }, { min: 0, max: 0.05, step: 0.001 }),
      el('span', null, 'alpha'), snum(() => P().alpha, (v) => { P().alpha = v; }), el('span', null, 'rgb'), ...rgb(P));
  };
  part('Outline (the mask edge)', 'outline'); part('Bones', 'bones'); part('Hand lines', 'hands');
  const L = () => S().body.landmarks;
  // which landmarks: a collapsible grid of checkboxes, one per landmark, like the old page's
  const lmToggle = button('choose…', () => { lmGrid.style.display = lmGrid.style.display === 'none' ? '' : 'none'; });
  const lmGrid = el('div'); lmGrid.style.cssText = 'display:none;flex-basis:100%;display:none;grid-template-columns:repeat(6, minmax(120px, 1fr));gap:2px 10px;padding:6px 0 2px';
  lmGrid.style.display = 'none';
  const lmChecks = api.LANDMARKS.map((name) => {
    const c = check(() => (L().use || []).includes(name),
      (v) => { const u = new Set(L().use || []); if (v) u.add(name); else u.delete(name); L().use = api.LANDMARKS.filter((n) => u.has(n)); },
      name.replace(/_/g, ' '));
    lmGrid.appendChild(c); return c;
  });
  lmGrid.refresh = () => { if (lmGrid.style.display !== 'none') lmGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))'; for (const c of lmChecks) c.refresh(); lmGrid.style.display === 'none' || (lmGrid.style.display = 'grid'); };
  srow('Landmark discs', check(() => L().on, (v) => { L().on = v; }, 'on'), check(() => L().hands, (v) => { L().hands = v; }, 'hand points'), check(() => L().soft, (v) => { L().soft = v; }, 'soft'),
    el('span', null, 'size'), snum(() => L().size, (v) => { L().size = v; }, { min: 0, max: 0.1, step: 0.001 }), el('span', null, 'alpha'), snum(() => L().alpha, (v) => { L().alpha = v; }),
    el('span', null, 'rgb'), ...rgb(L), lmToggle, lmGrid);
  srow('Mask fill', el('span', null, 'alpha'), snum(() => S().body.fill.alpha, (v) => { S().body.fill.alpha = v; }, { min: 0, max: 1, step: 0.005 }), el('span', null, 'rgb'), ...rgb(() => S().body.fill));
  stageBox.appendChild(el('h3', null, 'Layers'));
  srow('Camera behind the effect', check(() => S().camera_behind, (v) => { S().camera_behind = v; }, 'the live camera under the effect; the preset\'s alpha decides how much shows'));
  srow('Effect opacity', snum(() => S().opacity, (v) => { S().opacity = v; }));
  srow('Camera inside / outside the mask', check(() => S().matte.on, (v) => { S().matte.on = v; }, 'on: the two opacities below; off: the whole camera at the inside value'),
    el('span', null, 'inside'), snum(() => S().matte.inside, (v) => { S().matte.inside = v; }), el('span', null, 'outside'), snum(() => S().matte.outside, (v) => { S().matte.outside = v; }),
    el('span', null, 'feather in'), snum(() => S().matte.feather_in, (v) => { S().matte.feather_in = v; }, { min: 0, max: 0.3, step: 0.005 }),
    el('span', null, 'feather out'), snum(() => S().matte.feather_out, (v) => { S().matte.feather_out = v; }, { min: 0, max: 0.3, step: 0.005 }),
    el('span', 'note', '1 solid, 0 clear (black on a screen)'));
  stageBox.appendChild(el('h3', null, 'The frame'));
  srow('Diffusion (px per step)', snum(() => S().diffuse, (v) => { S().diffuse = v; }, { min: 0, max: 4, step: 0.1 }),
    el('span', 'note', 'the feedback frame blurred this much every step: the transport\'s iterations melt together instead of standing as layers'));
  stageBox.appendChild(el('h3', null, 'Buffers the preset can read'));
  stageBox.appendChild(el('div', 'note', 'A dimmed row is one this preset\'s code never reads: moving it changes nothing here. It matters only to a preset whose feed or show calls that input.'));
  const bufRows = [];
  const bufRow = (fnNames, row) => { row.dataset.reads = fnNames; bufRows.push(row); return row; };
  bufRow('hist', srow('History (frames kept)', snum(() => S().history, (v) => { S().history = Math.round(v); }, { min: 0, max: 8, step: 1 }), el('span', 'note', 'hist(k, uv): the camera k frames ago')));
  bufRow('stamps', srow('Stamps', el('span', null, 'every (s)'), snum(() => S().stamp_every, (v) => { S().stamp_every = v; }, { min: 0, max: 10, step: 0.1 }), el('span', null, 'fade per frame'), snum(() => S().stamp_fade, (v) => { S().stamp_fade = v; }, { min: 0.9, max: 1, step: 0.001 }), el('span', 'note', 'stamps(uv): the cutout added every N seconds; 0 = off')));
  bufRow('camBlur', srow('Camera blur (px)', snum(() => S().cam_blur, (v) => { S().cam_blur = v; }, { min: 0, max: 60, step: 1 }), el('span', 'note', 'camBlur(uv)')));
  bufRow('frameBlur', srow('Frame blur (px)', snum(() => S().frame_blur, (v) => { S().frame_blur = v; }, { min: 0, max: 80, step: 1 }), el('span', 'note', 'frameBlur(uv), the heavy one; frameSoft(uv) is always 3 px')));
  srow('Feedback frame size', snum(() => S().frame_scale, (v) => { S().frame_scale = v; }, { min: 0.25, max: 1, step: 0.05 }), el('span', 'note', 'fraction of the screen; 0.5 costs a quarter of the GPU time of 1 and the show pass scales it up'));
  srow('Mask feather (screen heights)', snum(() => S().mask_feather, (v) => { S().mask_feather = v; }, { min: 0, max: 0.2, step: 0.005 }), el('span', 'note', 'maskSoft(uv)'));
  srow('Mask smoothing over time', snum(() => S().mask_smooth, (v) => { S().mask_smooth = v; }, { min: 0, max: 0.95, step: 0.05 }), el('span', 'note', '0 = the raw mask every frame (no lag); 0.35 = steadier edge but about 3 frames behind you'));
  stageBox.appendChild(el('h3', null, 'Page'));
  srow('Black is transparent', select(['auto', 'on', 'off'], () => api.cfg().key_black, (v) => { api.cfg().key_black = v; api.applyKeyBlack(); }, { on: 'on: black is transparent in the Spout stream (a screen shows black either way)', off: 'off: never', auto: 'auto: only with transparent=1 in the address' }), button('Save page settings', () => api.saveConfig()));
  stageBox.appendChild(el('h3', null, 'Sources: the body readings a dial can follow (0..1)'));
  const srcRows = [];
  for (const s of api.SOURCES) {
    const c = () => api.cfg().sources[s.key];
    const live = el('span', 'note', '');
    const row = srow(s.label, el('span', null, 'raw'), live, el('span', null, 'in'), number(() => c().in[0], (v) => { c().in[0] = v; }, { min: -10, max: 10, step: 0.01 }), el('span', null, 'to'),
      number(() => c().in[1], (v) => { c().in[1] = v; }, { min: -10, max: 10, step: 0.01 }), check(() => c().invert, (v) => { c().invert = v; }, 'invert'), el('span', null, 'smooth'), number(() => c().smooth, (v) => { c().smooth = v; }, { min: 0, max: 0.99, step: 0.01 }));
    row.tick = () => { const r = api.sources().raw[s.key]; live.textContent = (r === null || r === undefined ? 'no reading' : Number(r).toFixed(3)) + '  → ' + ((api.sources().src[s.key] || 0).toFixed(2)); };
    srcRows.push(row);
  }
  refreshers.push(() => {
    if (tab !== 'stage') return;
    for (const r of stageRows) r.refresh();
    const p = api.preset(); const code = p ? (p.feed || '') + ' ' + (p.show || '') : '';
    for (const r of bufRows) {
      const used = r.dataset.reads.split(',').some((fn) => code.includes(fn + '('));
      r.style.opacity = used ? '' : '0.4';
      r.title = used ? '' : 'this preset\'s code never reads ' + r.dataset.reads + '(); moving this changes nothing here';
    }
  });

  // ---- footer, assembly ---------------------------------------------------------------------------
  const stats = el('div', 'stats');
  refreshers.push(() => {
    const s = api.status(); const g = api.engine().stats.gpu; const c = s.streams.camera, m = s.streams.mask; const lag = s.maskLag;
    stats.textContent = `${s.fps.toFixed(0)} fps · cpu ${s.renderMs.toFixed(1)} ms · gpu ${g ? g.total.toFixed(1) + ' ms (prep ' + g.prep + ' feed ' + g.feed + ' show ' + g.show + ')' : 'n/a'}`
      + ` · ${s.body ? 'body' : 'no body'} · camera ${c.connected ? c.perSec + '/s, decode ' + c.decodeMs + ' ms' : 'not connected'} · mask ${m.connected ? m.perSec + '/s, decode ' + m.decodeMs + ' ms' : 'not connected'}`
      + ` · mask behind landmarks ${lag && lag.lagMs != null ? lag.lagMs + ' ms' : (lag && lag.note ? lag.note : 'n/a')} · ${s.gpu}`;
  });
  root.append(hdr, bodyEl, stats);
  root.addEventListener('keydown', (e) => { if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) e.stopPropagation(); });
  function refreshAll() { for (const f of refreshers) f(); }
  function tick() { if (tab === 'look') for (const r of dialsBox.children) if (r.tick) r.tick(); if (tab === 'stage') for (const r of srcRows) if (r.tick) r.tick(); for (const f of refreshers) if (f === refreshers[refreshers.length - 1]) f(); }
  function show() { visible = true; root.classList.add('open'); setTab(tab); camera.open(); clearInterval(timer); timer = setInterval(tick, 120); }
  function hide() { visible = false; root.classList.remove('open'); camera.close(); clearInterval(timer); }
  setTab('look');
  return {
    toggle() { if (visible) hide(); else show(); }, visible: () => visible, refresh: refreshAll, drawViews,
    setError: (m) => { errLine.textContent = m || ''; },
    onCameraState: (payload) => camera.onState(payload),
  };
}

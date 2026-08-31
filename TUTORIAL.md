# Building an effect

This walks from zero to your own preset. Ten minutes, no build step: the
page is the editor. Have the Effects Lab running (README) and press **G**.

## 1. How the engine thinks

Every frame, two small shader programs you write run over the screen:

- **feed** decides what the *feedback frame* contains next. The feedback
  frame is the engine's memory: whatever feed writes is still there next
  frame, so anything you add moves, fades and accumulates over time. `uv`
  is the pixel being computed (x right, y down, 0..1), and `ret` is the
  colour you give it.
- **show** decides what reaches the screen: `ret` is the colour and
  `alpha` how much it covers the layers behind (the live camera, when the
  Stage puts it there).

After feed runs, the Stage's **seeds** are drawn into the feedback frame:
the silhouette outline, bones, hand lines, landmark discs and mask fill,
each with its own colour and strength. So a preset does not have to draw
the body; it decides how what the body wrote *moves*.

## 2. Duplicate and strip

Open the panel, pick **silhouette effuse**, press **Duplicate**. You now
own a copy. Press **Text: the two shader bodies** on the Look tab, and
replace both bodies with the smallest possible effect:

feed:
```glsl
ret = frame(uv) * fade;
```

show:
```glsl
ret = frame(uv);
alpha = 1.0;
```

Press **Apply**. The screen shows the seeds fading in place: `frame(uv)`
reads the feedback frame, `fade` dims it every step. `fade` works because
the preset declares a dial with that name; every dial is a variable your
code can use, and the panel shows exactly the dials you declare, nothing
else.

## 3. Make it move

Movement is *where you read from*. Reading from a spot slightly away from
`uv` drags the whole image that way over time:

```glsl
ret = frame(uv + vec2(0.0, 0.002)) * fade;
```

Everything drifts upward two-thousandths of the screen per step. Now make
the direction come from the body instead of a constant:

```glsl
vec2 g = maskGrad(uv, 0.1);          // points toward the person
float gl = length(g);
vec2 p = uv;
if (gl > 0.001) p += g / gl * 0.003; // read from nearer the body: light flows outward
p += curl(vec2(uv.x / aspect, uv.y) * 6.0, time * 0.3) * 0.002;  // a swirling flow
ret = frame(p) * fade;
```

That is the whole trick behind both shipped effects: seeds are written
onto the body, and the feed's read-position pulls them outward through a
flow. Add dials for the numbers you want on sliders.

## 4. The inputs you can read

Everything is a function of screen position, so any input can drive
anything:

| Input | What it is |
|---|---|
| `cam(uv)` / `camBlur(uv)` | the live camera, sharp and blurred |
| `mask(uv)` / `maskSoft(uv)` | the person: 1 inside, 0 outside, hard and feathered |
| `maskGrad(uv, reach)` | which way the person's edge is |
| `maskNear(uv, dist)` | how much person lies within `dist` |
| `frame(uv)` / `frameSoft(uv)` / `frameBlur(uv)` | the feedback frame and two blurred copies |
| `cutout(uv)` | the camera times the mask: the person alone |
| `hist(k, uv)` | the camera k frames ago (Stage: History) |
| `stamps(uv)` | the person stamped every N seconds, fading (Stage: Stamps) |
| `background(uv)` | the empty scene, captured when nobody is in view |
| `noise3(p)` / `curl(p, t)` | smooth 3D noise, and a swirling flow built from it |
| `wells(uv, push, sharp, base, gain)` | outward push from fifteen body joints |
| `hsv(h,s,v)` / `lum(c)` / `chroma(c)` | colour helpers |
| `tf_<joint>_x/y/z/v` | any joint's position, nearness and speed (`tf_lwrist_x`, `tf_head_v`, ...) |
| `time`, `res`, `aspect` | seconds, the frame's size in pixels, height over width |

A dial can also *follow* a body reading: in the Look tab set its
**follows** to a source (wrist speed, body distance, hands raised...) and
a range; the dial then rides the reading, live. That is how an effect
breathes with the performer with no code at all.

## 5. The Stage

The Stage tab is everything around your two programs: which body parts
are written into the frame as seeds and in what colour, whether the live
camera sits behind the effect and at what opacity inside and outside the
mask, **Diffusion** (a per-step blur of the feedback frame that melts the
iterations together — the single best "make it smoother" control), and
the buffers. Buffer rows are dimmed when your code never reads them.

## 6. Keep it

**Save as** with your name for it. Your preset lands in
`presets_config.json` beside the shipped ones and survives updates. The
files are plain JSON: version them, share them, or edit them in a text
editor and press **R** in the page to reload.

## Ideas that fall out in a few lines

- **Trails**: `ret = max(frame(uv) * fade, cutout(uv));` — the person
  leaves burning copies.
- **Chromatic lag**: read each colour channel from `hist()` at different
  ages.
- **Frozen world**: show `background(uv)` everywhere except inside the
  mask, where `hist(7, uv)` plays the past.
- **Aura**: `maskNear(uv, reach)` minus `mask(uv)` is a halo band; colour
  it by `tf_speed`.

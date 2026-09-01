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
  `alpha` how much it covers the layers behind.

After feed runs, the Stage's **seeds** can be drawn into the feedback
frame: the silhouette outline, bones, hand lines, landmark discs and
mask fill, each with its own colour and strength. A preset does not have
to draw the body; it decides how what the body wrote *moves*.

## 2. Duplicate and strip

Open the panel, pick a preset, press **Duplicate**. You now own a copy.
Press **Text: the two shader bodies** on the Look tab, and replace both
bodies with the smallest possible effect:

feed:
```glsl
ret = frame(uv) * fade;
```

show:
```glsl
ret = frame(uv);
alpha = 1.0;
```

Press **Apply**. The seeds fade in place: `frame(uv)` reads the feedback
frame, `fade` dims it every step. `fade` works because the preset
declares a dial with that name; every dial is a variable your code can
use, and the panel shows exactly the dials you declare, nothing else.

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

That is the trick behind the shipped effects: seeds are written onto the
body, and the feed's read-position pulls them outward through a flow.
Add dials for the numbers you want on sliders. The Stage's **Diffusion**
blurs the feedback a little every step, which melts the discrete
iterations into one smooth motion.

## 4. Takes: snapshots with a lifetime

The Stage's **History ring** keeps up to 25 slots. With source
`cutout`, each slot is a *take*: the masked person with the seeds burned
in, captured every `every (s)` seconds, deleted when the ring turns past
it. In a shader:

```glsl
vec3 t = hist(k, uv);                       // take k, newest first
float w = exp(-histAge(k) / 3.0);           // its age in seconds, continuous
```

`histAge` is why take fades never step or snap. The **outlines** preset
is this pattern complete, with a noise-eaten dissolve; read its show.
(Source `camera` stores the whole frame instead: echoes, frozen worlds.)

## 5. The inputs you can read

Everything is a function of screen position, so any input can drive
anything:

| Input | What it is |
|---|---|
| `cam(uv)` / `camBlur(uv)` | the live camera, sharp and blurred |
| `mask(uv)` / `maskSoft(uv)` | the person: 1 inside, 0 outside, hard and feathered |
| `maskGrad(uv)` / `maskGrad(uv, reach)` | which way the person's edge is |
| `maskNear(uv, dist)` | how much person lies within `dist` |
| `frame(uv)` / `frameSoft(uv)` / `frameBlur(uv)` | the feedback frame, and blurred 3 px / heavily |
| `cutout(uv)` | the camera times the mask: the person alone |
| `hist(k, uv)` / `histAge(k)` | ring slot k and its age in seconds (Stage: History ring) |
| `stamps(uv)` | the person stamped every N seconds into one fading buffer (Stage: Stamps) |
| `background(uv)` | the empty scene, captured on B or when nobody is in view |
| `noise3(p)` | smooth 3D noise; the third axis is usually time |
| `curl(p, t)` | a swirling flow that never pauses everywhere at once |
| `wells(uv, push, sharp, base, gain)` | outward push from fifteen body joints, each faded by its presence |
| `hsv(h,s,v)` / `lum(c)` / `chroma(c)` | colour helpers |
| `tf_<joint>_x/y/z/v/p` | any joint's position, nearness, speed and presence (`tf_lwrist_x`, `tf_head_v`, ...) |
| `tf_size` | the body's size on screen, steady through a turn |
| `time`, `res`, `aspect` | seconds, the frame's size in pixels, height over width |

A dial can also *follow* a body reading: set its **follows** to a source
(wrist speed, body distance, hands raised...) and a range; the dial then
rides the reading live. It can *cycle*: type a number of seconds into
**cycle (s)** and it sweeps its whole range there and back on that
clock, which is how a hue breathes through a palette. And it can *drive
a Stage value* (`"stage": "history_every"`, dotted paths reach nested
ones like `body.outline.width`), which is how a preset puts buffer
timing or the outline's size on a slider.

## 6. Combining effects

**apply another preset's effect** (Look tab): pick a preset, copy its
feed or its show into the one you are editing; the dials its code needs
come along. It is a copy, yours to edit, and the source is untouched.
This is how "the takes carried by video effuse's flow" was made: outlines'
takes, video effuse's feed, one changed injection line.

## 7. Keep it

**Save as** with your name for it. Your preset becomes its own file,
`presets/<name>.json`, beside the shipped ones in `factory_presets/`,
and survives updates. The files are plain JSON: version them, share
them, or edit one in a text editor and press **R** in the page to
reload.

## Ideas that fall out in a few lines

- **Trails**: `ret = max(frame(uv) * fade, cutout(uv));` — the person
  leaves burning copies.
- **Chromatic lag**: read each colour channel from `hist()` at different
  ages.
- **Frozen world**: show `background(uv)` everywhere except inside the
  mask, where an old take plays.
- **Aura**: `maskNear(uv, reach)` minus `mask(uv)` is a halo band; colour
  it by `tf_speed`.

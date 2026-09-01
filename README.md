# TouchFree Effects Lab

Body-driven feedback effects for [TouchFree](https://bigskyinteractive.com):
the live camera, the person's silhouette and 33 body landmarks feed a WebGL
flow engine, and an effect is a **preset**: two short shader bodies and a
set of dials, editable live in the page's own panel. Free to use and to
build on (MIT).

Three effects ship as starting points:

- **silhouette effuse** — light born on the body's edge, hands and
  landmarks, carried outward by a swirling flow, coloured from a hue range.
- **video effuse** — the person's own picture is the light: the masked
  video boils in place and streams off the body as they move.
- **outlines** — a series of takes: every few seconds the person, outline
  and all, is snapshotted into its own layer, which ages, dissolves along
  a ragged pattern, and is deleted; the live person stands solid over them.

Everything on screen is deterministic image feedback fed by the person:
no video files, no network, no randomness that is not asked for.

## What it needs

A running [TouchFree Desktop](https://bigskyinteractive.com) app on the
same machine. The page is a TouchFree **content page**: TouchFree serves
it and provides everything it consumes:

| Input | From |
|---|---|
| The live camera picture | `/api/camera/mjpeg` (the content stream, the camera's rate, timestamped) |
| The body silhouette mask | `/api/body/mask/mjpeg` (8-bit alpha, timestamped) |
| 33 body landmarks + hands | the `body_state` WebSocket message |

The page reads both picture streams itself (`streams.js`): parts are
parsed and decoded as they arrive, newest frame only, nothing queued, and
each part's `X-Timestamp` header gives capture-to-page latency on the
panel's stats line. A discrete GPU is recommended; the page refuses
software rendering rather than running badly.

## Install

1. Copy this folder into `Documents\TouchFree\Content\effects_lab`.
2. In the TouchFree dashboard: **Content → Page → effects_lab → Launch**.
3. Set the tracking model on the Control page to the body data mode.

## Using it

| Key | |
|---|---|
| **G** | the settings panel (Look: the preset's dials · Stage: seeds, layers, buffers) |
| **← →** | previous / next preset |
| **R** | reload presets and settings from disk |
| **H** | live numbers (fps, GPU time, stream rates and latency) |
| **B** | capture the background now |
| **C** | clear the feedback frame |

The panel's right column shows the output and the camera with landmarks;
drag the divider to resize it. Every dial acts live. **Save** writes the
preset, **Duplicate** copies it under the next free name so you can
iterate safely, and **apply another preset's effect** copies a chosen
preset's feed or show (with the dials it needs) into the one you are
editing.

## The preset format

A preset is one JSON entry: `dials`, `feed` (GLSL: what enters the
feedback frame each step), `show` (GLSL: what reaches the screen), and
`stage`. A dial can follow a live body reading (`bind` + `range`), cycle its
whole range over N seconds (`cycle`), or drive a Stage value by dotted
path (`stage`). The stage carries the body-as-seeds (the
outline, bones, hand lines, landmark discs and mask fill, each with its
own colour, drawn into the feedback, over the screen, or only into
takes), the camera and matte layers, and the buffers: a **takes ring**
(up to 25 snapshots with continuous per-take age), a stamp accumulator,
the blurs, and per-step **diffusion** that melts the feedback's
iterations together.

[TUTORIAL.md](TUTORIAL.md) builds a preset from scratch and lists every
input the shaders can read.

Every preset is its own file: `factory_presets/<name>.json` ships with
the page and updates with it; `presets/<name>.json` is yours, written by
Save and removed by Delete, and a file there with a shipped name wins,
so your edits survive updates. Copy a preset to another machine by
copying its file.

## Output with alpha (OBS, Resolume, TouchDesigner)

TouchFree's Spout output renders this page off-screen with real per-pixel
transparency: set the Stage tab's **Black is transparent** on, and in OBS
set the Spout2 source's **Composite mode** to **Premultiplied Alpha**. The
person and the light arrive on a clear background.

## License

MIT — [LICENSE](LICENSE). Built by [Big Sky Interactive](https://bigskyinteractive.com).

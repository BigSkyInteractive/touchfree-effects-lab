# TouchFree Effects Lab

Body-driven feedback effects for [TouchFree](https://bigskyinteractive.com):
the live camera, the person's silhouette and 33 body landmarks feed a WebGL
flow engine, and an effect is a **preset**: two short shader bodies and a
set of dials, editable live in the page's own panel. Free to use and to
build on (MIT).

Two effects ship as a starting point:

- **silhouette effuse** — light born on the body's edge, hands and
  landmarks, carried outward by a swirling flow, coloured from a hue range.
- **video effuse** — the person's own picture is the light: the masked
  video boils in place and streams off the body as they move.

Everything you see is deterministic image feedback: no randomness on
screen, no video files, no network. The person is the source.

## What it needs

A running [TouchFree Desktop](https://bigskyinteractive.com) app on the
same machine. The page is a TouchFree **content page**: TouchFree serves
it, and provides everything it consumes:

| Input | From |
|---|---|
| The live camera picture | `/api/camera/mjpeg` (mirrored, timestamped) |
| The body silhouette mask | `/api/body/mask/mjpeg` (8-bit alpha, timestamped) |
| 33 body landmarks + hands | the `body_state` WebSocket message |

A discrete GPU is recommended; the page refuses software rendering rather
than running badly.

## Install

1. Copy this folder into `Documents\TouchFree\Content\effects_lab`.
2. In the TouchFree dashboard: **Content → Page → effects_lab → Launch**.
3. Set the tracking model on the Control page to the body data mode.

## Using it

| Key | |
|---|---|
| **G** | the settings panel (Look: the preset's dials · Stage: layers, seeds, buffers) |
| **← →** | previous / next preset |
| **R** | reload presets and settings from disk |
| **H** | live numbers (fps, GPU time, stream rates and latency) |
| **B** | capture the background now |
| **C** | clear the feedback frame |

The panel's right column shows the output and the camera with landmarks;
drag the divider to resize it. Every dial acts live; **Save** writes the
preset; **Duplicate** copies it so you can iterate without losing the
original.

## The preset format

A preset is one JSON entry: `dials` (each becomes a shader uniform; a dial
may follow a live body reading such as wrist speed), `feed` (GLSL: what
enters the feedback frame each step), `show` (GLSL: what reaches the
screen), and `stage` (which body parts are drawn as seeds, the camera and
matte layers, the buffers). [TUTORIAL.md](TUTORIAL.md) walks through
building one from scratch and explains every input the shaders can read.

Presets live in two files: `factory_presets.json` ships with the page and
updates with it; `presets_config.json` is yours, written by Save, and a
preset there with the same name wins, so your edits survive updates.

## Output with alpha (OBS, Resolume, TouchDesigner)

TouchFree's Spout output renders this page off-screen with real per-pixel
transparency: set the Stage tab's **Black is transparent** on, and in OBS
set the Spout2 source's **Composite mode** to **Premultiplied Alpha**. The
person and the light arrive on a clear background.

## License

MIT — [LICENSE](LICENSE). Built by [Big Sky Interactive](https://bigskyinteractive.com).

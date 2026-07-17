# caption-kit

A small toolkit for adding **karaoke-style captions** to talking-head / screen-capture
videos in HyperFrames. Built for Thai narration with code-switched English tech terms,
but the layout and pipeline are language-agnostic.

It turns one source video into a captioned composition, deriving the caption
placement from the footage itself and treating a hand-editable `.srt` as the
source of truth.

## Quick start

```bash
# 1. scaffold a project (creates ./my-video/ in the current dir)
HF_CAPTION_FONTS=/path/to/fonts node tools/caption-kit/new.mjs my-video /path/to/source.mp4
cd my-video

# 2. edit captions.config.mjs   — kicker text, accent terms, ASR fix map
# 3. transcribe -> captions.srt, then STOP for review
npm run transcribe
# 4. PROOFREAD captions.srt      — you know the words; the model doesn't
# 5. build, check, render
npm run captions && npm run check && npm run render
npm run serve                    # review the render in a browser
```

## Why it's shaped this way

Every rule below exists because the naive version failed in practice.

- **Transcribe → `.srt` → STOP.** Text is the cheapest artifact to review and the
  costliest to get wrong. Reviewing the *rendered video* first wastes renders.
- **The `.srt` is the source of truth.** Rebuilds run in `--from-srt` mode: no fix
  map, no re-splitting, no retiming — your proofread text wins verbatim.
- **Layout is derived from the footage.** A per-row luminance scan finds the
  letterbox dead bands; caption band, font size, line budget, and the kicker
  position all fall out of that. A re-framed source of the same aspect needs zero
  edits.
- **Resolution / fps / duration come from the video** (ffprobe), never hardcoded —
  hardcoding fps once shipped a 30fps render against 60fps footage.
- **Guards, because these bugs shipped:** source-video fingerprint + drift warning;
  `check-captions` (accent term split across cues, ASR artifacts, band overflow,
  stale `.srt`); `verify-render` (fps, audio, **bitrate floor + frame-animation** —
  a frozen render passed every other check); `prerender` (a stale `/tmp` frame
  cache once froze a render).

## Transcription engines (`npm run transcribe --engine …`)

| engine | how | notes |
|--------|-----|-------|
| `api` (default) | OpenRouter `google/gemini-3-flash-preview`, audio chunked ~90s | best text, accurate timing, ~1 min. Needs `OPENROUTER_API_KEY` |
| `mac` | `mlx-whisper` large-v3 over ssh (`HF_MAC_HOST`) | needs a reachable Apple-Silicon Mac |
| `local` | `whisper.cpp` medium | offline fallback, slowest, least accurate |

`auto` (the default) picks `api` if a key is present, else `mac`, else `local`.
A single long call transcribes full text but drifts on timing, so the API engine
**chunks** the audio and offsets each chunk's timestamps — one model, no hybrid.

Set the key via `OPENROUTER_API_KEY` or a gitignored `.env.local`
(see `.env.local.example`).

## Per-video config (`captions.config.mjs`)

The only file you edit per project. `.mjs`, not `.json`, so `fixMap` can hold real
regex. See `examples/tailscale-ep1.config.mjs` for a filled-in example.

Required: `slug, language, video, audio, kicker{word,sub}, accent[], fixMap[]`.
Optional: `neverSurvive[]` (artifact denylist for `check-captions`),
`apiModel`, `layout{}` (overrides any default in `lib/project.mjs`).

## Files

| file | role |
|------|------|
| `new.mjs` | scaffold a project |
| `transcribe.mjs` | audio → `transcript.json` → `captions.srt`, then stop |
| `build.mjs` | generator: `transcript`→`srt`, or `srt`→`index.html` |
| `check-captions.mjs` | structural gate |
| `verify-render.mjs` | verify the rendered file (not the exit code) |
| `prerender.mjs` | clear stale frame caches, check `/tmp` space |
| `serve-review.mjs` | concurrent, Range-capable review server |
| `lib/project.mjs` | config loader, ffprobe, layout defaults |

## Requirements

Node 18+, `ffmpeg`/`ffprobe` on PATH, the `hyperframes` CLI (invoked via `npx`),
and frozen `NotoSansThai.ttf` + `Inter.ttf` in each project's `assets/fonts/`.

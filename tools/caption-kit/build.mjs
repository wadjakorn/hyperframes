#!/usr/bin/env node
// Generic karaoke-caption generator. Per-video values come from the project's
// captions.config.mjs (glossary, fix map, kicker); resolution/fps/duration come
// from the source video. Layout is DERIVED from the footage, never hardcoded.
//
// Two modes:
//   node build.mjs <transcript.json> <out.html>            # transcribe path; also emits captions.srt
//   node build.mjs --from-srt <captions.srt> <out.html>    # rebuild from the HAND-EDITED srt
//
// In --from-srt mode the srt is literal truth: no fix map, no re-splitting, no
// retiming. Accent terms still colour automatically by term match.
//
// Other flags: [--until <seconds>] [--srt-only] [--force]

import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadProject } from "./lib/project.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const FROM_SRT = arg("--from-srt", null);
const FORCE = argv.includes("--force");
const SRT_ONLY = argv.includes("--srt-only");
const FLAGS_WITH_VALUE = ["--from-srt", "--until", "--video"];
const positional = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = argv[i - 1];
  return !(prev && FLAGS_WITH_VALUE.includes(prev));
});
const SRC = FROM_SRT ?? positional[0];
const OUT = FROM_SRT ? positional[0] : positional[1];
const UNTIL = parseFloat(arg("--until", "Infinity"));

if (!SRC || (!OUT && !SRT_ONLY)) {
  console.error(
    "usage: build.mjs --from-srt <captions.srt> <out.html>   # normal path: build from the proofread srt\n" +
      "       build.mjs <transcript.json> --srt-only          # emit captions.srt only, for proofreading\n" +
      "       build.mjs <transcript.json> <out.html> --force  # DESTRUCTIVE: regenerate srt, discarding edits",
  );
  process.exit(2);
}

const P = await loadProject();
const { ACCENT, project: PROJECT, language: LANG } = { ACCENT: P.accent, ...P };
const FIX_MAP = P.fixMap;

const W = P.probe.width;
const H = P.probe.height;
const FPS = P.probe.fps;
// Floor to 2dp so a source of 447.995…s reproduces the original 447.99 exactly.
const FULL_DURATION = Math.floor(P.probe.duration * 100) / 100;
const DURATION = Number.isFinite(UNTIL) ? UNTIL : FULL_DURATION;

const VIDEO_SRC = arg("--video", P.paths.videoSrc);
const VIDEO = P.paths.video;
const AUDIO = P.paths.audio;

const {
  CAP_TOP_MIN,
  CONTENT_GAP,
  KICKER_H,
  KICKER_GAP,
  KICKER_TOP_MIN,
  PILL_W,
  PILL_PAD_Y,
  PILL_PAD_X,
  LINE_H,
  FONT_MAX,
  FONT_MIN,
  ROWS,
  HUD_RESERVE,
  UNIT_EM,
  SAFETY,
} = P.layout;

// ---------------------------------------------------------------- band detection
function detectBands(video, duration) {
  const times = [0.04, 0.2, 0.4, 0.6, 0.8, 0.96].map((f) => +(duration * f).toFixed(2));
  const isContent = new Array(H).fill(false);
  for (const t of times) {
    const buf = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(t),
        "-i",
        video,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ],
      { maxBuffer: 1 << 28 },
    );
    if (buf.length < W * H) continue;
    for (let y = 0; y < H; y++) {
      let mn = 255;
      let mx = 0;
      for (let x = 0; x < W; x++) {
        const v = buf[y * W + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mx - mn > 60) isContent[y] = true;
    }
  }
  const first = isContent.indexOf(true);
  const last = isContent.lastIndexOf(true);
  return { contentTop: first < 0 ? 0 : first, contentBottom: last < 0 ? H : last };
}

function planLayout({ contentTop, contentBottom }) {
  const pad = 2 * PILL_PAD_Y;
  const fits = (budget) => {
    for (let f = FONT_MAX; f >= FONT_MIN; f--) {
      if (ROWS * Math.ceil(f * LINE_H) + pad <= budget) return f;
    }
    return 0;
  };
  const topBudget = contentTop - CONTENT_GAP - CAP_TOP_MIN;
  const topFont = fits(topBudget);
  if (topFont) return { band: "top", capTop: CAP_TOP_MIN, budget: topBudget, font: topFont };

  const bottomBudget = H - HUD_RESERVE - contentBottom - CONTENT_GAP;
  const bottomFont = fits(bottomBudget);
  if (bottomFont)
    return {
      band: "bottom",
      capTop: contentBottom + CONTENT_GAP,
      budget: bottomBudget,
      font: bottomFont,
    };

  throw new Error(
    `No dead band fits ${ROWS} rows at font >= ${FONT_MIN}px ` +
      `(top budget ${topBudget}px, bottom budget ${bottomBudget}px). ` +
      `This footage likely fills the frame — captions would have to overlay content, a design call.`,
  );
}

// ---------------------------------------------------------------- helpers
const ZERO_WIDTH = /[ัิ-ฺ็-๎]/g;
const units = (s) => s.replace(ZERO_WIDTH, "").length;
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function applyFixes(text) {
  let t = text.trim();
  for (const [re, to] of FIX_MAP) t = t.replace(re, to);
  return t.trim();
}

function splitLine(text, maxUnits) {
  const words = tokenise(text).map((t) => t.text);
  const lines = [];
  let cur = [];
  for (const w of words) {
    const cand = cur.length ? [...cur, w] : [w];
    if (units(cand.join(" ")) > maxUnits && cur.length) {
      lines.push(cur.join(" "));
      cur = [w];
    } else {
      cur = cand;
    }
  }
  if (cur.length) lines.push(cur.join(" "));
  return lines.length ? lines : [text];
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}
function parseSrtTime(str) {
  const m = str.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) throw new Error(`bad SRT timestamp: "${str.trim()}" (want HH:MM:SS,mmm)`);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
}
function toSrt(cues) {
  return (
    cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + c.dur)}\n${c.text}`)
      .join("\n\n") + "\n"
  );
}
function parseSrt(raw) {
  const blocks = raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split("\n");
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx < 0) throw new Error(`SRT block ${i + 1} has no "-->" timing line:\n${b}`);
    const [from, to] = lines[tIdx].split("-->");
    const start = parseSrtTime(from);
    const end = parseSrtTime(to);
    if (!(end > start))
      throw new Error(`SRT cue ${i + 1}: end (${to.trim()}) is not after start (${from.trim()})`);
    const text = lines
      .slice(tIdx + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) throw new Error(`SRT cue ${i + 1} has no text`);
    return { start: +start.toFixed(3), dur: +(end - start).toFixed(3), text };
  });
}

function tokenise(text) {
  // Empty accent list must NOT build /()/ — that matches between every character
  // and explodes the text into single chars. Plain whitespace split instead.
  if (!ACCENT.length)
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => ({ text: t, en: false }));
  const re = new RegExp(
    `(${ACCENT.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g",
  );
  const out = [];
  for (const part of text.split(re)) {
    if (!part) continue;
    if (ACCENT.includes(part)) out.push({ text: part, en: true });
    else for (const w of part.split(/\s+/).filter(Boolean)) out.push({ text: w, en: false });
  }
  return out;
}

// ---------------------------------------------------------------- provenance
function fingerprint(file) {
  const { size, mtime } = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(1 << 20);
  const h = crypto.createHash("sha256").update(String(size));
  fs.readSync(fd, chunk, 0, chunk.length, 0);
  h.update(chunk);
  fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, size - chunk.length));
  h.update(chunk);
  fs.closeSync(fd);
  return { hash: h.digest("hex").slice(0, 16), size, mtime: mtime.toISOString() };
}

const STATE_PATH = P.paths.state;
const fp = fingerprint(VIDEO_SRC);
const prev = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : null;
if (prev?.video?.hash && prev.video.hash !== fp.hash) {
  console.warn(
    `\n⚠ SOURCE VIDEO CHANGED since the last build\n` +
      `    was: ${prev.video.hash}  ${prev.video.size} bytes  ${prev.video.mtime}\n` +
      `    now: ${fp.hash}  ${fp.size} bytes  ${fp.mtime}\n` +
      `  Layout will be re-derived from the new footage. Re-render to pick it up.\n`,
  );
}
console.log(
  `video: ${VIDEO.split("/").pop()} ${fp.hash} (${(fp.size / 1e6).toFixed(0)}MB, ${W}x${H}@${FPS}, ${fp.mtime})`,
);

// ---------------------------------------------------------------- plan
const bands = detectBands(VIDEO_SRC, FULL_DURATION);
const L = planLayout(bands);
const usableW = PILL_W - 2 * PILL_PAD_X;
const MAX_UNITS = Math.floor((ROWS * usableW * SAFETY) / (UNIT_EM * L.font));

const CAP_BOTTOM = L.capTop + L.budget;
const MAX_PILL_H = ROWS * Math.ceil(L.font * LINE_H) + 2 * PILL_PAD_Y;
const KICKER_TOP = Math.max(KICKER_TOP_MIN, CAP_BOTTOM - MAX_PILL_H - KICKER_GAP - KICKER_H);

console.log(
  `bands: content ${bands.contentTop}..${bands.contentBottom} | ` +
    `band=${L.band} capTop=${L.capTop} budget=${L.budget}px font=${L.font}px maxUnits=${MAX_UNITS} | ` +
    `kicker=${KICKER_TOP} (caption tops out at ${CAP_BOTTOM - MAX_PILL_H})`,
);

// ---------------------------------------------------------------- build cues
const SRT_PATH = P.paths.srt;

function readSegments(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(raw.segments))
    return raw.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  if (Array.isArray(raw.transcription)) {
    return raw.transcription.map((s) => ({
      start: s.offsets.from / 1000,
      end: s.offsets.to / 1000,
      text: s.text,
    }));
  }
  throw new Error(`${file}: expected {segments:[...]} or whisper.cpp {transcription:[...]}`);
}

function cuesFromWhisper(file) {
  const segments = readSegments(file)
    .map((s) => ({ start: s.start, end: s.end, text: applyFixes(s.text) }))
    .filter((s) => s.text && s.start < UNTIL);

  const out = [];
  for (const seg of segments) {
    const parts = splitLine(seg.text, MAX_UNITS);
    const total = parts.reduce((n, p) => n + units(p), 0) || 1;
    let t = seg.start;
    parts.forEach((p, i) => {
      const share = (seg.end - seg.start) * (units(p) / total);
      const start = t;
      const dur = i === parts.length - 1 ? seg.end - start : share;
      t += share;
      if (start >= UNTIL) return;
      out.push({
        start: +start.toFixed(3),
        dur: +Math.max(0.4, Math.min(dur, UNTIL - start)).toFixed(3),
        text: p,
      });
    });
  }
  return out;
}

let cues;
if (FROM_SRT) {
  cues = parseSrt(fs.readFileSync(SRC, "utf8"));
  console.log(`source: ${SRC} (hand-edited — fix map and auto-split skipped)`);
} else {
  cues = cuesFromWhisper(SRC);
  if (fs.existsSync(SRT_PATH) && !FORCE) {
    console.log(`kept existing ${SRT_PATH} (pass --force to regenerate from the transcript)`);
  } else {
    fs.writeFileSync(SRT_PATH, toSrt(cues));
    console.log(
      `wrote ${SRT_PATH} (${cues.length} cues) — proofread this, then \`npm run captions\``,
    );
  }
}

if (SRT_ONLY) {
  const over = cues.filter((c) => units(c.text) > MAX_UNITS).length;
  console.log(
    `srt-only: ${cues.length} cues${over ? `, ${over} over ${MAX_UNITS}u` : ""} — stopping before build.`,
  );
  process.exit(0);
}

const over = cues.map((c, i) => ({ n: i + 1, u: units(c.text), c })).filter((x) => x.u > MAX_UNITS);
if (over.length) {
  const rowsFit = Math.floor((L.budget - 2 * PILL_PAD_Y) / Math.ceil(L.font * LINE_H));
  console.warn(`\n⚠ ${over.length} cue(s) exceed ${MAX_UNITS}u and will wrap past ${ROWS} rows:`);
  for (const x of over.slice(0, 8))
    console.warn(`   cue ${x.n} (${x.u}u, +${x.u - MAX_UNITS}): ${x.c.text.slice(0, 60)}…`);
  console.warn(
    `   band fits ${rowsFit} rows at ${L.font}px — ${rowsFit > ROWS ? "still safe, but cues get taller" : "THIS WILL OVERFLOW THE BAND"}\n`,
  );
}

// ---------------------------------------------------------------- emit
const lines = cues
  .map((c, i) => {
    const toks = tokenise(c.text)
      .map((t) => `<span class="tok${t.en ? " en" : ""}">${esc(t.text)}</span>`)
      .join(" ");
    return `        <div class="capline clip" id="c${i + 1}" data-start="${c.start}" data-duration="${c.dur}" data-track-index="4">
          <div class="pill">${toks}</div>
        </div>`;
  })
  .join("\n");

const srtHash = fs.existsSync(SRT_PATH)
  ? crypto.createHash("sha256").update(fs.readFileSync(SRT_PATH)).digest("hex").slice(0, 16)
  : "none";

const html = `<!DOCTYPE html>
<html lang="${LANG}" data-resolution="portrait">
  <!-- GENERATED by build.mjs — do not hand-edit; edit captions.srt and re-run \`npm run captions\`.
       video:   ${VIDEO.split("/").pop()} ${fp.hash} (${fp.size} bytes)
       srt:     ${srtHash} (${cues.length} cues)
       layout:  content ${bands.contentTop}..${bands.contentBottom} | band=${L.band} font=${L.font}px kicker=${KICKER_TOP} -->
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=${W}, height=${H}">
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      /* frozen local fonts (variable TTFs) — self-contained, deterministic render */
      @font-face { font-family: "Noto Sans Thai"; src: url("./assets/fonts/NotoSansThai.ttf") format("truetype"); font-weight: 100 900; font-style: normal; font-display: block; }
      @font-face { font-family: "Inter"; src: url("./assets/fonts/Inter.ttf") format("truetype"); font-weight: 100 900; font-style: normal; font-display: block; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      body { font-family: "Noto Sans Thai", "Inter", sans-serif; }
      #aroll { position: absolute; inset: 0; width: ${W}px; height: ${H}px; object-fit: cover; }

      /* Footage is a letterboxed screen capture. Detected content band: ${bands.contentTop}–${bands.contentBottom}.
         Kicker + captions live in the ${L.band} dead band, so they cover no footage. */
      .kicker { position: absolute; left: 72px; top: ${KICKER_TOP}px; display: flex; align-items: center; gap: 14px; }
      .kicker .dot { width: 13px; height: 13px; border-radius: 50%; background: #7cf3c4; box-shadow: 0 0 18px #7cf3c4; }
      .kicker .word { font-family: "Inter", sans-serif; font-weight: 800; font-size: 34px; color: #fff; letter-spacing: .5px; }
      .kicker .sub { font-family: "Inter", sans-serif; font-weight: 600; font-size: 20px; color: #9adfc6; letter-spacing: 3px; text-transform: uppercase; }

      /* Bottom-anchored: lines grow upward from a stable edge just above the footage,
         so 1-row and 2-row cues share the same baseline and never drift toward y0. */
      .capwrap { position: absolute; left: 60px; top: ${L.capTop}px; width: ${PILL_W}px; height: ${L.budget}px; }
      .capline { position: absolute; left: 0; bottom: 0; width: ${PILL_W}px; }
      .pill {
        display: inline-block; max-width: ${PILL_W}px;
        padding: ${PILL_PAD_Y}px ${PILL_PAD_X}px; border-radius: 16px;
        font-family: "Noto Sans Thai", "Inter", sans-serif; font-weight: 800; font-size: ${L.font}px; line-height: ${LINE_H};
        background: rgba(10, 12, 16, 0.72);
        box-shadow: 0 8px 26px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(124, 243, 196, 0.12);
      }
      /* karaoke tokens: dim by default, snapped bright in reading order by the timeline */
      .tok { color: rgba(255, 255, 255, 0.5); text-shadow: 0 2px 10px rgba(0, 0, 0, 0.6); }
      .tok.en { color: rgba(124, 243, 196, 0.55); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${DURATION}" data-width="${W}" data-height="${H}" data-fps="${FPS}">
      <video id="aroll" src="${VIDEO}" muted data-start="0" data-duration="${DURATION}" data-media-start="0" data-track-index="1"></video>
      <audio id="voice" src="${AUDIO}" data-start="0" data-duration="${DURATION}" data-media-start="0" data-track-index="0"></audio>

      <div id="kicker" class="kicker clip" data-start="0.3" data-duration="${(DURATION - 0.3).toFixed(2)}" data-track-index="3">
        <span class="dot"></span>
        <span class="word">${P.kicker.word}</span>
        <span class="sub">${P.kicker.sub}</span>
      </div>

      <div class="capwrap">
${lines}
      </div>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const DIM = "rgba(255, 255, 255, 0.5)";
      const LIT = "rgba(255, 255, 255, 1)";
      const DIM_EN = "rgba(124, 243, 196, 0.55)";
      const LIT_EN = "rgba(124, 243, 196, 1)";
      document.querySelectorAll(".capline").forEach((line) => {
        const start = parseFloat(line.getAttribute("data-start")) || 0;
        const dur = parseFloat(line.getAttribute("data-duration")) || 1;
        const toks = line.querySelectorAll(".tok");
        const n = toks.length;
        tl.fromTo(line, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.22, ease: "power2.out" }, start);
        // word-by-word highlight across the line's own duration (reading order → wraps to row 2)
        const sweepStart = start + 0.12;
        const sweepEnd = start + Math.max(0.5, dur - 0.28);
        const step = n > 0 ? (sweepEnd - sweepStart) / n : 0;
        const snap = Math.min(0.16, Math.max(0.06, step * 0.85));
        toks.forEach((tok, i) => {
          const en = tok.classList.contains("en");
          tl.fromTo(
            tok,
            { color: en ? DIM_EN : DIM },
            { color: en ? LIT_EN : LIT, duration: snap, ease: "none" },
            sweepStart + step * i
          );
        });
      });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

fs.writeFileSync(OUT, html);
fs.writeFileSync(
  STATE_PATH,
  JSON.stringify(
    {
      video: fp,
      srt: { hash: srtHash, cues: cues.length },
      source: FROM_SRT ? "srt" : "transcript",
    },
    null,
    2,
  ),
);
const accents = (html.match(/class="tok en"/g) || []).length;
console.log(
  `cues=${cues.length} longest=${Math.max(...cues.map((c) => units(c.text)))}u accents=${accents} -> ${OUT}`,
);

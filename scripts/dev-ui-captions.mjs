// dev-ui-captions.mjs — the subtitle-verification gate's data layer.
//
// Scope (v1, decided in the Phase-2 investigation spike): CINEMATIC-mode caption
// projects only — the ones that produce a plan.json + are checked by
// check-timing.cjs. Standard mode has no plan.json in this build; Theme mode
// enforces timing at compile. See the plan's Task 8 findings.
//
// The gate is a VERBATIM binding: displayed captions (plan.json groups[].words)
// must match what was said (transcript.json words) within 80ms. A correction is
// a TEXT edit applied to BOTH files at the same transcript index (`ti`), keeping
// timings — so check-timing's ti-match still holds. It never re-times or
// re-sequences (structural edits are out of v1 scope).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CHECK_TIMING = join(REPO_ROOT, "skills/embedded-captions/scripts/check-timing.cjs");
const MAKE_COMPOSITION = join(REPO_ROOT, "skills/embedded-captions/scripts/make-composition.cjs");

export const approvedMarker = (dir) => join(dir, ".captions-approved");
const planPathOf = (dir) => join(dir, "plan.json");
const transcriptPathOf = (dir) => join(dir, "transcript.json");
const sourcePathOf = (dir) => join(dir, "source.mp4");

// A gate-able caption project = Cinematic (has plan.json) + a transcript.json.
export function isCaptionProject(dir) {
  return existsSync(planPathOf(dir)) && existsSync(transcriptPathOf(dir));
}
// A caption project still awaiting generation carries a source.mp4 but no plan yet.
export const hasSourceVideo = (dir) => existsSync(sourcePathOf(dir));

// Read the displayed captions (plan groups) + engine/granularity for the UI.
// Only `ti`-anchored words are editable (the sync into transcript.json is
// unambiguous); words without a ti are shown read-only.
export function readCaptions(dir) {
  const hasSource = hasSourceVideo(dir);
  if (!isCaptionProject(dir))
    return {
      isCaptionProject: false,
      hasSource,
      approved: false,
      engine: null,
      language: null,
      granularity: null,
      groups: [],
    };
  const plan = JSON.parse(readFileSync(planPathOf(dir), "utf8"));
  const tr = JSON.parse(readFileSync(transcriptPathOf(dir), "utf8"));
  const groups = (plan.groups || []).map((g) => ({
    gid: g.id,
    in: g.in ?? null,
    out: g.out ?? null,
    words: (g.words || []).map((w) => ({
      text: w.text,
      start: w.start ?? null,
      end: w.end ?? null,
      ti: Number.isInteger(w.ti) ? w.ti : null,
    })),
  }));
  return {
    isCaptionProject: true,
    hasSource,
    approved: existsSync(approvedMarker(dir)),
    engine: tr.engine ?? null,
    language: tr.language_code ?? null,
    // every pipeline transcript is flat word-level; a genuine word[] ⇒ "word".
    granularity: Array.isArray(tr.words) && tr.words.length ? "word" : null,
    groups,
  };
}

// ── Manual captions: SRT / plain text → word-level transcript.json ───────────
// Skips ASR entirely — the user supplies the words. The caption pipeline is
// word-level, so cue text is split into words with timings distributed across the
// cue (SRT) or across the clip duration (plain text). check-timing then binds the
// compiled plan words to these — both derive from the same words, so the 80ms gate
// is satisfied by construction. Pure parsers are exported for tests.

// SRT / VTT timecode: HH:MM:SS,mmm (or .mmm) --> HH:MM:SS,mmm. Global-free so it
// can be reused as a per-line test without lastIndex surprises.
const TIMECODE_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const tcSeconds = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;

export function parseSrtCues(raw) {
  const cues = [];
  const blocks = String(raw || "")
    .replace(/^﻿/, "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/);
  for (const block of blocks) {
    const m = block.match(TIMECODE_RE);
    if (!m) continue;
    const start = tcSeconds(m[1], m[2], m[3], m[4]);
    const end = tcSeconds(m[5], m[6], m[7], m[8]);
    const text = block
      .split("\n")
      .filter(
        (l) =>
          l.trim() && !TIMECODE_RE.test(l) && !/^\d+$/.test(l.trim()) && !/^WEBVTT/i.test(l.trim()),
      )
      .join(" ")
      .trim();
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

// Plain text (no timecodes) → cues spread across the clip. One cue per line, or
// per sentence when it's a single block. Cue length is weighted by word count so
// long lines dwell longer. totalDur (clip seconds) anchors the spread; without it
// we fall back to ~2.5s per line.
export function plainTextToCues(raw, totalDur) {
  let lines = String(raw || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length <= 1)
    lines = String(raw || "")
      .split(/(?<=[.!?。！？])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  if (!lines.length) return [];
  const counts = lines.map((l) => Math.max(1, l.split(/\s+/).length));
  const totalWords = counts.reduce((a, b) => a + b, 0);
  const dur = totalDur && totalDur > 0 ? totalDur : lines.length * 2.5;
  const cues = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const d = (dur * counts[i]) / totalWords;
    cues.push({ start: t, end: t + d, text: lines[i] });
    t += d;
  }
  return cues;
}

// Cues → flat words, timings distributed evenly inside each cue.
export function cuesToWords(cues) {
  const words = [];
  for (const c of cues || []) {
    const toks = String(c.text).split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const step = Math.max(0.05, c.end - c.start) / toks.length;
    toks.forEach((tk, i) =>
      words.push({
        text: tk,
        start: +(c.start + i * step).toFixed(3),
        end: +(c.start + (i + 1) * step).toFixed(3),
        type: "word",
      }),
    );
  }
  return words;
}

// SRT first (precise timings); plain text otherwise (spread across totalDur).
export function parseManualCaptions(raw, { totalDur } = {}) {
  const srt = parseSrtCues(raw);
  const isSrt = srt.length > 0;
  const words = cuesToWords(isSrt ? srt : plainTextToCues(raw, totalDur));
  const text = words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  return { words, text, mode: isSrt ? "srt" : "text" };
}

// Write a manual transcript.json for `dir`. `totalDur` (clip seconds) improves
// plain-text spacing; ignored for SRT. Returns {ok, words, mode} or {ok:false}.
export function writeManualTranscript(dir, raw, { language, totalDur } = {}) {
  const { words, text, mode } = parseManualCaptions(raw, { totalDur });
  if (!words.length)
    return { ok: false, error: "no caption text found — paste SRT or plain lines" };
  const lang = /^[a-z]{2,3}$/.test(String(language || "")) ? String(language) : "en";
  const tr = { text, language_code: lang, engine: `manual(${mode})`, words };
  writeFileSync(transcriptPathOf(dir), JSON.stringify(tr, null, 2));
  return { ok: true, words: words.length, mode };
}

// Apply text corrections (keyed by transcript index `ti`) to BOTH plan.json and
// transcript.json — keeping timings — then run the 80ms gate. Writes the
// approved marker only if the gate passes. Does NOT recompile index.html; that's
// a separate side-effect (recompileComposition) the caller runs on success.
export async function approveCaptions(dir, edits = []) {
  if (!isCaptionProject(dir))
    return {
      ok: false,
      approved: false,
      gate: { passed: false, failures: ["not a caption project"] },
    };
  const byTi = new Map(
    (edits || [])
      .filter((e) => e && Number.isInteger(e.ti) && typeof e.text === "string")
      .map((e) => [e.ti, e.text.trim()]),
  );
  if (byTi.size) {
    const plan = JSON.parse(readFileSync(planPathOf(dir), "utf8"));
    const tr = JSON.parse(readFileSync(transcriptPathOf(dir), "utf8"));
    for (const [ti, text] of byTi) if (tr.words && tr.words[ti]) tr.words[ti].text = text;
    for (const g of plan.groups || [])
      for (const w of g.words || [])
        if (Number.isInteger(w.ti) && byTi.has(w.ti)) w.text = byTi.get(w.ti);
    writeFileSync(transcriptPathOf(dir), JSON.stringify(tr, null, 2));
    writeFileSync(planPathOf(dir), JSON.stringify(plan, null, 2));
  }
  const gate = await runCheckTiming(dir);
  if (gate.passed) writeFileSync(approvedMarker(dir), "");
  return { ok: true, approved: gate.passed, gate };
}

// run check-timing.cjs --strict: exit 0 = pass, exit 1 = drift. Offender lines
// start with `[group-id]` (or `[a↔b]` for overlaps); collect those as failures.
async function runCheckTiming(dir) {
  try {
    await execFileP("node", [CHECK_TIMING, dir, "--strict"], { cwd: REPO_ROOT });
    return { passed: true, failures: [] };
  } catch (e) {
    const out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    const failures = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\[.+?\]/.test(l));
    return {
      passed: false,
      failures: failures.length ? failures : [out.trim() || "timing gate failed"],
    };
  }
}

// Rebuild index.html from the (possibly edited) plan.json so the preview reflects
// the correction. Best-effort — the timing gate, not this, is the authority.
export async function recompileComposition(dir) {
  try {
    await execFileP("node", [MAKE_COMPOSITION, dir], { cwd: REPO_ROOT });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && (e.stderr || e.message)) || "compile failed") };
  }
}

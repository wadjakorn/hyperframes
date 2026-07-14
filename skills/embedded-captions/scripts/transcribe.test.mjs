// transcribe.test.mjs — unit tests for the pure helpers in transcribe.cjs.
// Run: `node --test skills/embedded-captions/scripts/transcribe.test.mjs`
// (CI's test-skills job discovers every skills/**/*.test.mjs). No model download,
// no uvx, no ffmpeg — only the parse/interpolation/trim/classify/glossary logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const t = require("./transcribe.cjs");

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "hf-transcribe-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── glossary + term-fix map (captions.subs.json) ─────────────────────────────
test("buildInitialPrompt joins hotwords, empty for none/non-array", () => {
  assert.equal(t.buildInitialPrompt([]), "");
  assert.equal(t.buildInitialPrompt("nope"), "");
  assert.equal(t.buildInitialPrompt(["Claude Code", "tmux"]), "Glossary: Claude Code, tmux.");
});

test("applySubstitutions: literal is case-insensitive, counts changed words", () => {
  const words = [
    { text: "Clod", start: 0, end: 1, type: "word" },
    { text: "code", start: 1, end: 2, type: "word" },
  ];
  const r = t.applySubstitutions(words, [{ from: "clod", to: "Claude" }]);
  assert.equal(r.words[0].text, "Claude");
  assert.equal(r.words[1].text, "code");
  assert.equal(r.count, 1);
  // original words object is not mutated
  assert.equal(words[0].text, "Clod");
});

test("applySubstitutions: regex with flags, and no-op on empty list", () => {
  const words = [
    { text: "harder", start: 0, end: 1 },
    { text: "HARDER", start: 1, end: 2 },
  ];
  const r = t.applySubstitutions(words, [
    { from: "harder", to: "Herdr", regex: true, flags: "gi" },
  ]);
  assert.equal(r.words[0].text, "Herdr");
  assert.equal(r.words[1].text, "Herdr");
  assert.equal(r.count, 2);
  const noop = t.applySubstitutions(words, []);
  assert.equal(noop.count, 0);
  assert.deepEqual(noop.words, words);
});

test("applySubstitutions: regex without explicit flags is case-insensitive (default gi)", () => {
  // Mirrors the shipped _example { from: "harder", to: "Herdr", regex: true } —
  // it must catch ASR casing variants without the user passing flags.
  const words = [
    { text: "harder", start: 0, end: 1 },
    { text: "Harder", start: 1, end: 2 },
    { text: "HARDER", start: 2, end: 3 },
  ];
  const r = t.applySubstitutions(words, [{ from: "harder", to: "Herdr", regex: true }]);
  assert.deepEqual(
    r.words.map((w) => w.text),
    ["Herdr", "Herdr", "Herdr"],
  );
  assert.equal(r.count, 3);
});

test("applySubstitutions: explicit flags still override the default", () => {
  // A user who wants case-sensitivity passes flags: "g" and gets it.
  const words = [
    { text: "harder", start: 0, end: 1 },
    { text: "Harder", start: 1, end: 2 },
  ];
  const r = t.applySubstitutions(words, [{ from: "harder", to: "Herdr", regex: true, flags: "g" }]);
  assert.deepEqual(
    r.words.map((w) => w.text),
    ["Herdr", "Harder"],
  );
  assert.equal(r.count, 1);
});

test("applySubstitutions: a malformed regex is skipped, not fatal", () => {
  const r = t.applySubstitutions(
    [{ text: "x", start: 0, end: 1 }],
    [{ from: "(", to: "y", regex: true }],
  );
  assert.equal(r.count, 0);
});

test("loadCaptionsConfig: missing file → empty, found:false", () =>
  withTmp((dir) => {
    const cfg = t.loadCaptionsConfig(dir);
    assert.equal(cfg.found, false);
    assert.deepEqual(cfg.hotwords, []);
    assert.deepEqual(cfg.substitutions, []);
  }));

test("loadCaptionsConfig: filters junk hotwords/substitutions", () =>
  withTmp((dir) => {
    writeFileSync(
      join(dir, t.SUBS_FILE),
      JSON.stringify({
        hotwords: ["Herdr", 42, "", "  "],
        substitutions: [
          { from: "a", to: "b" },
          { from: "x" },
          { to: "y" },
          null,
          { from: "", to: "z" },
        ],
      }),
    );
    const cfg = t.loadCaptionsConfig(dir);
    assert.deepEqual(cfg.hotwords, ["Herdr"]);
    assert.equal(cfg.substitutions.length, 1);
    assert.equal(cfg.substitutions[0].from, "a");
  }));

test("ensureSubsTemplate: writes a valid stub once, then no-ops", () =>
  withTmp((dir) => {
    assert.equal(t.ensureSubsTemplate(dir), true);
    const p = join(dir, t.SUBS_FILE);
    assert.ok(existsSync(p));
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(parsed.hotwords, []);
    assert.deepEqual(parsed.substitutions, []);
    assert.equal(t.ensureSubsTemplate(dir), false); // idempotent
    // the stub loads cleanly, ignoring _comment/_example
    const cfg = t.loadCaptionsConfig(dir);
    assert.equal(cfg.found, true);
    assert.deepEqual(cfg.hotwords, []);
  }));

// ── WhisperX JSON → words ────────────────────────────────────────────────────
test("parseWhisperxWords: flattens segments, trims text, tolerates empties", () => {
  const wxJson = {
    segments: [
      {
        words: [
          { word: " Hello ", start: 0, end: 0.5 },
          { word: "world", start: 0.5, end: 1 },
        ],
      },
      { words: [{ word: "again", start: 1, end: 1.5 }] },
    ],
  };
  const wx = t.parseWhisperxWords(wxJson);
  assert.deepEqual(
    wx.map((w) => w.text),
    ["Hello", "world", "again"],
  );
  assert.equal(wx[0].type, "word");
  assert.deepEqual(t.parseWhisperxWords({}), []);
  assert.deepEqual(t.parseWhisperxWords(null), []);
});

test("interpolateMissingTimings: fills OOV null timings from neighbors", () => {
  const wx = [
    { text: "a", start: 0, end: 1 },
    { text: "b", start: null, end: null },
    { text: "c", start: 2, end: 3 },
  ];
  const out = t.interpolateMissingTimings(wx);
  assert.equal(out[1].start, 1); // prev end
  assert.ok(Math.abs(out[1].end - 1.98) < 1e-9); // just before next start (2 - 0.02)
});

test("interpolateMissingTimings: last word with no next uses +0.3s window", () => {
  const wx = [
    { text: "a", start: 0, end: 1 },
    { text: "b", start: null, end: null },
  ];
  const out = t.interpolateMissingTimings(wx);
  assert.equal(out[1].start, 1);
  assert.ok(Math.abs(out[1].end - 1.28) < 1e-9); // (1 + 0.3) - 0.02
});

// ── tail-hallucination trim ──────────────────────────────────────────────────
test("trimHallucinatedTail: drops words starting after the audible end", () => {
  const words = [{ start: 0 }, { start: 1 }, { start: 5 }];
  const r = t.trimHallucinatedTail(words, { speechEnd: 1.5, total: 6 });
  assert.equal(r.trimmed, 1);
  assert.equal(r.words.length, 2);
});

test("trimHallucinatedTail: no-op when the tail isn't really silent, or audible is null", () => {
  const words = [{ start: 0 }, { start: 5.9 }];
  assert.equal(t.trimHallucinatedTail(words, { speechEnd: 5.9, total: 6 }).trimmed, 0);
  assert.equal(t.trimHallucinatedTail(words, null).trimmed, 0);
});

// ── failure classification + ffmpeg preflight ────────────────────────────────
test("classifyWhisperxError buckets the known failure modes", () => {
  assert.equal(t.classifyWhisperxError("spawnSync uvx ENOENT"), "uv-missing");
  assert.equal(
    t.classifyWhisperxError("ModuleNotFoundError: No module named 'whisperx'"),
    "uv-missing",
  );
  assert.equal(
    t.classifyWhisperxError("RuntimeError: torchcodec could not load libavutil.so.60"),
    "torchcodec-ffmpeg",
  );
  assert.equal(
    t.classifyWhisperxError("Max retries exceeded with url: ... (Read timed out)"),
    "hf-download-hang",
  );
  assert.equal(t.classifyWhisperxError("Couldn't connect to huggingface.co"), "hf-download-hang");
  assert.equal(t.classifyWhisperxError("some unrelated crash"), "other");
});

test("every classification bucket has a hint", () => {
  for (const k of ["uv-missing", "torchcodec-ffmpeg", "hf-download-hang", "other"])
    assert.equal(typeof t.WX_HINTS[k], "string");
});

test("parseFfmpegMajor reads the major, null on git builds/garbage", () => {
  assert.equal(t.parseFfmpegMajor("ffmpeg version 8.0 Copyright (c) 2000-2024"), 8);
  assert.equal(t.parseFfmpegMajor("ffmpeg version n6.1 ..."), 6);
  assert.equal(t.parseFfmpegMajor("ffmpeg version 6.1.1-3ubuntu5 ..."), 6);
  assert.equal(t.parseFfmpegMajor("ffmpeg version N-113456-gabcdef ..."), null);
  assert.equal(t.parseFfmpegMajor(""), null);
});

test("isTorchcodecFfmpegMismatch: only ffmpeg ≥ 8 mismatches", () => {
  assert.equal(t.isTorchcodecFfmpegMismatch(8), true);
  assert.equal(t.isTorchcodecFfmpegMismatch(7), false);
  assert.equal(t.isTorchcodecFfmpegMismatch(4), false);
  assert.equal(t.isTorchcodecFfmpegMismatch(null), false);
});

test("buildWhisperxCommand: uvx backend pins the spec and wraps cli args", () => {
  const { cmd, args } = t.buildWhisperxCommand(["/p/a.wav", "--model", "small"], {
    whisperxSpec: "whisperx==3.8.6",
  });
  assert.equal(cmd, "uvx");
  assert.deepEqual(args, [
    "--python",
    "3.12",
    "--from",
    "whisperx==3.8.6",
    "whisperx",
    "/p/a.wav",
    "--model",
    "small",
  ]);
});

test("buildWhisperxCommand: docker backend mounts project at its own path, sets --user", () => {
  const { cmd, args } = t.buildWhisperxCommand(["/proj/a.wav", "--model", "small"], {
    dockerImage: "hyperframes/whisperx:3.8.6",
    project: "/proj",
    uid: 1000,
    gid: 1000,
  });
  assert.equal(cmd, "docker");
  // same absolute path inside the container → cli paths need no rewriting
  assert.ok(args.includes("-v") && args[args.indexOf("-v") + 1] === "/proj:/proj");
  assert.equal(args[args.indexOf("-w") + 1], "/proj");
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  // image precedes the whisperx cli args
  const img = args.indexOf("hyperframes/whisperx:3.8.6");
  assert.deepEqual(args.slice(img + 1), ["/proj/a.wav", "--model", "small"]);
});

test("buildWhisperxCommand: docker forwards only set HF_* env, omits --user without uid", () => {
  const { args } = t.buildWhisperxCommand(["/proj/a.wav"], {
    dockerImage: "img",
    project: "/proj",
    env: { HF_ENDPOINT: "https://hf-mirror.com", HF_HUB_OFFLINE: "1", IGNORED: "x" },
  });
  assert.ok(!args.includes("--user"));
  assert.equal(args[args.indexOf("-e") + 1], "HF_ENDPOINT=https://hf-mirror.com");
  assert.ok(args.join(" ").includes("-e HF_HUB_OFFLINE=1"));
  assert.ok(!args.join(" ").includes("IGNORED"));
});

// ── API backend (OpenAI / OpenRouter) ────────────────────────────────────────
test("parseApiWords: verbose_json words → flat {text,start,end,type}", () => {
  const words = t.parseApiWords({
    text: "hi there",
    language: "en",
    words: [
      { word: "hi", start: 0, end: 0.3 },
      { word: "there", start: 0.3, end: 0.7 },
    ],
  });
  assert.deepEqual(words, [
    { text: "hi", start: 0, end: 0.3, type: "word" },
    { text: "there", start: 0.3, end: 0.7, type: "word" },
  ]);
});

test("parseApiWords: drops words missing timings (gpt-4o-transcribe returns none)", () => {
  assert.deepEqual(t.parseApiWords({ text: "hi", words: [] }), []);
  // a token with null start is not word-timestamped → dropped
  assert.deepEqual(t.parseApiWords({ words: [{ word: "x", start: null, end: 1 }] }), []);
});

test("isApiProvider / API_BASES: openai + openrouter are API providers, local is not", () => {
  assert.equal(t.isApiProvider("openai"), true);
  assert.equal(t.isApiProvider("openrouter"), true);
  assert.equal(t.isApiProvider("local"), false);
  assert.equal(t.API_BASES.openai, "https://api.openai.com/v1");
  assert.equal(t.API_BASES.openrouter, "https://openrouter.ai/api/v1");
});

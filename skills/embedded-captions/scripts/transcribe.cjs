#!/usr/bin/env node
/*
 * transcribe.cjs — word-level transcription for the caption pipeline.
 *
 *   node transcribe.cjs <project-dir> [model] [language] [flags]
 *     --provider <local|openai|openrouter>  transcription backend (default local)
 *     --prompt "<hot-words / draft text>"   biases spelling of proper nouns
 *     --force                               re-transcribe even if a transcript exists
 *
 * Backends:
 *   • local (default) — hyperframes' native WhisperX → whisper.cpp fallback. No key.
 *   • openai / openrouter — an OpenAI-compatible /audio/transcriptions API. Reads
 *     OPENAI_API_KEY / OPENROUTER_API_KEY from the env. Both use the SAME request
 *     shape (multipart, verbose_json + word granularity); only the base URL + key
 *     differ. Pick a WORD-timestamp model (whisper-1, groq/whisper-large-v3) — the
 *     word-level caption gate needs per-word timings; gpt-4o-transcribe is text-only.
 *
 * Reads:  <project>/source.mp4 (audio track)
 * Writes: <project>/transcript.json  — { text, language_code, engine, words:[{text,start,end,type}] }
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const cp = require("child_process");

function hfRoot() {
  const roots = [
    process.env.HYPERFRAMES_ROOT,
    path.resolve(__dirname, "..", "..", ".."),
    path.join(os.homedir(), "Downloads", "hyperframes"),
  ].filter(Boolean);
  for (const r of roots)
    if (fs.existsSync(path.join(r, "packages", "cli", "dist", "cli.js"))) return r;
  console.error("[transcribe] hyperframes CLI not found — set HYPERFRAMES_ROOT");
  process.exit(3);
}
function ensureSource(project) {
  const src = path.join(project, "source.mp4");
  if (fs.existsSync(src)) return src;
  const EXCL = new Set(["final", "bg_plus_caps", "fg_caps", "audio"]);
  let cands = fs
    .readdirSync(project)
    .filter(
      (f) =>
        ["mp4", "mov", "webm", "mkv", "m4v"].includes(path.extname(f).slice(1).toLowerCase()) &&
        !EXCL.has(path.basename(f, path.extname(f))) &&
        !f.startsWith("index"),
    )
    .map((f) => path.join(project, f));
  let found = cands.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  if (found) {
    try {
      fs.symlinkSync(path.basename(found), src);
    } catch {
      fs.copyFileSync(found, src);
    }
  }
  return src;
}
function _usableWords(d) {
  return d && Array.isArray(d.words) && d.words.some((w) => w && "start" in w && "end" in w);
}

// ── per-project glossary + term-fix map (captions.subs.json) ─────────────────
// ASR mis-hears domain terms ("Claude Code", "tmux", "Herdr", "SSH") and, in
// Thai, produces typos. Rather than rebuild a substitution map every session
// (as the herdr-api video had to), a project carries a persisted captions.subs.json:
//   { "hotwords": ["Claude Code", ...],            ← fed to the ASR as a bias prompt
//     "substitutions": [ {"from","to"[,"regex","flags"]} ] }  ← applied per word post-ASR
// Reused on every run; edit it and re-transcribe.

const SUBS_FILE = "captions.subs.json";
const SUBS_TEMPLATE = {
  _comment:
    'Per-project caption glossary + fix map, reused every transcribe. \'hotwords\': domain terms fed to the ASR as an initial prompt to bias spelling (WhisperX). \'substitutions\': post-ASR text fixes applied per word — {from,to} is literal + case-insensitive; add "regex": true ("flags" default "gi") for a pattern.',
  _example: {
    hotwords: ["Claude Code", "tmux", "Herdr", "SSH", "Codex"],
    substitutions: [
      { from: "clod code", to: "Claude Code" },
      { from: "harder", to: "Herdr", regex: true },
    ],
  },
  hotwords: [],
  substitutions: [],
};

function loadCaptionsConfig(project) {
  const p = path.join(project, SUBS_FILE);
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const hotwords = Array.isArray(j.hotwords)
      ? j.hotwords.filter((s) => typeof s === "string" && s.trim())
      : [];
    const substitutions = Array.isArray(j.substitutions)
      ? j.substitutions.filter(
          (s) => s && typeof s.from === "string" && s.from && typeof s.to === "string",
        )
      : [];
    return { hotwords, substitutions, path: p, found: true };
  } catch {
    return { hotwords: [], substitutions: [], path: p, found: false };
  }
}

// Write a discoverable stub the first time a project is transcribed, so the
// feature surfaces itself (empty arrays = no-op until the user fills them in).
function ensureSubsTemplate(project) {
  const p = path.join(project, SUBS_FILE);
  try {
    if (fs.existsSync(p)) return false;
    fs.writeFileSync(p, JSON.stringify(SUBS_TEMPLATE, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// Comma-joined glossary as a whisper initial prompt — biases decoding toward
// these spellings. Empty glossary → empty prompt (caller omits the flag).
function buildInitialPrompt(hotwords) {
  if (!Array.isArray(hotwords) || !hotwords.length) return "";
  return `Glossary: ${hotwords.join(", ")}.`;
}

// ── OpenAI-compatible API backend (OpenAI direct + OpenRouter) ────────────────
// OpenRouter's /api/v1/audio/transcriptions is OpenAI-compatible, so ONE code path
// serves both — only the base URL + key env differ. verbose_json + word
// granularity gives the per-word timings the caption gate binds against.
const API_BASES = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const API_KEY_ENV = { openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const isApiProvider = (p) => p === "openai" || p === "openrouter";

// Flatten an OpenAI-compatible verbose_json transcription into our flat word array.
// Whisper models return words:[{word,start,end}]; keep only fully-timed tokens
// (gpt-4o-transcribe returns none → caller errors with a clear message). Pure.
function parseApiWords(json) {
  const arr = json && Array.isArray(json.words) ? json.words : [];
  return arr
    .filter(
      (w) => w && (w.word ?? w.text) != null && Number.isFinite(w.start) && Number.isFinite(w.end),
    )
    .map((w) => ({
      text: String(w.word ?? w.text).trim(),
      start: w.start,
      end: w.end,
      type: "word",
    }))
    .filter((w) => w.text);
}

// POST audio.mp3 to <base>/audio/transcriptions and return {words,text,language}.
// Throws (never silently falls back) — the API was explicitly chosen, so a missing
// key / HTTP error / word-timestamp-less model must surface, not degrade to local.
async function apiTranscribe(audioPath, { provider, model, language, prompt }) {
  const base = API_BASES[provider];
  const keyEnv = API_KEY_ENV[provider];
  const key = process.env[keyEnv];
  if (!base) throw new Error(`unknown API provider "${provider}"`);
  if (!key) throw new Error(`${provider} API key missing — set ${keyEnv} in the server env`);
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(audioPath)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  const headers = { Authorization: `Bearer ${key}` };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://hyperframes.heygen.com";
    headers["X-Title"] = "Hyperframes captions";
  }
  const res = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers, body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${provider} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const words = parseApiWords(json);
  if (!words.length)
    throw new Error(
      `${provider}/${model} returned no word timestamps — the caption gate is word-level. ` +
        `Pick a word-timestamp model (whisper-1, groq/whisper-large-v3), or use Manual captions. ` +
        `(gpt-4o-transcribe is text-only.)`,
    );
  return { words, text: String(json.text || ""), language: String(json.language || "") };
}

function _compileSub(s) {
  // Default to "gi" for both literal and regex subs — ASR casing varies
  // ("Harder"/"HARDER"), and the stub/_example document "gi" as the default.
  const flags = typeof s.flags === "string" ? s.flags : "gi";
  const source = s.regex ? s.from : s.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return { re: new RegExp(source, flags), to: s.to };
  } catch {
    return null; // a malformed user regex is skipped, not fatal
  }
}

// Apply the substitution map to each word's text (the caption tokens), returning
// the rewritten words and how many changed. `text` is re-joined downstream.
function applySubstitutions(words, substitutions) {
  const compiled = (substitutions || []).map(_compileSub).filter(Boolean);
  if (!compiled.length) return { words, count: 0 };
  let count = 0;
  const out = words.map((w) => {
    let t = w.text;
    for (const c of compiled) t = t.replace(c.re, c.to);
    if (t !== w.text) count++;
    return { ...w, text: t };
  });
  return { words: out, count };
}

// ── WhisperX JSON → words (extracted for tests) ──────────────────────────────
// Flatten whisperx's {segments:[{words:[{word,start,end}]}]} into our flat word
// array. Alignment occasionally emits a word with null start/end (OOV, numbers) —
// left null here, filled by interpolateMissingTimings.
function parseWhisperxWords(wxJson) {
  const wx = [];
  for (const seg of (wxJson && wxJson.segments) || [])
    for (const w of seg.words || [])
      wx.push({ text: String(w.word || "").trim(), start: w.start, end: w.end, type: "word" });
  return wx;
}

// Fill missing timings from neighbors: a null word borrows the previous word's end
// as its start and stops just before the next timed word (or +0.3s if it's last).
function interpolateMissingTimings(wx) {
  for (let i = 0; i < wx.length; i++) {
    if (wx[i].start == null || wx[i].end == null) {
      const prevEnd = i > 0 ? wx[i - 1].end : 0;
      const nextStart = wx.slice(i + 1).find((x) => x.start != null);
      const ns = nextStart ? nextStart.start : prevEnd + 0.3;
      wx[i].start = prevEnd;
      wx[i].end = Math.max(prevEnd + 0.05, ns - 0.02);
    }
  }
  return wx;
}

// Drop words whisper fabricated inside a terminal silence. `audible` is
// audibleEnd()'s {speechEnd,total}; a word whose START is past the audible end
// (+0.4s slack) is a hallucination. No-op unless there's a real silent tail.
function trimHallucinatedTail(words, audible) {
  if (!audible || !(audible.speechEnd < audible.total - 0.8)) return { words, trimmed: 0 };
  const keep = words.filter((w) => w.start <= audible.speechEnd + 0.4);
  return { words: keep, trimmed: words.length - keep.length };
}

// ── WhisperX failure classification + ffmpeg preflight (extracted for tests) ──
// Why did whisperx fail? So the whisper.cpp fallback is never SILENT on a box
// that could run whisperx if its env were fixed. Buckets map to WX_HINTS below.
const WX_HINTS = {
  "uv-missing":
    "install uv (astral.sh) so `uvx whisperx` resolves: curl -LsSf https://astral.sh/uv/install.sh | sh",
  "torchcodec-ffmpeg":
    "whisperx's pinned torchcodec supports ffmpeg 4–7; this box is newer. Build scripts/whisperx.Dockerfile (carries its own ffmpeg + baked models) and set TRANSCRIBE_WHISPERX_DOCKER=<image>, or provide an older ffmpeg via LD_LIBRARY_PATH, or accept the whisper.cpp fallback.",
  "hf-download-hang":
    "HF model download failed/timed out (often an IPv6-blackholed CDN). Force IPv4 or set HF_ENDPOINT to a mirror, then retry.",
  other: "see the whisperx stderr above.",
};

function classifyWhisperxError(text) {
  const s = String(text || "").toLowerCase();
  if (/enoent|not found|no such file|no module named ['"]?whisperx|failed to spawn/.test(s))
    return "uv-missing";
  if (/torchcodec|libavutil|libav\w*\.so|ffmpeg/.test(s)) return "torchcodec-ffmpeg";
  if (
    /timed out|timeout|connectionerror|max retries|read timed out|failed to (connect|download)|huggingface|hf-mirror|couldn't connect/.test(
      s,
    )
  )
    return "hf-download-hang";
  return "other";
}

// ffmpeg major from `ffmpeg -version` first line: "ffmpeg version 8.0" / "n8.0" /
// "6.1.1-3ubuntu5" → 8/8/6. Git builds ("N-xxxxx") have no numeric major → null.
function parseFfmpegMajor(versionOutput) {
  const m = String(versionOutput || "").match(/ffmpeg version n?(\d+)\./i);
  return m ? Number(m[1]) : null;
}

function ffmpegMajor() {
  try {
    return parseFfmpegMajor(cp.execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

// whisperx 3.8.6's torchcodec targets ffmpeg 4–7; a newer major (≥8) is the known
// decode-mismatch that pushes this box to the whisper.cpp fallback.
function isTorchcodecFfmpegMismatch(major) {
  return typeof major === "number" && major > 7;
}

// Build the runner command for the whisperx CLI args `cliArgs`. Two backends:
//  • docker (opts.dockerImage set) — a baked image carrying its own ffmpeg, so
//    the host ffmpeg 8 vs torchcodec mismatch is sidestepped. The project dir is
//    bind-mounted at its OWN absolute path (so the wav/output_dir paths in
//    cliArgs resolve unchanged inside the container), run as the host uid/gid so
//    outputs aren't root-owned, with select HF_* env forwarded.
//  • uvx (default) — an ephemeral host venv pinned to `whisperxSpec`.
// Pure (no spawn) so the arg wiring is unit-testable. Extracted for tests.
function buildWhisperxCommand(cliArgs, opts) {
  const { dockerImage, project, whisperxSpec, env = {}, uid, gid } = opts;
  if (dockerImage) {
    const args = ["run", "--rm", "-v", `${project}:${project}`, "-w", project];
    if (typeof uid === "number") args.push("--user", `${uid}:${gid}`);
    for (const k of ["HF_ENDPOINT", "HF_HUB_OFFLINE", "HF_HUB_DOWNLOAD_TIMEOUT"])
      if (env[k]) args.push("-e", `${k}=${env[k]}`);
    return { cmd: "docker", args: [...args, dockerImage, ...cliArgs] };
  }
  return { cmd: "uvx", args: ["--python", "3.12", "--from", whisperxSpec, "whisperx", ...cliArgs] };
}

// Mean loudness of the audio, for the no-speech guard below. Silence → whisper
// hallucinates (famously "Thank you."), and the decision gate refuses "no speech".
function meanVolumeDb(audio) {
  try {
    // ffmpeg writes volumedetect stats to STDERR — capture it (spawnSync, no throw).
    const r = cp.spawnSync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", audio, "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8" },
    );
    const out = (r.stderr || "") + (r.stdout || "");
    const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

// Where does AUDIBLE content end? Whisper hallucinates trailing words over a silent
// tail (observed: "I'm sorry." repeated over dead air at a clip's end). silencedetect
// finds a terminal silence running to EOF; words "spoken" inside it are fabricated.
// Conservative: applause/music read as non-silence, so this fires only on truly dead
// tails. Returns {speechEnd, total} or null.
function audibleEnd(audio) {
  try {
    const r = cp.spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        audio,
        "-af",
        "silencedetect=noise=-35dB:d=0.6",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    );
    const out = (r.stderr || "") + (r.stdout || "");
    const durM = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    const total = durM ? +durM[1] * 3600 + +durM[2] * 60 + +durM[3] : null;
    if (total == null) return null;
    const starts = [...out.matchAll(/silence_start:\s*([\d.]+)/g)].map((x) => +x[1]);
    const ends = [...out.matchAll(/silence_end:\s*([\d.]+)/g)].map((x) => +x[1]);
    if (!starts.length) return { speechEnd: total, total };
    const lastStart = starts[starts.length - 1];
    const closed = ends.some((e) => e > lastStart); // silence re-broken before EOF?
    return { speechEnd: closed ? total : lastStart, total };
  } catch {
    return null;
  }
}

async function main() {
  // Parse `<dir> [model] [language]` positionals + flags. `--force` is boolean;
  // `--provider` / `--prompt` take a value (either `--k v` or `--k=v`). Value-flags
  // must consume their argument so it never leaks into the positional list.
  const argv = process.argv.slice(2);
  const flags = {};
  const positional = [];
  const VALUE_FLAGS = new Set(["provider", "prompt"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (VALUE_FLAGS.has(a.slice(2))) flags[a.slice(2)] = argv[++i] ?? "";
    else flags[a.slice(2)] = true;
  }
  const force = !!flags.force || process.env.TRANSCRIBE_FORCE === "1";
  const provider = String(flags.provider || process.env.WHISPER_PROVIDER || "local").toLowerCase();
  const useApi = isApiProvider(provider);
  const promptExtra = String(flags.prompt || "").trim();
  const project = path.resolve(positional[0] || "");
  if (!positional[0]) {
    console.error(
      "usage: transcribe.cjs <project-dir> [model] [language] [--provider local|openai|openrouter] [--prompt <text>] [--force]",
    );
    process.exit(1);
  }
  // Default = multilingual `small`, NOT `small.en`. Per media-use: ".en models
  // mistranslate non-English and mis-handle accented speech; default to small (auto-detects
  // language)." We hardcoded small.en before — it hallucinated a wrong transcript on an
  // accented speaker. Pass `small.en` only for known-clean-English; tough accents → a larger model.
  const model = positional[1] || (useApi ? "whisper-1" : process.env.WHISPER_MODEL || "small");
  const language = positional[2] || process.env.WHISPER_LANG || "";
  const out = path.join(project, "transcript.json");

  // Per-project glossary + fix map. Reused every run; a stub is written the first
  // time so the feature is discoverable.
  if (ensureSubsTemplate(project))
    console.error(`[transcribe] wrote ${SUBS_FILE} stub — add hotwords/substitutions to tune ASR`);
  const capCfg = loadCaptionsConfig(project);
  // The ASR bias prompt merges the persisted glossary (captions.subs.json) with any
  // per-run hot-words / draft text passed via --prompt from the UI.
  const initialPrompt = [buildInitialPrompt(capCfg.hotwords), promptExtra]
    .filter(Boolean)
    .join(" ");
  if (capCfg.hotwords.length)
    console.error(`[transcribe] glossary: ${capCfg.hotwords.length} hotword(s) → ASR bias prompt`);
  if (promptExtra)
    console.error(
      `[transcribe] --prompt: ${promptExtra.length} chars of hot-words / draft text → ASR bias`,
    );

  // already in our schema? skip — but validate the SHAPE, not just the keys:
  // `hyperframes init` drops a whisper.cpp segment/token-format transcript.json
  // (offsets-in-ms, nested tokens) that can carry a `words` key yet poison the
  // compilers. Only a word-level {text,start,end} array counts as normalized.
  try {
    const d = JSON.parse(fs.readFileSync(out, "utf8"));
    const wordShaped =
      d &&
      Array.isArray(d.words) &&
      d.words.length > 0 &&
      d.words.every(
        (w) =>
          w &&
          typeof (w.text ?? w.word) === "string" &&
          Number.isFinite(w.start) &&
          Number.isFinite(w.end) &&
          w.end < 36000, // ms-offset formats blow past any sane seconds value
      );
    if (wordShaped && d.language_code && !force) {
      console.log("[transcribe] already normalized, skipping (pass --force to re-transcribe)");
      return;
    }
    if (wordShaped && d.language_code && force)
      console.log(
        `[transcribe] --force: re-transcribing (model=${model}, language=${language || "auto"}) — replacing existing transcript`,
      );
    if (d && !wordShaped) {
      console.log(
        "[transcribe] existing transcript.json is NOT word-level (init stub / segment format) — regenerating",
      );
    }
  } catch {}

  const src = ensureSource(project);
  if (!fs.existsSync(src)) {
    console.error(`[transcribe] no source in ${project}`);
    process.exit(2);
  }
  const audio = path.join(project, "audio.mp3");
  if (!fs.existsSync(audio))
    cp.execFileSync(
      "ffmpeg",
      ["-y", "-i", src, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audio],
      { stdio: "ignore" },
    );

  // ── engine: WhisperX (preferred — wav2vec2 forced alignment gives word timings far
  // tighter than whisper.cpp's segment-interpolated ones; our gates are 80ms-strict) →
  // fallback hyperframes whisper.cpp. Force with TRANSCRIBE_ENGINE=whisper|whisperx.
  let words = null,
    engine = null,
    detectedLang = "";

  // ── API backend (OpenAI / OpenRouter) — explicitly chosen, so no silent fallback
  if (useApi) {
    console.error(
      `[transcribe] provider=${provider} model=${model} — POST ${API_BASES[provider]}/audio/transcriptions`,
    );
    try {
      const r = await apiTranscribe(audio, { provider, model, language, prompt: initialPrompt });
      words = r.words;
      detectedLang = r.language;
      engine = `${provider}(${model})`;
    } catch (e) {
      console.error(`[transcribe] ${provider} API failed: ${String(e.message || e)}`);
      process.exit(1);
    }
  }

  const wantWx = !useApi && (process.env.TRANSCRIBE_ENGINE || "whisperx") === "whisperx";
  if (wantWx) {
    try {
      const wav = path.join(project, "_wx_audio.wav");
      cp.execFileSync("ffmpeg", ["-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav], {
        stdio: "ignore",
      });
      const outDir = path.join(project, "_wx_out");
      fs.mkdirSync(outDir, { recursive: true });
      const wxModel = model.replace(/\.en$/, ""); // whisperx model names are multilingual ids
      // Pin whisperx so `uvx` fetches a reproducible build instead of resolving
      // "latest" on every run (a supply-chain + determinism foot-gun). Override
      // with $WHISPERX_VERSION if you've validated a different release.
      const whisperxSpec = `whisperx==${process.env.WHISPERX_VERSION || "3.8.6"}`;
      // whisperx CLI args (everything after the `whisperx` entrypoint) — shared by
      // the uvx and docker runners below.
      const wxCliArgs = [
        wav,
        "--model",
        wxModel,
        "--device",
        "cpu",
        "--compute_type",
        "int8",
        "--output_dir",
        outDir,
        "--output_format",
        "json",
        "--no_align_deletes",
        "--print_progress",
        "False",
      ];
      if (language) wxCliArgs.push("--language", language);
      if (initialPrompt) wxCliArgs.push("--initial_prompt", initialPrompt);

      // Preflight: warn up front on the known ffmpeg-major mismatch, and cap the
      // HF download timeout so an IPv6-blackholed model CDN fails fast (and we
      // classify + fall back) instead of hanging the whole 600s subprocess.
      const wxEnv = { ...process.env };
      if (!wxEnv.HF_HUB_DOWNLOAD_TIMEOUT) wxEnv.HF_HUB_DOWNLOAD_TIMEOUT = "30";

      // Runner: a baked docker image (host ffmpeg untouched — see
      // whisperx.Dockerfile) when TRANSCRIBE_WHISPERX_DOCKER names one; else uvx
      // (ephemeral host venv). Docker mounts the project at its OWN absolute path
      // so wav/output_dir paths need no rewriting, and runs as the host user so
      // outputs aren't root-owned.
      const dockerImage = process.env.TRANSCRIBE_WHISPERX_DOCKER;
      const fmaj = ffmpegMajor();
      if (dockerImage)
        console.error(
          `[transcribe] whisperx via docker ${dockerImage} — host ffmpeg ${fmaj ?? "?"} bypassed`,
        );
      else if (isTorchcodecFfmpegMismatch(fmaj))
        console.error(`[transcribe] ⚠ ffmpeg ${fmaj} > 7 — ${WX_HINTS["torchcodec-ffmpeg"]}`);

      const wxRun = (a) => {
        const { cmd, args } = buildWhisperxCommand(a, {
          dockerImage,
          project,
          whisperxSpec,
          env: wxEnv,
          uid: process.getuid ? process.getuid() : undefined,
          gid: process.getgid ? process.getgid() : undefined,
        });
        return cp.spawnSync(cmd, args, { encoding: "utf8", timeout: 600000, env: wxEnv });
      };

      // strip our flag if this whisperx build doesn't know it
      let r = wxRun(wxCliArgs);
      if ((r.status || 0) !== 0 && /no_align_deletes/.test(r.stderr || ""))
        r = wxRun(wxCliArgs.filter((a) => a !== "--no_align_deletes"));
      if ((r.status || 0) !== 0) {
        // spawn failures (uvx missing) surface as r.error, not stderr — keep both
        // so classifyWhisperxError can tell uv-missing from a torchcodec/HF failure.
        const detail = [r.error && (r.error.code || r.error.message), r.stderr]
          .filter(Boolean)
          .join(" ");
        throw new Error(
          (detail || "whisperx failed").split("\n").slice(-4).join(" ").slice(0, 300),
        );
      }
      const wxJson = JSON.parse(fs.readFileSync(path.join(outDir, "_wx_audio.json"), "utf8"));
      const wx = interpolateMissingTimings(parseWhisperxWords(wxJson));
      if (wx.length) {
        words = wx.filter((w) => w.text);
        engine = `whisperx(${wxModel}+wav2vec2)`;
      }
      try {
        fs.unlinkSync(wav);
      } catch {}
    } catch (e) {
      const cls = classifyWhisperxError(e && (e.message || e));
      console.error(
        `[transcribe] whisperx unavailable [${cls}] (${String(e.message || e).slice(0, 160)}) — falling back to whisper.cpp`,
      );
      console.error(`[transcribe]   → ${WX_HINTS[cls]}`);
    }
  }

  if (!words && !useApi) {
    // run hyperframes Whisper → writes a flat word array to <dir>/transcript.json
    const cli = path.join(hfRoot(), "packages", "cli", "dist", "cli.js");
    const args = ["transcribe", audio, "-d", project, "--json", "--model", model];
    if (language) args.push("--language", language);
    let info = {};
    try {
      const so = cp.execFileSync("node", [cli, ...args], { encoding: "utf8" });
      const line = so.trim().split("\n").filter(Boolean).pop();
      info = JSON.parse(line);
    } catch (e) {
      console.error("[transcribe] hyperframes whisper failed:", e.message);
      process.exit(1);
    }
    const flatPath = info.transcriptPath || out;
    const flat = JSON.parse(fs.readFileSync(flatPath, "utf8"));
    const arr = Array.isArray(flat) ? flat : flat.words || [];
    words = arr
      .filter((w) => (w.text ?? w.word) != null)
      .map((w) => ({
        text: w.text ?? w.word,
        start: w.start ?? w.t0,
        end: w.end ?? w.t1,
        type: "word",
      }));
    engine = `whisper.cpp(${model})`;
  }

  // Term-fix map: correct ASR mis-hears / typos using the per-project substitution
  // list (runs for every engine, since the fallback whisper.cpp path can't take a
  // bias prompt). No-op when captions.subs.json has no substitutions.
  const subbed = applySubstitutions(words, capCfg.substitutions);
  words = subbed.words;
  if (subbed.count)
    console.error(
      `[transcribe] applied ${capCfg.substitutions.length} substitution rule(s) → ${subbed.count} word(s) corrected`,
    );

  // Tail-hallucination guard: drop words whisper placed entirely inside a terminal
  // silence (it fabricates e.g. repeated "I'm sorry." over dead air). Word START past
  // the audible end (+0.4s slack) = fabricated; real final words start before it.
  const ae = audibleEnd(audio);
  const tail = trimHallucinatedTail(words, ae);
  const trimmedTail = tail.trimmed;
  if (trimmedTail > 0) {
    console.error(
      `[transcribe] ⚠ trimmed ${trimmedTail} trailing word(s) starting after the audible end ` +
        `(${ae.speechEnd.toFixed(2)}s; clip ${ae.total.toFixed(2)}s) — whisper hallucinates over silent tails.`,
    );
    words = tail.words;
  }

  const text = words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        text,
        language_code: language || detectedLang || "en",
        engine,
        words,
        ...(trimmedTail ? { trimmed_tail_words: trimmedTail } : {}),
      },
      null,
      2,
    ),
  );
  console.log(`[transcribe] ${engine} ${words.length} words → ${out}`);
  console.log(`[transcribe] text: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);

  // No-speech guard: whisper returns confident hallucinations over silence (e.g. the
  // whole clip as "Thank you."). The decision gate REFUSES "no speech" — operationalize
  // it so an agent trusting the transcript can't sail past the gate.
  const meanDb = meanVolumeDb(audio);
  if (meanDb != null && meanDb < -45) {
    console.error(
      `\n[transcribe] ⚠ NEAR-SILENT AUDIO — mean ${meanDb.toFixed(1)} dB (real speech ≈ -16..-26 dB).`,
    );
    console.error(
      `  This transcript is almost certainly a Whisper hallucination, NOT real speech.`,
    );
    console.error(
      `  Per the decision gate, REFUSE "no speech" — confirm with \`ffmpeg -i <src> -af silencedetect\`;`,
    );
    console.error(`  do NOT author captions from fabricated words.`);
  }
}

// Exported for tests; only auto-run as a CLI.
module.exports = {
  loadCaptionsConfig,
  ensureSubsTemplate,
  buildInitialPrompt,
  parseApiWords,
  isApiProvider,
  API_BASES,
  applySubstitutions,
  parseWhisperxWords,
  interpolateMissingTimings,
  trimHallucinatedTail,
  classifyWhisperxError,
  parseFfmpegMajor,
  isTorchcodecFfmpegMismatch,
  buildWhisperxCommand,
  WX_HINTS,
  SUBS_FILE,
};

if (require.main === module)
  main().catch((e) => {
    console.error("[transcribe]", String((e && e.message) || e));
    process.exit(1);
  });

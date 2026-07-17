#!/usr/bin/env node
// Transcribe -> transcript.json -> captions.srt, then STOP.
//
// The srt is the deliverable of this step. It goes to the user for proofreading
// BEFORE anything is built or rendered — text is the cheapest artifact to review
// and the most expensive to get wrong. Do not chain a build onto this.
//
//   node transcribe.mjs [--engine api|mac|local|auto] [--force]
//
//   api    (default when OPENROUTER_API_KEY is set) Gemini 3 Flash over OpenRouter,
//          chunked ~90s and stitched. Best Thai text, accurate timing, no Mac. ~1 min.
//   mac    mlx-whisper large-v3 over ssh (HF_MAC_HOST). ~1-2 min. Needs a reachable Mac.
//   local  whisper.cpp `medium` on this box. ~14 min, worst. Offline fallback.
//
// The API key is read from OPENROUTER_API_KEY or a gitignored .env.local in the
// project or the kit dir (KEY=VALUE lines).

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { loadProject } from "./lib/project.mjs";

const KIT = import.meta.dirname;
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const FORCE = argv.includes("--force");
let ENGINE = arg("--engine", "auto");

const P = await loadProject();
const AUDIO = path.join(P.project, "assets", P.audio);
const { srt: SRT, transcript: TRANSCRIPT } = P.paths;
const LANG = P.language;

const API_MODEL = P.apiModel ?? "google/gemini-3-flash-preview";
const CHUNK_SEC = 90; // short enough that timestamps stay accurate; long audio drifts

// Mac fallback engine — override the ssh host/dir for your own machine.
const MAC_HOST = process.env.HF_MAC_HOST ?? "macbook-pro";
const MAC_DIR = process.env.HF_MAC_DIR ?? "~/.hf-transcribe";
const MAC_MODEL = "mlx-community/whisper-large-v3-mlx";
const WHISPER_CLI = `${process.env.HOME}/.cache/hyperframes/whisper/whisper.cpp/build/bin/whisper-cli`;
const WHISPER_MODEL = `${process.env.HOME}/.cache/hyperframes/whisper/models/ggml-medium.bin`;

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts });

function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const dir of [P.project, KIT]) {
    const f = path.join(dir, ".env.local");
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, "utf8").match(/OPENROUTER_API_KEY=(\S+)/);
      if (m) return m[1];
    }
  }
  return null;
}

const API_PROMPT =
  "Transcribe this Thai audio verbatim as SRT subtitles. Output ONLY valid SRT: numbered cues, each with a " +
  "`HH:MM:SS,mmm --> HH:MM:SS,mmm` timing line and the Thai text. Write Thai as continuous script with NO spaces " +
  "between Thai words; use spaces only around English words. Keep English tech terms in English. Timestamps MUST " +
  "match when each phrase is actually spoken; the audio starts at 00:00:00. Segment ~3-6s per cue. No commentary, no code fences.";

/** Chunk the audio, transcribe each with the API model, offset timestamps, stitch. */
async function transcribeApi() {
  const key = loadKey();
  if (!key) throw new Error("no OPENROUTER_API_KEY (env or .env.local)");
  const total = Math.ceil(P.probe.duration);
  const nChunks = Math.ceil(total / CHUNK_SEC);
  console.log(`engine: api (${API_MODEL}) — ${nChunks} chunk(s) of ${CHUNK_SEC}s`);

  // Robust SRT parse: a timing line opens a cue; every line until the next timing
  // line is its text (dropping stray cue-number lines). Tolerates numbered or
  // unnumbered cues, with or without blank-line separators — the model varies.
  const TIMING =
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  const secs = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +String(ms).padEnd(3, "0") / 1000;
  function parseSrtText(text, off) {
    const out = [];
    let cur = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const t = line.match(TIMING);
      if (t) {
        if (cur) out.push(cur);
        cur = {
          start: off + secs(t[1], t[2], t[3], t[4]),
          end: off + secs(t[5], t[6], t[7], t[8]),
          parts: [],
        };
      } else if (cur && line && !/^\d+$/.test(line) && !/^```/.test(line)) {
        cur.parts.push(line);
      }
    }
    if (cur) out.push(cur);
    return out
      .map((c) => ({
        start: +c.start.toFixed(3),
        end: +c.end.toFixed(3),
        text: c.parts.join(" ").replace(/\s+/g, " ").trim(),
      }))
      .filter((c) => c.text && c.end > c.start);
  }
  const segments = [];

  for (let i = 0; i < nChunks; i++) {
    const off = i * CHUNK_SEC;
    const chunk = `/tmp/hf-chunk-${i}.mp3`;
    sh(
      `ffmpeg -v error -ss ${off} -t ${CHUNK_SEC} -i "${AUDIO}" -ar 16000 -ac 1 -b:a 48k "${chunk}" -y`,
    );
    const audio = fs.readFileSync(chunk).toString("base64");
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: API_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: API_PROMPT },
              { type: "input_audio", input_audio: { data: audio, format: "mp3" } },
            ],
          },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok || j.error)
      throw new Error(`chunk ${i}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
    const text = j.choices?.[0]?.message?.content ?? "";
    const cues = parseSrtText(text, off);
    segments.push(...cues);
    console.log(
      `  chunk ${i + 1}/${nChunks} (${off}-${Math.min(off + CHUNK_SEC, total)}s): ${cues.length} cues`,
    );
    fs.rmSync(chunk, { force: true });
  }
  if (!segments.length) throw new Error("API returned no parseable cues");
  return segments;
}

function macReachable() {
  try {
    execFileSync("ssh", ["-o", "ConnectTimeout=6", "-o", "BatchMode=yes", MAC_HOST, "true"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function transcribeMac() {
  console.log(`engine: mac (${MAC_MODEL}) — uploading audio…`);
  sh(`ssh -o ConnectTimeout=10 ${MAC_HOST} 'mkdir -p ${MAC_DIR}'`);
  sh(`scp -o ConnectTimeout=10 -q "${AUDIO}" ${MAC_HOST}:${MAC_DIR}/`);
  const name = AUDIO.split("/").pop();
  console.log(`transcribing on ${MAC_HOST} (large-v3)…`);
  const remote = [
    `export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH`,
    `cd ${MAC_DIR}`,
    `mlx_whisper --model ${MAC_MODEL} --language ${LANG} --output-format json --output-name out --output-dir . "${name}"`,
  ].join(" && ");
  sh(`ssh -o ConnectTimeout=10 ${MAC_HOST} 'bash -lc "${remote}"'`, {
    stdio: "inherit",
    maxBuffer: 1 << 26,
  });
  sh(`scp -o ConnectTimeout=10 -q ${MAC_HOST}:${MAC_DIR}/out.json /tmp/mac-transcript.json`);
  const raw = JSON.parse(fs.readFileSync("/tmp/mac-transcript.json", "utf8"));
  return raw.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
}

function transcribeLocal() {
  console.log("engine: local (whisper.cpp medium) — this takes ~14 min…");
  if (!fs.existsSync(WHISPER_CLI)) throw new Error(`whisper-cli not found at ${WHISPER_CLI}`);
  const wav = "/tmp/hf-transcribe.wav";
  sh(`ffmpeg -v error -i "${AUDIO}" -ar 16000 -ac 1 -c:a pcm_s16le "${wav}" -y`);
  sh(
    `"${WHISPER_CLI}" -m "${WHISPER_MODEL}" -f "${wav}" --language ${LANG} -oj -of /tmp/hf-transcribe`,
    { stdio: "inherit" },
  );
  const raw = JSON.parse(fs.readFileSync("/tmp/hf-transcribe.json", "utf8"));
  return raw.transcription.map((s) => ({
    start: s.offsets.from / 1000,
    end: s.offsets.to / 1000,
    text: s.text.trim(),
  }));
}

if (fs.existsSync(SRT) && !FORCE) {
  console.error(
    `\n✗ ${SRT} already exists — refusing to overwrite hand edits.\n` +
      `  Pass --force if you really want to re-transcribe from scratch.\n`,
  );
  process.exit(1);
}
if (!fs.existsSync(AUDIO)) {
  console.error(`✗ missing audio: ${AUDIO} (extract it from the video first)`);
  process.exit(1);
}

if (ENGINE === "auto") {
  ENGINE = loadKey() ? "api" : macReachable() ? "mac" : "local";
  console.log(`engine: auto -> ${ENGINE}`);
}

const segments =
  ENGINE === "api" ? await transcribeApi() : ENGINE === "mac" ? transcribeMac() : transcribeLocal();
const modelName = ENGINE === "api" ? API_MODEL : ENGINE === "mac" ? MAC_MODEL : "ggml-medium";

fs.writeFileSync(
  TRANSCRIPT,
  JSON.stringify({ engine: ENGINE, language: LANG, model: modelName, segments }, null, 2),
);
console.log(`wrote ${TRANSCRIPT} (${segments.length} segments, engine=${ENGINE})`);

execFileSync("node", [path.join(KIT, "build.mjs"), TRANSCRIPT, "--srt-only"], { stdio: "inherit" });

console.log(
  `\n──────────────────────────────────────────────────────────────\n` +
    `  NEXT: proofread captions.srt — then \`npm run captions\`.\n` +
    `  Nothing is built or rendered until you have corrected the text.\n` +
    `──────────────────────────────────────────────────────────────\n`,
);

#!/usr/bin/env node
// Verify the RENDERED FILE against the SOURCE video, not the exit code.
//
// `hyperframes render` exited 0 while (a) producing 30fps against 60fps footage
// and (b) shipping a FROZEN video from a truncated frame cache. Exit codes
// describe the process; this describes the artifact. Expected fps/dims/duration
// are read from the source video, so nothing is hardcoded.

import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { loadProject } from "./lib/project.mjs";

const P = await loadProject();
const FILE = process.argv[2] ?? P.paths.output;
const { fps: EXPECT_FPS, width: EXPECT_W, height: EXPECT_H, duration: EXPECT_DURATION } = P.probe;
const DURATION_TOL = 1.0;
const MIN_MB_PER_MIN = 8; // the frozen render was 4.1 MB/min; healthy ones ~16

const sh = (c, a) =>
  execFileSync(c, a, { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] });
const ffErr = (a) =>
  spawnSync("ffmpeg", a, {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "ignore", "pipe"],
  }).stderr ?? "";
const fails = [];
const ok = [];

if (!fs.existsSync(FILE)) {
  console.error(`✗ no render at ${FILE}`);
  process.exit(1);
}

const probe = JSON.parse(
  sh("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", FILE]),
);
const v = probe.streams.find((s) => s.codec_type === "video");
const a = probe.streams.find((s) => s.codec_type === "audio");
const dur = parseFloat(probe.format.duration);

const [n, d] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
const fps = d ? n / d : 0;
fps === EXPECT_FPS
  ? ok.push(`fps ${fps}`)
  : fails.push(`fps ${fps} (expected ${EXPECT_FPS} — is data-fps on the root?)`);

v && v.width === EXPECT_W && v.height === EXPECT_H
  ? ok.push(`${v.width}x${v.height}`)
  : fails.push(`dimensions ${v?.width}x${v?.height} (expected ${EXPECT_W}x${EXPECT_H})`);

Math.abs(dur - EXPECT_DURATION) <= DURATION_TOL
  ? ok.push(`duration ${dur.toFixed(2)}s`)
  : fails.push(`duration ${dur.toFixed(2)}s (expected ~${EXPECT_DURATION.toFixed(2)}s)`);

if (!a) {
  fails.push("no audio stream");
} else {
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(
    ffErr(["-hide_banner", "-i", FILE, "-af", "volumedetect", "-f", "null", "/dev/null"]),
  );
  if (!mean) fails.push("could not read audio level");
  else if (parseFloat(mean[1]) < -60) fails.push(`audio is silent (mean ${mean[1]} dB)`);
  else ok.push(`audio present (mean ${mean[1]} dB)`);
}

try {
  sh("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(Math.floor(dur / 2)),
    "-i",
    FILE,
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  ok.push("mid-file frame decodes");
} catch {
  fails.push("mid-file frame failed to decode");
}

// THE PICTURE MUST ACTUALLY MOVE — a frozen render passed everything above once.
const mbPerMin = fs.statSync(FILE).size / 1e6 / (dur / 60);
mbPerMin >= MIN_MB_PER_MIN
  ? ok.push(`bitrate sane (${mbPerMin.toFixed(1)} MB/min)`)
  : fails.push(
      `only ${mbPerMin.toFixed(1)} MB/min (< ${MIN_MB_PER_MIN}) — video may be FROZEN. Clear stale /tmp hfcache-v3-* and re-render.`,
    );

const stamps = [0.15, 0.45, 0.85].map((f) => Math.floor(dur * f));
const hashes = stamps.map((t) =>
  crypto
    .createHash("md5")
    .update(
      execFileSync(
        "sh",
        [
          "-c",
          `ffmpeg -v error -ss ${t} -i "${FILE}" -frames:v 1 -vf scale=160:-1 -f rawvideo -pix_fmt gray -`,
        ],
        {
          encoding: "buffer",
          maxBuffer: 1 << 26,
        },
      ),
    )
    .digest("hex")
    .slice(0, 12),
);
new Set(hashes).size === hashes.length
  ? ok.push(`picture animates (${stamps.join("s/")}s frames all differ)`)
  : fails.push(`FROZEN VIDEO — frames at ${stamps.join("s/")}s are identical (${hashes[0]})`);

ok.push(`${(fs.statSync(FILE).size / 1e6).toFixed(1)} MB`);
for (const o of ok) console.log(`  ✓ ${o}`);
for (const f of fails) console.error(`  ✗ ${f}`);
console.log(
  fails.length ? `\n✗ render verification FAILED` : `\n✓ render verified: ${FILE.split("/").pop()}`,
);
process.exit(fails.length ? 1 : 0);

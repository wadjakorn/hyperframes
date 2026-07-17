// Shared project resolution for the caption kit.
// Loads the per-video captions.config.mjs from the project (cwd), probes the
// source video for resolution/fps/duration, and applies layout defaults.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// Layout policy shared by every caption project. Per-video config may override
// any of these via config.layout, but the defaults encode hard-won lessons:
// captions never rise above y120, kicker is derived, 2-row ceiling, etc.
export const LAYOUT = {
  CAP_TOP_MIN: 120, // captions never rise above this y (user preference)
  CONTENT_GAP: 18, // captions bottom-anchor this far above the footage content edge
  KICKER_H: 48,
  KICKER_GAP: 20, // kicker rides this far above the caption band's tallest extent
  KICKER_TOP_MIN: 40, // never let the kicker climb off the top of the frame
  PILL_W: 900,
  PILL_PAD_Y: 14,
  PILL_PAD_X: 24,
  LINE_H: 1.3,
  FONT_MAX: 38,
  FONT_MIN: 26,
  ROWS: 2, // hard ceiling: a 3rd row would spill out of the dead band
  HUD_RESERVE: 420, // TikTok/Reels bottom chrome
  UNIT_EM: 0.45, // ~advance width per unit of mixed Thai/Latin at font F
  SAFETY: 0.78, // greedy per-word wrap headroom before the row cap
};

/** Probe the source video — resolution, fps, duration all come from the file, never hardcoded. */
export function probeVideo(file) {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  const j = JSON.parse(out);
  const s = j.streams?.[0];
  if (!s) throw new Error(`${file}: no video stream`);
  const [n, d] = String(s.r_frame_rate).split("/").map(Number);
  const fps = d ? Math.round(n / d) : 30;
  return { width: s.width, height: s.height, fps, duration: parseFloat(j.format.duration) };
}

/** Load the project: its config, its paths, and the probed video facts. */
export async function loadProject(project = process.cwd()) {
  const configPath = path.join(project, "captions.config.mjs");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `no captions.config.mjs in ${project} — run \`node <kit>/new.mjs <slug>\` to scaffold one`,
    );
  }
  const cfg = (await import(pathToFileURL(configPath).href)).default;
  for (const k of ["slug", "video", "audio", "accent", "fixMap", "kicker"]) {
    if (cfg[k] == null) throw new Error(`captions.config.mjs is missing "${k}"`);
  }
  const videoSrc = path.join(project, "assets", cfg.video);
  if (!fs.existsSync(videoSrc)) throw new Error(`missing source video: ${videoSrc}`);
  const probe = probeVideo(videoSrc);
  return {
    ...cfg,
    project,
    language: cfg.language ?? "th",
    layout: { ...LAYOUT, ...(cfg.layout ?? {}) },
    paths: {
      videoSrc,
      video: `./assets/${cfg.video}`,
      audio: `./assets/${cfg.audio}`,
      srt: path.join(project, "captions.srt"),
      transcript: path.join(project, "transcript.json"),
      state: path.join(project, ".build-state.json"),
      index: path.join(project, "index.html"),
      renders: path.join(project, "renders"),
      output: path.join(project, "renders", `${cfg.slug}.mp4`),
    },
    probe,
  };
}

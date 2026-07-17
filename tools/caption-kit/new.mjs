#!/usr/bin/env node
// Scaffold a new caption project that uses this kit.
//
//   node <kit>/new.mjs <slug> [/path/to/source.mp4]
//
// Creates ./<slug>/ (in the current directory) with a captions.config.mjs
// template, a package.json wired to the kit via a relative path, a fonts dir,
// and — if a source mp4 is given — the video + extracted audio staged in assets/.
//
// Fonts: set HF_CAPTION_FONTS=/path/to/fonts to auto-populate assets/fonts/ with
// your frozen NotoSansThai.ttf + Inter.ttf (or drop them in by hand afterwards).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const KIT = import.meta.dirname;
const [slug, srcVideo] = process.argv.slice(2);

if (!slug) {
  console.error("usage: node <kit>/new.mjs <slug> [/path/to/source.mp4]");
  process.exit(2);
}
const dir = path.resolve(process.cwd(), slug);
if (fs.existsSync(dir)) {
  console.error(`✗ ${dir} already exists`);
  process.exit(1);
}
fs.mkdirSync(path.join(dir, "assets", "fonts"), { recursive: true });
fs.mkdirSync(path.join(dir, "renders"), { recursive: true });

// Relative path from the new project to the kit, so package.json is portable.
const rel = path.relative(dir, KIT).split(path.sep).join("/");

// Fonts from HF_CAPTION_FONTS if provided (frozen, deterministic renders).
const fontSrc = process.env.HF_CAPTION_FONTS;
if (fontSrc && fs.existsSync(fontSrc)) {
  for (const f of fs.readdirSync(fontSrc)) {
    try {
      fs.linkSync(path.join(fontSrc, f), path.join(dir, "assets", "fonts", f));
    } catch {
      fs.copyFileSync(path.join(fontSrc, f), path.join(dir, "assets", "fonts", f));
    }
  }
  console.log(`  fonts populated from ${fontSrc}`);
} else {
  console.log(
    `  ⚠ drop NotoSansThai.ttf + Inter.ttf into ${slug}/assets/fonts/ (or set HF_CAPTION_FONTS)`,
  );
}

if (srcVideo) {
  if (!fs.existsSync(srcVideo)) {
    console.error(`✗ source not found: ${srcVideo}`);
    process.exit(1);
  }
  const vid = path.join(dir, "assets", `${slug}.mp4`);
  const aud = path.join(dir, "assets", `${slug}.m4a`);
  try {
    fs.linkSync(path.resolve(srcVideo), vid);
  } catch {
    fs.copyFileSync(path.resolve(srcVideo), vid);
  }
  execFileSync("ffmpeg", ["-v", "error", "-i", vid, "-vn", "-c:a", "copy", aud, "-y"]);
  console.log(`  staged assets/${slug}.mp4 + extracted assets/${slug}.m4a`);
}

fs.writeFileSync(
  path.join(dir, "captions.config.mjs"),
  `// Per-video caption config — the ONLY file you edit per project.
// The generator, layout detection, karaoke, guards and verify live in the kit
// and read this. See ${rel}/README.md.

export default {
  slug: "${slug}",
  language: "th",
  video: "${slug}.mp4",
  audio: "${slug}.m4a",

  kicker: { word: "${slug}", sub: "SUBTITLE — EDIT ME" },

  // Mint accent = product names only, longest-first ("Claude Code" before "Claude").
  accent: [],

  // Literal strings that must never survive a build (check-captions.mjs).
  neverSurvive: [],

  // ASR corrections, applied in order before splitting. Skipped in --from-srt mode.
  fixMap: [
    // [/\\bpattern\\b/gi, "replacement"],
  ],

  // Optional: override the OpenRouter STT model, or layout defaults.
  // apiModel: "google/gemini-3-flash-preview",
  // layout: { FONT_MAX: 44 },
};
`,
);

const s = (cmd) => `node ${rel}/${cmd}`;
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify(
    {
      name: slug,
      private: true,
      type: "module",
      scripts: {
        transcribe: s("transcribe.mjs"),
        captions: s("build.mjs --from-srt captions.srt index.html"),
        "captions:reset": s("build.mjs transcript.json index.html --force"),
        "check:captions": s("check-captions.mjs"),
        check: `npx --yes hyperframes@0.7.42 lint && npx --yes hyperframes@0.7.42 validate && ${s("check-captions.mjs")}`,
        verify: s("verify-render.mjs"),
        serve: s("serve-review.mjs"),
        dev: "npx --yes hyperframes@0.7.42 preview",
        render: `${s("prerender.mjs")} && npx --yes hyperframes@0.7.42 render -o renders/${slug}.mp4 && ${s("verify-render.mjs")}`,
      },
    },
    null,
    2,
  ) + "\n",
);

fs.writeFileSync(
  path.join(dir, "hyperframes.json"),
  JSON.stringify(
    {
      $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
      registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
      paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
    },
    null,
    2,
  ) + "\n",
);

console.log(`\n✓ scaffolded ${slug}/`);
console.log(`  next:`);
console.log(`    1. edit ${slug}/captions.config.mjs (kicker, accent, fixMap)`);
if (!srcVideo) console.log(`    2. stage assets/${slug}.mp4 + assets/${slug}.m4a`);
console.log(
  `    ${srcVideo ? 2 : 3}. cd ${slug} && npm run transcribe   # emits captions.srt, then STOPS`,
);
console.log(`    ${srcVideo ? 3 : 4}. proofread captions.srt`);
console.log(`    ${srcVideo ? 4 : 5}. npm run captions && npm run check && npm run render`);

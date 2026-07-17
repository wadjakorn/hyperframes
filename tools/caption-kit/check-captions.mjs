#!/usr/bin/env node
// Structural gate for the caption composition. Each check exists because a real
// bug got through and a human found it, not because it seemed nice to have.
//
//   node check-captions.mjs        # exit 1 on any failure

import fs from "node:fs";
import crypto from "node:crypto";
import { loadProject } from "./lib/project.mjs";

const P = await loadProject();
const HTML = P.paths.index;
const SRT = P.paths.srt;
const STATE = P.paths.state;
const ACCENT = P.accent;
// Literal strings that must never survive into a caption. Per-video (whisper
// mangles different things each time); default to none if the config omits it.
const ARTIFACTS = P.neverSurvive ?? [];

const html = fs.readFileSync(HTML, "utf8");
const fails = [];
const warns = [];
const ok = [];

// 1. accent terms must never be split across cues
const cues = [...html.matchAll(/id="(c\d+)"[^>]*>\s*<div class="pill">(.*?)<\/div>/gs)].map(
  (m) => ({
    id: m[1],
    text: m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }),
);
const splitTerms = [];
for (const term of ACCENT) {
  const [head, ...tail] = term.split(" ");
  if (!tail.length) continue;
  for (let i = 0; i < cues.length - 1; i++) {
    if (
      new RegExp(`${head}\\s*$`).test(cues[i].text) &&
      new RegExp(`^${tail.join(" ")}\\b`).test(cues[i + 1].text)
    ) {
      splitTerms.push(`${term} split across ${cues[i].id}/${cues[i + 1].id}`);
    }
  }
}
splitTerms.length
  ? fails.push(...splitTerms)
  : ok.push(`no accent term split across cues (${cues.length} cues)`);

// 2. known ASR artifacts must not survive
const body = cues.map((c) => c.text).join(" ");
const found = ARTIFACTS.filter((a) => body.includes(a));
found.length
  ? fails.push(`ASR artifacts left in captions: ${found.join(", ")}`)
  : ok.push(`no known ASR artifacts (${ARTIFACTS.length} checked)`);

// 3. captions must not escape the dead band
const meta = html.match(/layout:\s+content (\d+)\.\.(\d+) \| band=(\w+) font=(\d+)px kicker=(\d+)/);
if (!meta) {
  warns.push("no layout provenance in html header — rebuild with current build.mjs");
} else {
  const [, cTop, , band, font] = meta;
  const capTopMatch = html.match(/\.capwrap \{[^}]*top: (\d+)px;[^}]*height: (\d+)px/);
  if (capTopMatch) {
    const capBottom = +capTopMatch[1] + +capTopMatch[2];
    if (band === "top" && capBottom > +cTop)
      fails.push(`caption band bottom (${capBottom}) overlaps footage content (starts ${cTop})`);
    else ok.push(`caption band clears footage (band ends ${capBottom}, content starts ${cTop})`);
  }
}

// 4. html must be built from the CURRENT srt
if (fs.existsSync(SRT) && fs.existsSync(STATE)) {
  const live = crypto.createHash("sha256").update(fs.readFileSync(SRT)).digest("hex").slice(0, 16);
  const stamped = html.match(/srt:\s+([0-9a-f]{16})/)?.[1];
  if (stamped && stamped !== live)
    fails.push(
      `index.html was built from a DIFFERENT captions.srt (stamped ${stamped}, on disk ${live}) — run \`npm run captions\``,
    );
  else if (stamped) ok.push("index.html is in sync with captions.srt");
}

// 5. source video must match what the build used
if (fs.existsSync(STATE)) {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const stampedVid = html.match(/video:\s+\S+ ([0-9a-f]{16})/)?.[1];
  if (stampedVid && st.video?.hash && stampedVid !== st.video.hash)
    fails.push(`html video ${stampedVid} != build-state ${st.video.hash}`);
  else if (stampedVid) ok.push(`video provenance stamped (${stampedVid})`);
}

for (const o of ok) console.log(`  ✓ ${o}`);
for (const w of warns) console.warn(`  ⚠ ${w}`);
for (const f of fails) console.error(`  ✗ ${f}`);
console.log(
  fails.length ? `\n✗ ${fails.length} caption check(s) failed` : `\n✓ caption checks passed`,
);
process.exit(fails.length ? 1 : 0);

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
    // every pipeline transcript is flat word-level; a genuine word[] ⇒ "word".
    granularity: Array.isArray(tr.words) && tr.words.length ? "word" : null,
    groups,
  };
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

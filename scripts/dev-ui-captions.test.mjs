import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isCaptionProject,
  readCaptions,
  approveCaptions,
  approvedMarker,
} from "./dev-ui-captions.mjs";

// A minimal Cinematic caption project: flat transcript.json (the real shape —
// {text,language_code,engine,words:[{text,start,end,type}]}) + a plan.json whose
// groups[].words reference transcript words by `ti`. `drift` offsets a plan word
// start to deliberately break the 80ms timing gate.
function fixture({ drift = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capfix-"));
  const words = [
    { text: "hello", start: 0.4, end: 1.1, type: "word" },
    { text: "world", start: 1.2, end: 1.9, type: "word" },
    { text: "today", start: 2.0, end: 2.6, type: "word" },
  ];
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      text: "hello world today",
      language_code: "en",
      engine: "whisperx(small+wav2vec2)",
      words,
    }),
  );
  writeFileSync(
    join(dir, "plan.json"),
    JSON.stringify({
      mode: "template",
      compiled_by: "make-cinematic.cjs",
      dna: "cream",
      width: 720,
      height: 1290,
      fps: 30,
      duration: 3,
      planes: {},
      groups: [
        {
          id: "g1",
          plane: "narr",
          layer: "bg",
          allow_overlap: true,
          in: 0.4,
          out: 2.6,
          css: "",
          words: [
            { text: "hello", start: 0.4, end: 1.1, ti: 0 },
            { text: "world", start: 1.2 + drift, end: 1.9, ti: 1 },
            { text: "today", start: 2.0, end: 2.6, ti: 2 },
          ],
        },
      ],
    }),
  );
  return dir;
}

test("isCaptionProject: true only with both plan.json and transcript.json", () => {
  const dir = fixture();
  expect(isCaptionProject(dir)).toBe(true);
  const bare = mkdtempSync(join(tmpdir(), "bare-"));
  writeFileSync(join(bare, "transcript.json"), "{}"); // transcript but no plan
  expect(isCaptionProject(bare)).toBe(false);
});

test("readCaptions: hasSource reflects a source.mp4 awaiting caption generation", () => {
  const seeded = mkdtempSync(join(tmpdir(), "seed-"));
  writeFileSync(join(seeded, "source.mp4"), "fake");
  writeFileSync(join(seeded, "index.html"), "<html></html>");
  const r = readCaptions(seeded);
  expect(r.isCaptionProject).toBe(false); // no plan.json yet
  expect(r.hasSource).toBe(true); // but a video is present → "generate" stage
  expect(readCaptions(fixture()).hasSource).toBe(false); // fixture has no source.mp4
});

test("readCaptions surfaces engine, granularity, and ti-anchored words", () => {
  const r = readCaptions(fixture());
  expect(r.isCaptionProject).toBe(true);
  expect(r.approved).toBe(false);
  expect(r.engine).toBe("whisperx(small+wav2vec2)");
  expect(r.granularity).toBe("word");
  expect(r.groups.length).toBe(1);
  expect(r.groups[0].words.map((w) => w.text)).toEqual(["hello", "world", "today"]);
  expect(r.groups[0].words.map((w) => w.ti)).toEqual([0, 1, 2]);
});

test("approve: aligned plan passes the 80ms gate and writes the marker", async () => {
  const dir = fixture();
  const r = await approveCaptions(dir, []);
  expect(r.gate.passed).toBe(true);
  expect(r.approved).toBe(true);
  expect(existsSync(approvedMarker(dir))).toBe(true);
});

test("approve: drifted plan fails the gate, refuses the marker", async () => {
  const dir = fixture({ drift: 0.3 }); // 300ms > 80ms tolerance
  const r = await approveCaptions(dir, []);
  expect(r.gate.passed).toBe(false);
  expect(r.approved).toBe(false);
  expect(r.gate.failures.length).toBeGreaterThan(0);
  expect(r.gate.failures.some((f) => /drift/.test(f))).toBe(true);
  expect(existsSync(approvedMarker(dir))).toBe(false);
});

test("approve: a text edit syncs BOTH plan.json and transcript.json (keeps the gate passing)", async () => {
  const dir = fixture();
  const r = await approveCaptions(dir, [{ ti: 1, text: "WORLD" }]);
  expect(r.approved).toBe(true); // timings unchanged → still passes
  const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
  const tr = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
  expect(plan.groups[0].words[1].text).toBe("WORLD");
  expect(tr.words[1].text).toBe("WORLD");
  // timings preserved
  expect(plan.groups[0].words[1].start).toBe(1.2);
  expect(tr.words[1].start).toBe(1.2);
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isValidMountName,
  parseMediaMountPath,
  resolveMediaMount,
  normalizeMediaRoots,
  readProjectMediaRoots,
} from "./mediaRoots.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function tmpDir(prefix = "hf-mediaroots-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe("isValidMountName", () => {
  it("accepts a single safe segment, rejects traversal/slashes/dots", () => {
    for (const ok of ["imported", "vid_2", "a-b", "ABC"]) expect(isValidMountName(ok)).toBe(true);
    for (const bad of ["", "a/b", "..", "a.b", "a b", "a/../b", "."])
      expect(isValidMountName(bad)).toBe(false);
  });
});

describe("parseMediaMountPath", () => {
  it("splits external/<mount>/<rest>, tolerating a leading slash", () => {
    expect(parseMediaMountPath("external/imported/ep1.mp4")).toEqual({
      mount: "imported",
      rest: "ep1.mp4",
    });
    expect(parseMediaMountPath("/external/imported/a/b.mp4")).toEqual({
      mount: "imported",
      rest: "a/b.mp4",
    });
  });

  it("returns null for non-external paths, missing rest, or bad mount name", () => {
    expect(parseMediaMountPath("assets/ep1.mp4")).toBeNull();
    expect(parseMediaMountPath("external/imported")).toBeNull(); // no rest
    expect(parseMediaMountPath("external//ep1.mp4")).toBeNull(); // empty mount
    expect(parseMediaMountPath("external/../ep1.mp4")).toBeNull(); // traversal mount
  });
});

describe("normalizeMediaRoots", () => {
  it("keeps valid entries, resolves relative → absolute, drops junk", () => {
    const projectDir = "/proj";
    const out = normalizeMediaRoots(
      {
        imported: "/abs/videos",
        rel: "media/big",
        "bad name": "/x",
        empty: "   ",
        num: 42,
      },
      projectDir,
    );
    expect(out).toEqual({
      imported: resolve("/abs/videos"),
      rel: resolve(projectDir, "media/big"),
    });
  });

  it("returns {} for non-object / array / null", () => {
    expect(normalizeMediaRoots(null, "/p")).toEqual({});
    expect(normalizeMediaRoots(["/x"], "/p")).toEqual({});
    expect(normalizeMediaRoots("nope", "/p")).toEqual({});
  });
});

describe("resolveMediaMount", () => {
  it("resolves a file within a known mount root", () => {
    const root = tmpDir();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "ep1.mp4"), "x");
    const got = resolveMediaMount({ imported: root }, "external/imported/sub/ep1.mp4");
    expect(got).toBe(join(root, "sub", "ep1.mp4"));
  });

  it("returns null for unknown mount, non-external path, or missing roots", () => {
    const root = tmpDir();
    expect(resolveMediaMount({ imported: root }, "external/other/x.mp4")).toBeNull();
    expect(resolveMediaMount({ imported: root }, "assets/x.mp4")).toBeNull();
    expect(resolveMediaMount(undefined, "external/imported/x.mp4")).toBeNull();
  });

  it("rejects traversal that escapes the mount root", () => {
    const root = tmpDir();
    mkdirSync(join(root, "inside"));
    // ../ escapes the mount — must not resolve to the parent dir
    expect(
      resolveMediaMount({ inside: join(root, "inside") }, "external/inside/../secret"),
    ).toBeNull();
  });
});

describe("readProjectMediaRoots", () => {
  it("reads + validates mediaRoots from hyperframes.json", () => {
    const proj = tmpDir();
    writeFileSync(
      join(proj, "hyperframes.json"),
      JSON.stringify({ mediaRoots: { imported: "/abs/vids", rel: "assets/big" } }),
    );
    expect(readProjectMediaRoots(proj)).toEqual({
      imported: resolve("/abs/vids"),
      rel: resolve(proj, "assets/big"),
    });
  });

  it("returns {} when the file is missing, corrupt, or has no mediaRoots", () => {
    expect(readProjectMediaRoots(tmpDir())).toEqual({}); // no file
    const bad = tmpDir();
    writeFileSync(join(bad, "hyperframes.json"), "{ not json");
    expect(readProjectMediaRoots(bad)).toEqual({});
    const noField = tmpDir();
    writeFileSync(join(noField, "hyperframes.json"), JSON.stringify({ registry: "x" }));
    expect(readProjectMediaRoots(noField)).toEqual({});
  });
});

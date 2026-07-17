#!/usr/bin/env node
// Pre-render guard: clear stale frame caches and confirm /tmp has room.
//
// The engine extracts every frame to /tmp/hyperframes*/hfcache-v3-* (~3.1G for
// 448s@60fps) and does NOT reliably GC them. On 2026-07-17 a leftover cache from
// a previous source filled the 12G tmpfs, extraction stopped ~1400 frames short,
// and the render shipped a FROZEN video while exiting 0.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const NEED_GB = 4;

const dirs = execFileSync(
  "sh",
  ["-c", "ls -d /tmp/hyperframes*/hfcache-v3-* 2>/dev/null || true"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
for (const d of dirs) {
  fs.rmSync(d, { recursive: true, force: true });
  console.log(`  cleared stale frame cache: ${d.split("/").pop()}`);
}

const freeGB =
  parseInt(
    execFileSync("sh", ["-c", "df -B1 --output=avail /tmp | tail -1"], { encoding: "utf8" }).trim(),
    10,
  ) / 1e9;
if (freeGB < NEED_GB) {
  console.error(
    `\n✗ /tmp has only ${freeGB.toFixed(1)}G free, need ~${NEED_GB}G for frame extraction.`,
  );
  console.error(`  A short render would silently FREEZE the video. Free space first.\n`);
  process.exit(1);
}
console.log(`  /tmp: ${freeGB.toFixed(1)}G free ✓`);

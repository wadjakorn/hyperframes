import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { resolveWithinProject } from "./safePath";

/**
 * External media mounts.
 *
 * A composition references media that lives OUTSIDE its project directory
 * through a reserved URL prefix — `external/<mount>/<path>` — where `<mount>`
 * is a name declared in the project's `hyperframes.json` `mediaRoots`:
 *
 *   // hyperframes.json
 *   { "mediaRoots": { "imported": "/abs/path/to/imported-videos" } }
 *
 *   <!-- composition -->
 *   <video src="external/imported/ep1.mp4">
 *
 * This lets large sources (e.g. a multi-hundred-MB video) be served from where
 * they already live instead of being copied/hardlinked into the project's
 * assets folder. Both file servers (preview + render capture) resolve the mount
 * through `resolveMediaMount`, which stays symlink-safe via `resolveWithinProject`.
 */
export const MEDIA_MOUNT_PREFIX = "external";

const MOUNT_NAME = /^[a-zA-Z0-9_-]+$/;

/** A mount name is a single safe path segment (no dots, slashes, or traversal). */
export function isValidMountName(name: string): boolean {
  return MOUNT_NAME.test(name);
}

/**
 * Split a served request path into `{ mount, rest }` when it targets an external
 * mount, else `null`. Tolerates a leading slash; `rest` is the path within the
 * mount (must be non-empty). A malformed mount name yields `null` (→ 404).
 */
export function parseMediaMountPath(requestPath: string): { mount: string; rest: string } | null {
  const p = String(requestPath).replace(/^\/+/, "");
  const m = /^external\/([^/]+)\/(.+)$/.exec(p);
  if (!m) return null;
  const mount = m[1]!;
  const rest = m[2]!;
  if (!isValidMountName(mount)) return null;
  return { mount, rest };
}

/**
 * Resolve an `external/<mount>/<path>` request to an absolute file contained
 * within the mount's root (symlink-safe). Returns `null` when the path is not an
 * external mount, the mount is unknown, or the path escapes the root — every
 * such case falls through to a 404 at the call site, never a served file.
 */
export function resolveMediaMount(
  mediaRoots: Record<string, string> | undefined,
  requestPath: string,
): string | null {
  if (!mediaRoots) return null;
  const parsed = parseMediaMountPath(requestPath);
  if (!parsed) return null;
  const root = mediaRoots[parsed.mount];
  if (!root) return null;
  return resolveWithinProject(root, parsed.rest);
}

/**
 * Validate a raw `mediaRoots` object: keep only entries whose key is a safe
 * mount name and whose value is a non-empty string, resolving each value to an
 * absolute path (relative values resolve against `projectDir`). Anything else is
 * dropped, so a malformed config disables the feature rather than serving junk.
 */
export function normalizeMediaRoots(raw: unknown, projectDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>))
    if (isValidMountName(name) && typeof value === "string" && value.trim())
      out[name] = resolve(projectDir, value);
  return out;
}

/**
 * Read + validate `mediaRoots` from a project's `hyperframes.json`. Missing file,
 * corrupt JSON, or a missing/invalid field all yield `{}` (feature inactive).
 * Lives in core so both the preview server (CLI) and the render capture server
 * (producer) can load roots from a project dir without a cross-package edge.
 */
export function readProjectMediaRoots(projectDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(resolve(projectDir, "hyperframes.json"), "utf-8"));
    return normalizeMediaRoots(raw?.mediaRoots, projectDir);
  } catch {
    return {};
  }
}

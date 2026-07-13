/**
 * `hyperframes font freeze` — download the Google Fonts a composition uses into
 * `assets/fonts/` and rewrite the HTML to local `@font-face`, removing the
 * Google Fonts `<link>`/`@import`. This makes renders deterministic (no
 * render-time network) and is the automated fix for the `google_fonts_import`
 * lint rule.
 *
 * Subsetting note: we keep Google's per-script subsets (each `@font-face`'s
 * `unicode-range` is preserved), which is the safe granularity. Glyph-level
 * subsetting is deliberately NOT done — a composition's text can come from
 * variables / sub-comps at render time, so trimming to "used" codepoints could
 * drop glyphs and break the render.
 */

import { defineCommand } from "citty";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import type { Example } from "../_examples.js";
import { c } from "../../ui/colors.js";
import { resolveProject } from "../../utils/project.js";
import { trackCommandFailure } from "../../telemetry/events.js";

export const examples: Example[] = [
  ["Freeze a composition's Google Fonts locally", "hyperframes font freeze"],
  ["Preview the changes without downloading", "hyperframes font freeze --dry-run"],
  ["Target a specific project", "hyperframes font freeze projects/promo"],
];

// Google Fonts serves woff2 only to browsers that advertise support; an old or
// missing UA gets ttf. A current Chrome UA forces the smaller woff2 payloads.
const WOFF2_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface FrozenFace {
  family: string;
  /** e.g. "400" or a variable range "100 900". */
  weight: string;
  /** normal | italic */
  style: string;
  unicodeRange?: string;
  display?: string;
  /** Remote woff2 URL from the Google CSS response. */
  srcUrl: string;
}

/** Slugify a family name for a filesystem-safe font filename. */
export function fontSlug(family: string): string {
  return family
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse woff2 `@font-face` blocks from a Google Fonts CSS2 response. */
export function parseGoogleFontFaces(css: string): FrozenFace[] {
  const faces: FrozenFace[] = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = block[1] ?? "";
    const family = /font-family:\s*['"]?([^;'"]+)['"]?/i.exec(body)?.[1]?.trim();
    const src = /src:\s*url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/i.exec(body);
    if (!family || !src) continue;
    faces.push({
      family,
      weight: /font-weight:\s*([^;]+)/i.exec(body)?.[1]?.trim() || "400",
      style: /font-style:\s*italic/i.test(body) ? "italic" : "normal",
      unicodeRange: /unicode-range:\s*([^;}]+)/i.exec(body)?.[1]?.trim(),
      display: /font-display:\s*([^;]+)/i.exec(body)?.[1]?.trim(),
      srcUrl: src[1]!.replace(/['"]/g, "").trim(),
    });
  }
  return faces;
}

/**
 * Local filename for a face. `subsetIndex` disambiguates multiple unicode-range
 * subsets that otherwise share the same family/weight/style.
 */
export function faceFileName(face: FrozenFace, subsetIndex: number): string {
  const weight = face.weight.replace(/\s+/g, "_");
  const suffix = subsetIndex > 0 ? `-${subsetIndex}` : "";
  return `${fontSlug(face.family)}-${weight}-${face.style}${suffix}.woff2`;
}

/** Emit a local `@font-face` rule pointing at the downloaded file. */
export function buildFrozenFontFaceCss(face: FrozenFace, localPath: string): string {
  const lines = [
    `  font-family: '${face.family}';`,
    `  font-style: ${face.style};`,
    `  font-weight: ${face.weight};`,
    `  font-display: ${face.display || "block"};`,
    `  src: url("${localPath}") format("woff2");`,
  ];
  if (face.unicodeRange) lines.push(`  unicode-range: ${face.unicodeRange};`);
  return `@font-face {\n${lines.join("\n")}\n}`;
}

const GOOGLE_CSS = /fonts\.googleapis\.com\/css/i;
const GOOGLE_HOST = /fonts\.(googleapis|gstatic)\.com/i;
const IMPORT_URL =
  /@import\s+(?:url\(\s*)?['"]?(https?:\/\/fonts\.googleapis\.com\/css[^'")\s]+)/gi;
const IMPORT_STMT = /@import\s+(?:url\(\s*)?['"]?https?:\/\/fonts\.googleapis\.com\/css[^;]*;/gi;

// linkedom's Document is structurally typed; keep the surface we touch minimal.
type DomDoc = ReturnType<typeof parseHTML>["document"];

/** Google Fonts CSS URLs referenced by the composition (`<link>` + `@import`). */
function collectGoogleCssUrls(document: DomDoc, styleTexts: string[]): string[] {
  const urls = new Set<string>();
  for (const link of document.querySelectorAll("link[href]")) {
    const href = link.getAttribute("href") || "";
    if (GOOGLE_CSS.test(href)) urls.add(href.startsWith("//") ? `https:${href}` : href);
  }
  for (const text of styleTexts) for (const m of text.matchAll(IMPORT_URL)) urls.add(m[1]!);
  return [...urls];
}

export interface FreezeResult {
  changed: boolean;
  cssUrls: string[];
  faces: number;
  filesWritten: string[];
  linksRemoved: number;
  importsRemoved: number;
  html: string;
}

const NOOP: Omit<FreezeResult, "html"> = {
  changed: false,
  cssUrls: [],
  faces: 0,
  filesWritten: [],
  linksRemoved: 0,
  importsRemoved: 0,
};

type FetchImpl = typeof fetch;

async function fetchGoogleFaces(urls: string[], fetchImpl: FetchImpl): Promise<FrozenFace[]> {
  const faces: FrozenFace[] = [];
  for (const url of urls) {
    const res = await fetchImpl(url, { headers: { "User-Agent": WOFF2_UA } });
    if (!res.ok) throw new Error(`Google Fonts CSS ${res.status} for ${url}`);
    faces.push(...parseGoogleFontFaces(await res.text()));
  }
  return faces;
}

// Download each unique face into assets/fonts (deduped by src URL) and return
// the parallel local `@font-face` CSS. Skips the network on dry runs.
async function downloadFaces(
  dir: string,
  faces: FrozenFace[],
  fetchImpl: FetchImpl,
  dryRun: boolean,
): Promise<{ css: string[]; filesWritten: string[] }> {
  const fontsDir = join(dir, "assets", "fonts");
  if (!dryRun) mkdirSync(fontsDir, { recursive: true });
  const perKey = new Map<string, number>();
  const bySrc = new Map<string, string>();
  const filesWritten: string[] = [];
  const css: string[] = [];
  for (const face of faces) {
    let localPath = bySrc.get(face.srcUrl);
    if (!localPath) {
      const key = `${fontSlug(face.family)}-${face.weight}-${face.style}`;
      const idx = perKey.get(key) ?? 0;
      perKey.set(key, idx + 1);
      const fileName = faceFileName(face, idx);
      localPath = `assets/fonts/${fileName}`;
      bySrc.set(face.srcUrl, localPath);
      if (!dryRun) {
        const res = await fetchImpl(face.srcUrl, { headers: { "User-Agent": WOFF2_UA } });
        if (!res.ok) throw new Error(`font download ${res.status} for ${face.srcUrl}`);
        writeFileSync(join(fontsDir, fileName), Buffer.from(await res.arrayBuffer()));
      }
      filesWritten.push(localPath);
    }
    css.push(buildFrozenFontFaceCss(face, localPath));
  }
  return { css, filesWritten };
}

// Strip the Google `<link>`/preconnect + `@import`s and append the local faces.
function rewriteHtml(
  document: DomDoc,
  cssRules: string[],
): { linksRemoved: number; importsRemoved: number } {
  let linksRemoved = 0;
  for (const link of [...document.querySelectorAll("link[href]")]) {
    if (GOOGLE_HOST.test(link.getAttribute("href") || "")) {
      link.remove();
      linksRemoved++;
    }
  }
  let importsRemoved = 0;
  for (const style of document.querySelectorAll("style")) {
    const text = style.textContent || "";
    if (IMPORT_STMT.test(text)) {
      style.textContent = text.replace(IMPORT_STMT, "");
      importsRemoved++;
    }
  }
  const styleTag = document.createElement("style");
  styleTag.setAttribute("data-hyperframes-frozen-fonts", "");
  styleTag.textContent = `\n${cssRules.join("\n\n")}\n`;
  const head = document.querySelector("head") || document.documentElement;
  head.appendChild(styleTag);
  return { linksRemoved, importsRemoved };
}

/**
 * Freeze a composition's Google Fonts. Pure w.r.t. its inputs except for the
 * font files it writes under `dir/assets/fonts` (skipped on `dryRun`). `fetchImpl`
 * is injectable so tests can run without network. Returns the rewritten HTML and
 * a summary; `changed:false` (HTML untouched) when there are no Google Fonts.
 */
export async function freezeFonts(
  dir: string,
  html: string,
  opts: { fetchImpl?: FetchImpl; dryRun?: boolean } = {},
): Promise<FreezeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { document } = parseHTML(html);
  const styleTexts = [...document.querySelectorAll("style")].map((s) => s.textContent || "");
  const cssUrls = collectGoogleCssUrls(document, styleTexts);
  if (cssUrls.length === 0) return { ...NOOP, html };

  const faces = await fetchGoogleFaces(cssUrls, fetchImpl);
  if (faces.length === 0) throw new Error("No woff2 @font-face found in the Google Fonts CSS");

  const { css, filesWritten } = await downloadFaces(dir, faces, fetchImpl, opts.dryRun ?? false);
  const { linksRemoved, importsRemoved } = rewriteHtml(document, css);

  return {
    changed: true,
    cssUrls,
    faces: faces.length,
    filesWritten,
    linksRemoved,
    importsRemoved,
    html: document.toString(),
  };
}

function failFreeze(err: unknown, json: boolean): never {
  trackCommandFailure("font freeze", err);
  const message = err instanceof Error ? err.message : String(err);
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(c.error(`Font freeze failed: ${message}`));
  process.exit(1);
}

function reportNoop(json: boolean): void {
  if (json) console.log(JSON.stringify({ ok: true, changed: false }));
  else console.log(`${c.success("◇")}  No Google Fonts to freeze — already deterministic.`);
}

function reportFrozen(result: FreezeResult, dryRun: boolean, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, dryRun, ...result, html: undefined }));
    return;
  }
  const imports = result.importsRemoved ? ` + ${result.importsRemoved} @import` : "";
  const verb = dryRun ? "Would freeze" : "Froze";
  console.log();
  console.log(`  ${c.success("◇")}  ${c.bold(`${verb} ${result.faces} font face(s)`)}`);
  console.log(
    `  ${c.dim(`${result.filesWritten.length} file(s) → assets/fonts/ · removed ${result.linksRemoved} Google <link>${imports}`)}`,
  );
  for (const f of result.filesWritten) console.log(`    ${c.dim("·")} ${f}`);
  if (dryRun) console.log(`  ${c.accent("dry run — nothing written")}`);
  console.log();
}

export default defineCommand({
  meta: {
    name: "freeze",
    description: "Download Google Fonts locally and rewrite to @font-face (deterministic renders)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory (default: current)",
      required: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Report what would change without downloading or writing",
      default: false,
    },
    json: { type: "boolean", description: "Output result as JSON", default: false },
  },
  async run({ args }) {
    const project = resolveProject(args.dir);
    const html = readFileSync(project.indexPath, "utf-8");
    const dryRun = Boolean(args["dry-run"]);
    const json = Boolean(args.json);

    let result: FreezeResult;
    try {
      result = await freezeFonts(project.dir, html, { dryRun });
    } catch (err) {
      failFreeze(err, json);
    }

    if (!result.changed) return reportNoop(json);
    if (!dryRun) writeFileSync(project.indexPath, result.html);
    reportFrozen(result, dryRun, json);
  },
});

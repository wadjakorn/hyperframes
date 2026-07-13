import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fontSlug,
  parseGoogleFontFaces,
  faceFileName,
  buildFrozenFontFaceCss,
  freezeFonts,
  type FrozenFace,
} from "./freeze.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-font-freeze-"));
  tmpDirs.push(dir);
  return dir;
}

// A minimal Google Fonts CSS2 response: two subsets (thai + latin) of one family.
const GOOGLE_CSS = `
/* thai */
@font-face {
  font-family: 'Noto Sans Thai';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/notosansthai/v1/thai400.woff2) format('woff2');
  unicode-range: U+0E01-0E5B, U+200C-200D, U+25CC;
}
/* latin */
@font-face {
  font-family: 'Noto Sans Thai';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/notosansthai/v1/latin700.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`;

const HTML = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;700&display=block" rel="stylesheet">
<style>body{font-family:'Noto Sans Thai',sans-serif}</style>
</head><body></body></html>`;

// Fake fetch: the css URL returns GOOGLE_CSS; any *.woff2 returns bytes.
function mockFetch(): typeof fetch {
  return (async (url: string) => {
    if (String(url).endsWith(".woff2"))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      };
    return { ok: true, status: 200, text: async () => GOOGLE_CSS };
  }) as unknown as typeof fetch;
}

describe("fontSlug", () => {
  it("lowercases and dashes, stripping quotes/symbols", () => {
    expect(fontSlug("Noto Sans Thai")).toBe("noto-sans-thai");
    expect(fontSlug("'DM Sans'")).toBe("dm-sans");
    expect(fontSlug("  Inter+Tight  ")).toBe("inter-tight");
  });
});

describe("parseGoogleFontFaces", () => {
  it("extracts family/weight/style/unicode-range from woff2 faces", () => {
    const faces = parseGoogleFontFaces(GOOGLE_CSS);
    expect(faces).toHaveLength(2);
    expect(faces[0]).toMatchObject({
      family: "Noto Sans Thai",
      weight: "400",
      style: "normal",
      srcUrl: "https://fonts.gstatic.com/s/notosansthai/v1/thai400.woff2",
    });
    expect(faces[0]!.unicodeRange).toContain("U+0E01-0E5B");
  });

  it("ignores non-woff2 faces", () => {
    const ttfOnly = `@font-face { font-family: 'X'; font-weight: 400; src: url(x.ttf) format('truetype'); }`;
    expect(parseGoogleFontFaces(ttfOnly)).toHaveLength(0);
  });
});

describe("faceFileName", () => {
  const face: FrozenFace = {
    family: "Noto Sans Thai",
    weight: "400",
    style: "normal",
    srcUrl: "x",
  };
  it("names by family/weight/style, suffixing extra subsets", () => {
    expect(faceFileName(face, 0)).toBe("noto-sans-thai-400-normal.woff2");
    expect(faceFileName(face, 1)).toBe("noto-sans-thai-400-normal-1.woff2");
    expect(faceFileName({ ...face, weight: "100 900" }, 0)).toBe(
      "noto-sans-thai-100_900-normal.woff2",
    );
  });
});

describe("buildFrozenFontFaceCss", () => {
  it("emits a local @font-face with url() src and preserved unicode-range", () => {
    const css = buildFrozenFontFaceCss(
      { family: "Inter", weight: "400", style: "normal", unicodeRange: "U+0000-00FF", srcUrl: "x" },
      "assets/fonts/inter-400-normal.woff2",
    );
    expect(css).toContain(`font-family: 'Inter';`);
    expect(css).toContain(`src: url("assets/fonts/inter-400-normal.woff2") format("woff2");`);
    expect(css).toContain("unicode-range: U+0000-00FF;");
    expect(css).toContain("font-display: block;");
  });
});

describe("freezeFonts", () => {
  it("downloads faces, writes assets/fonts, and rewrites HTML to local @font-face", async () => {
    const dir = tmpDir();
    const r = await freezeFonts(dir, HTML, { fetchImpl: mockFetch() });
    expect(r.changed).toBe(true);
    expect(r.cssUrls).toHaveLength(1);
    expect(r.faces).toBe(2);
    expect(r.filesWritten).toEqual([
      "assets/fonts/noto-sans-thai-400-normal.woff2",
      "assets/fonts/noto-sans-thai-700-normal.woff2",
    ]);
    // both preconnects + the stylesheet link removed
    expect(r.linksRemoved).toBe(3);

    // files really landed on disk
    const written = readdirSync(join(dir, "assets", "fonts")).sort();
    expect(written).toEqual(["noto-sans-thai-400-normal.woff2", "noto-sans-thai-700-normal.woff2"]);

    // HTML: local faces present, all Google references gone
    expect(r.html).toContain("data-hyperframes-frozen-fonts");
    expect(r.html).toContain('url("assets/fonts/noto-sans-thai-400-normal.woff2")');
    expect(r.html).toContain("unicode-range: U+0E01-0E5B");
    expect(r.html).not.toContain("fonts.googleapis.com");
    expect(r.html).not.toContain("fonts.gstatic.com");
  });

  it("dry run rewrites HTML but writes no files", async () => {
    const dir = tmpDir();
    const r = await freezeFonts(dir, HTML, { fetchImpl: mockFetch(), dryRun: true });
    expect(r.changed).toBe(true);
    expect(r.filesWritten).toHaveLength(2);
    expect(existsSync(join(dir, "assets", "fonts"))).toBe(false);
    expect(r.html).toContain('url("assets/fonts/noto-sans-thai-400-normal.woff2")');
  });

  it("collects and strips a Google Fonts @import too", async () => {
    const dir = tmpDir();
    const html = `<!doctype html><html><head><style>@import url('https://fonts.googleapis.com/css2?family=Inter');
body{font-family:Inter}</style></head><body></body></html>`;
    const r = await freezeFonts(dir, html, { fetchImpl: mockFetch() });
    expect(r.cssUrls).toEqual(["https://fonts.googleapis.com/css2?family=Inter"]);
    expect(r.importsRemoved).toBe(1);
    expect(r.html).not.toContain("@import");
    expect(r.html).not.toContain("fonts.googleapis.com");
  });

  it("no-ops when the composition uses no Google Fonts", async () => {
    const dir = tmpDir();
    const html = `<!doctype html><html><head><style>body{font-family:sans-serif}</style></head><body></body></html>`;
    const r = await freezeFonts(dir, html, { fetchImpl: mockFetch() });
    expect(r.changed).toBe(false);
    expect(r.html).toBe(html);
  });
});

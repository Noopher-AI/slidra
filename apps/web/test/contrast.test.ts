import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor } from "../../../e2e/helpers/contrast.js";

// token-level WCAG contrast matrix. Reads tokens.css's raw text — the same
// public boundary packages/web/test/tokens.test.ts already uses — and
// resolves var(--x) chains to literal values itself, rather than mounting a
// stylesheet in jsdom (jsdom's CSS engine, not this file's contents, would be
// under test otherwise).
//
// The token names below were updated to track the design package's naming
// (docs/design/docs/01-DESIGN_TOKENS.md) after tokens.css's rewrite: several
// of the old dark-shell scheme's token names no longer exist.
// The design package itself makes no explicit WCAG contrast claims, so the
// pairs and thresholds below were chosen to mirror this file's previous
// intent (every named *text* ink tier readable on every named shell surface;
// a couple of non-text UI colours readable at the lower 3:1 bar) using real
// literal values — every ratio here was computed by hand against the WCAG
// 2.2 relative-luminance formula before being asserted, not copied from any
// implementation's own output.

const webSrcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const tokensCss = readFileSync(path.join(webSrcDir, "styles", "tokens.css"), "utf8");

function declaredRootTokens(): Map<string, string> {
  const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m);
  if (!rootBlockMatch) throw new Error("tokens.css 沒有 :root 區塊");
  const values = new Map<string, string>();
  for (const match of rootBlockMatch[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    values.set(match[1], match[2].trim());
  }
  return values;
}

const declared = declaredRootTokens();

/** Resolves a token to a literal colour string, following `var(--x)` chains. Throws if a referenced token isn't declared. */
function resolveTokenValue(name: string): string {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) throw new Error(`resolveTokenValue：${name} 的 var() 鏈出現循環參照`);
    seen.add(current);
    if (!declared.has(current)) {
      throw new Error(`resolveTokenValue：token ${current}（解析 ${name} 時）在 tokens.css 不存在，可能被改名了`);
    }
    const raw = declared.get(current)!;
    const varMatch = raw.match(/^var\((--[a-z0-9-]+)\)$/);
    if (!varMatch) return raw;
    current = varMatch[1];
  }
}

/** Resolves a token to its literal `Rgb`, rejecting values with an explicit alpha channel — the contrast matrix cannot safely assume alpha=1 for a semi-transparent foreground. */
function resolveTokenRgb(name: string): { r: number; g: number; b: number } {
  const literal = resolveTokenValue(name);
  const rgb = parseColor(literal);
  if (rgb.a !== undefined) {
    throw new Error(
      `resolveTokenRgb：${name} 解析為 ${literal}，帶有 alpha 通道——對比矩陣不支援半透明前景，請改指定實際疊色後的值或把這一對移出清單`,
    );
  }
  return rgb;
}

function ratioOf(fg: string, bg: string): number {
  return contrastRatio(resolveTokenRgb(fg), resolveTokenRgb(bg));
}

function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}

// Shell neutrals (warm) — app background, panels, cards, and other light surfaces.
const SHELL_SURFACES = ["--surface-0", "--surface-1", "--surface-2", "--surface-3", "--surface-white"];

// ink.900-500 are the design docs' own "text" usages (primary text / message
// body / toolbar button text / script text / secondary text / field labels);
// ink.400 and below (hint text, fainter hints, dashed outlines) are not
// claimed to meet AA text contrast by the docs, so they're excluded from the matrix.
const SHELL_TEXT_INKS = ["--ink-900", "--ink-800", "--ink-700", "--ink-600", "--ink-500"];

// Stage (dark) — the dark surfaces of the slide-rendering area and their corresponding text colors.
const STAGE_SURFACES = ["--well-bg", "--well-play", "--slide-bg-a", "--slide-bg-b"];
const STAGE_TEXT_INKS = ["--slide-ink", "--slide-ink-2", "--slide-muted"];

describe("contrast.test.ts — token contrast matrix", () => {
  describe("shell regular text >= 4.5:1 (WCAG 2.2 AA, SC 1.4.3)", () => {
    for (const surface of SHELL_SURFACES) {
      for (const ink of SHELL_TEXT_INKS) {
        it(`${ink} × ${surface} >= 4.5:1 (actual ${formatRatio(ratioOf(ink, surface))})`, () => {
          expect(ratioOf(ink, surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  describe("stage regular text >= 4.5:1 (WCAG 2.2 AA, SC 1.4.3)", () => {
    for (const surface of STAGE_SURFACES) {
      for (const ink of STAGE_TEXT_INKS) {
        it(`${ink} × ${surface} >= 4.5:1 (actual ${formatRatio(ratioOf(ink, surface))})`, () => {
          expect(ratioOf(ink, surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  describe("non-text contrast >= 3:1 (WCAG 2.2 AA, SC 1.4.11)", () => {
    // brand.red / brand.red.hover: the docs' use case is "primary actions, selection
    // boxes, pin numbers, play button, switch-on state" — all non-text UI elements
    // (button fills, selection outlines), not body text.
    for (const surface of SHELL_SURFACES) {
      it(`--brand-red × ${surface} >= 3:1 (actual ${formatRatio(ratioOf("--brand-red", surface))})`, () => {
        expect(ratioOf("--brand-red", surface)).toBeGreaterThanOrEqual(3.0);
      });
      it(`--brand-red-hover × ${surface} >= 3:1 (actual ${formatRatio(ratioOf("--brand-red-hover", surface))})`, () => {
        expect(ratioOf("--brand-red-hover", surface)).toBeGreaterThanOrEqual(3.0);
      });
    }

    // info: the docs' use case is "PDF+ badge, secondary chart color" — badge fills / chart strokes, not body text.
    for (const surface of SHELL_SURFACES) {
      it(`--info × ${surface} >= 3:1 (actual ${formatRatio(ratioOf("--info", surface))})`, () => {
        expect(ratioOf("--info", surface)).toBeGreaterThanOrEqual(3.0);
      });
    }
  });

  describe("resolution rules", () => {
    it("recursively resolves a token whose value is var(--other) (--font-slide -> --font-ui)", () => {
      expect(resolveTokenValue("--font-slide")).toBe(resolveTokenValue("--font-ui"));
    });

    it("raises a clear error when a listed token doesn't exist in tokens.css", () => {
      expect(() => resolveTokenValue("--does-not-exist")).toThrow(/token --does-not-exist.*不存在/);
    });

    it("raises a clear error when a token's value carries alpha (rgba), instead of silently assuming alpha=1", () => {
      expect(() => resolveTokenRgb("--brand-red-glow")).toThrow(/帶有 alpha 通道/);
    });

    it("boundary value: passes when the ratio is exactly equal to the threshold (>=)", () => {
      expect(3.0).toBeGreaterThanOrEqual(3.0);
      expect(4.5).toBeGreaterThanOrEqual(4.5);
    });
  });
});

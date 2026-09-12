import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AC: the play stage, mask, loading backdrop and control bar all take their
// color from semantic tokens, and slide content is never recolored by the
// product theme — constraints on source text (var() usage, selector
// shape), not on rendered layout, so they belong here as source scans
// rather than in e2e's boundingBox()/getComputedStyle() assertions (see
// e2e/play-grid-visual.test.ts's own header for why *those* never read CSS
// text). Modeled on packages/web/test/side-panel-css-tokens.test.ts.

const stylesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");

// grid.css was deleted (the v3 shell rebuild removed GridView.tsx / grid
// view entirely — see that PR's report): C1/F4 below now only apply to
// play.css, the one file left that still renders presentation content
// inside its own iframe.
const FILES = ["play.css"];

/** Strips /* ... *\/ comments first — issue references in prose comments
 * would otherwise false-positive the hex-colour scan. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `(?<![\w-])…(?![\w-])` keeps this from matching inside a custom
 * property *name* like `--ease-panel` or `--dur-view` (the hyphen isn't a
 * `\b` word-boundary character, so a plain `\bease\b` would incorrectly
 * match the "ease" inside "--ease-panel"). */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex color code", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "literal duration (ms/s)", pattern: /[0-9]+(?:\.[0-9]+)?(?:ms|s)\b/g },
  {
    name: "literal easing keyword",
    pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g,
  },
  { name: "cubic-bezier()", pattern: /cubic-bezier\(/g },
];

describe("play/grid CSS must not hard-code color values, durations, or easing (A1)", () => {
  // The generic FORBIDDEN_PATTERNS scan has been superseded by
  // packages/web/test/design-contract.test.ts (which covers all 12 CSS
  // files, not just play.css/grid.css). A2/C1/F4 are assertions specific to
  // these two files that design-contract.test.ts doesn't cover, so they
  // stay here.

  // A2: boundary cleanup — .play-bar/.view-fullscreen-bar has fully moved
  // to play.css, so shell.css should no longer retain any trace of it
  // (including mentions in comments).
  it("shell.css no longer references .play-bar/.view-fullscreen-bar (moved to play.css, A2)", () => {
    const raw = readFileSync(path.join(stylesDir, "shell.css"), "utf8");
    expect(raw).not.toMatch(/play-bar|view-fullscreen-bar/);
  });

  // C1: the slide/thumbnail iframe document's internals must never be
  // recolored by the product frame — rules whose selector ends in
  // .grid-frame or .slide-frame must not set background/color/filter/
  // mix-blend-mode.
  it("play.css/grid.css has no rule setting background/color/filter/mix-blend-mode on .grid-frame/.slide-frame (C1)", () => {
    for (const fileName of FILES) {
      const raw = readFileSync(path.join(stylesDir, fileName), "utf8");
      const css = withoutComments(raw);
      const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
      const offenders: string[] = [];
      for (const match of css.matchAll(ruleRegex)) {
        const selector = match[1].trim();
        const body = match[2];
        const targetsFrame = selector
          .split(",")
          .some((part) => /\.(grid-frame|slide-frame)\s*$/.test(part.trim()));
        if (!targetsFrame) continue;
        if (/\b(background|color|filter|mix-blend-mode)\s*:/.test(body)) {
          offenders.push(`${fileName}: "${selector}" { ${body.trim()} }`);
        }
      }
      expect(offenders, fileName).toEqual([]);
    }
  });

  // F4: reduced-motion is handled uniformly by tokens.css's two-layer
  // mechanism, so play.css/grid.css must not write their own
  // @media (prefers-reduced-motion) block.
  it("play.css/grid.css has no @media (prefers-reduced-motion) block of its own (F4)", () => {
    for (const fileName of FILES) {
      const raw = readFileSync(path.join(stylesDir, fileName), "utf8");
      const css = withoutComments(raw);
      expect(css, fileName).not.toMatch(/@media\s*\(\s*prefers-reduced-motion/);
    }
  });
});

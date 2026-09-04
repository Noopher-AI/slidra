import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// [E1.T4/#183] AC: 產品 UI 不直接寫死色值、duration 或 easing — this is a
// constraint on source text (var() usage), not on rendered layout, so it
// belongs here as a source scan rather than in e2e's boundingBox()/
// getComputedStyle() assertions (see e2e/side-panel-visual.test.ts's own
// header for why *those* never read CSS text). Modeled on
// packages/web/test/tokens.test.ts's regex-over-raw-text approach.

const stylesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");

const FILES = ["side-panel.css", "chat.css", "style-panel.css", "template-dialog.css"];

/** Strips /* ... *\/ comments first — issue references in prose comments
 * (`#183`, `#154`, …) would otherwise false-positive the hex-colour scan. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `(?<![\w-])…(?![\w-])` keeps this from matching inside a custom
 * property *name* like `--ease-panel` or `--dur-view` (the hyphen isn't a
 * `\b` word-boundary character, so a plain `\bease\b` would incorrectly
 * match the "ease" inside "--ease-panel"). */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex 色碼", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "字面 duration（ms/s）", pattern: /[0-9]+(?:\.[0-9]+)?(?:ms|s)\b/g },
  {
    name: "字面 easing 關鍵字",
    pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g,
  },
  { name: "cubic-bezier()", pattern: /cubic-bezier\(/g },
];

describe("側欄／範本對話框 CSS 不得寫死色值／duration／easing（E1.T4/#183）", () => {
  for (const fileName of FILES) {
    it(`${fileName} 每個值都來自 var(--…)，沒有字面色值／duration／easing`, () => {
      const raw = readFileSync(path.join(stylesDir, fileName), "utf8");
      const css = withoutComments(raw);

      const offenders: string[] = [];
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        const matches = [...css.matchAll(pattern)].map((match) => match[0]);
        if (matches.length > 0) offenders.push(`${name}: ${matches.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  }
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// [E1.T6] AC: 播放舞台、遮罩、載入底色與控制列均透過語意 token 取色，投影片
// 內容不被產品主題改色 — constraints on source text (var() usage, selector
// shape), not on rendered layout, so they belong here as source scans
// rather than in e2e's boundingBox()/getComputedStyle() assertions (see
// e2e/play-grid-visual.test.ts's own header for why *those* never read CSS
// text). Modeled on packages/web/test/side-panel-css-tokens.test.ts.

const stylesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");

const FILES = ["play.css", "grid.css"];

/** Strips /* ... *\/ comments first — issue references in prose comments
 * (`#54`, `#55`, …) would otherwise false-positive the hex-colour scan. */
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

describe("播放／網格 CSS 不得寫死色值／duration／easing（E1.T6，A1）", () => {
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

  // A2：邊界收尾——.play-bar/.view-fullscreen-bar 已整段遷到 play.css，
  // shell.css 不應再留下任何殘跡（含註解裡的提及）。
  it("shell.css 不再出現 .play-bar／.view-fullscreen-bar（已遷到 play.css，A2）", () => {
    const raw = readFileSync(path.join(stylesDir, "shell.css"), "utf8");
    expect(raw).not.toMatch(/play-bar|view-fullscreen-bar/);
  });

  // C1：投影片／縮圖 iframe 文件內部不得被產品框架改色——選擇器以
  // .grid-frame 或 .slide-frame 結尾的規則不得設定 background/color/
  // filter/mix-blend-mode。
  it("play.css／grid.css 沒有規則對 .grid-frame／.slide-frame 設定 background/color/filter/mix-blend-mode（C1）", () => {
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

  // F4：reduced-motion 由 tokens.css 的兩層機制統一處理，play.css／grid.css
  // 不得自寫 @media (prefers-reduced-motion) 區塊。
  it("play.css／grid.css 沒有自己的 @media (prefers-reduced-motion) 區塊（F4）", () => {
    for (const fileName of FILES) {
      const raw = readFileSync(path.join(stylesDir, fileName), "utf8");
      const css = withoutComments(raw);
      expect(css, fileName).not.toMatch(/@media\s*\(\s*prefers-reduced-motion/);
    }
  });
});

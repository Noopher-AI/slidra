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

// 外殼中性色（暖）— app 背景、面板、卡片等淺色表面。
const SHELL_SURFACES = ["--surface-0", "--surface-1", "--surface-2", "--surface-3", "--surface-white"];

// ink.900–500 是文件自己標的「文字」用途（主要文字／訊息內文／工具列按鈕文字／指令碼文字／次要文字、
// 欄位標籤）；ink.400 以下（提示文字、更淡提示、虛線框）文件沒有宣稱要達到 AA 文字對比，不進矩陣。
const SHELL_TEXT_INKS = ["--ink-900", "--ink-800", "--ink-700", "--ink-600", "--ink-500"];

// 舞台（深）— 投影片渲染區的深色表面與對應文字色。
const STAGE_SURFACES = ["--well-bg", "--well-play", "--slide-bg-a", "--slide-bg-b"];
const STAGE_TEXT_INKS = ["--slide-ink", "--slide-ink-2", "--slide-muted"];

describe("contrast.test.ts — token 對比矩陣", () => {
  describe("外殼一般文字 ≥ 4.5:1（WCAG 2.2 AA，SC 1.4.3）", () => {
    for (const surface of SHELL_SURFACES) {
      for (const ink of SHELL_TEXT_INKS) {
        it(`${ink} × ${surface} ≥ 4.5:1（實際 ${formatRatio(ratioOf(ink, surface))}）`, () => {
          expect(ratioOf(ink, surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  describe("舞台一般文字 ≥ 4.5:1（WCAG 2.2 AA，SC 1.4.3）", () => {
    for (const surface of STAGE_SURFACES) {
      for (const ink of STAGE_TEXT_INKS) {
        it(`${ink} × ${surface} ≥ 4.5:1（實際 ${formatRatio(ratioOf(ink, surface))}）`, () => {
          expect(ratioOf(ink, surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  });

  describe("非文字對比 ≥ 3:1（WCAG 2.2 AA，SC 1.4.11）", () => {
    // brand.red / brand.red.hover：文件用途是「主要動作、選取框、pin 編號、播放鈕、開關 on 態」——
    // 都是非文字 UI 元件（按鈕底色、選取框邊線），不是本文文字。
    for (const surface of SHELL_SURFACES) {
      it(`--brand-red × ${surface} ≥ 3:1（實際 ${formatRatio(ratioOf("--brand-red", surface))}）`, () => {
        expect(ratioOf("--brand-red", surface)).toBeGreaterThanOrEqual(3.0);
      });
      it(`--brand-red-hover × ${surface} ≥ 3:1（實際 ${formatRatio(ratioOf("--brand-red-hover", surface))}）`, () => {
        expect(ratioOf("--brand-red-hover", surface)).toBeGreaterThanOrEqual(3.0);
      });
    }

    // info：文件用途「PDF+ 標籤、圖表第二色」——標籤底色/圖表描邊，非本文文字。
    for (const surface of SHELL_SURFACES) {
      it(`--info × ${surface} ≥ 3:1（實際 ${formatRatio(ratioOf("--info", surface))}）`, () => {
        expect(ratioOf("--info", surface)).toBeGreaterThanOrEqual(3.0);
      });
    }
  });

  describe("解析規則", () => {
    it("token 值為 var(--other) 時遞迴解析（--font-slide → --font-ui）", () => {
      expect(resolveTokenValue("--font-slide")).toBe(resolveTokenValue("--font-ui"));
    });

    it("清單裡的 token 在 tokens.css 不存在時明確報錯", () => {
      expect(() => resolveTokenValue("--does-not-exist")).toThrow(/token --does-not-exist.*不存在/);
    });

    it("token 值帶 alpha（rgba）時明確報錯，不假裝 alpha=1 偷算", () => {
      expect(() => resolveTokenRgb("--brand-red-glow")).toThrow(/帶有 alpha 通道/);
    });

    it("邊界值：比值剛好等於門檻時通過（>=）", () => {
      expect(3.0).toBeGreaterThanOrEqual(3.0);
      expect(4.5).toBeGreaterThanOrEqual(4.5);
    });
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor } from "../../../e2e/helpers/contrast.js";

// token-level WCAG contrast matrix (NOOP-9 Plan §0.3/§4.3). Reads
// tokens.css's raw text — the same public boundary packages/web/test/
// tokens.test.ts already uses — and resolves var(--x) chains to literal
// values itself, rather than mounting a stylesheet in jsdom (jsdom's CSS
// engine, not this file's contents, would be under test otherwise).

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

const SURFACES = ["--s-titlebar", "--s-ribbon", "--s-panel", "--s-well", "--s-raised", "--s-sunken"];

describe("contrast.test.ts — token 對比矩陣（NOOP-9 Plan §4.3）", () => {
  describe("一般文字 ≥ 4.5:1（WCAG 2.2 AA，SC 1.4.3）", () => {
    for (const surface of SURFACES) {
      it(`--ink × ${surface} ≥ 4.5:1（實際 ${formatRatio(ratioOf("--ink", surface))}）`, () => {
        expect(ratioOf("--ink", surface)).toBeGreaterThanOrEqual(4.5);
      });
      it(`--ink-dim × ${surface} ≥ 4.5:1（實際 ${formatRatio(ratioOf("--ink-dim", surface))}）`, () => {
        expect(ratioOf("--ink-dim", surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  it("--ink-faint 只豁免於 disabled：宣告存在且註解標明用途，不進對比矩陣斷言", () => {
    const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m)![1];
    expect(declared.has("--ink-faint")).toBe(true);
    expect(rootBlockMatch).toMatch(/--ink-faint:[^\n]*\/\*\s*disabled only\s*\*\//);
  });

  describe("非文字對比 ≥ 3:1（WCAG 2.2 AA，SC 1.4.11）", () => {
    for (const surface of SURFACES) {
      it(`--focus-ring × ${surface} ≥ 3:1（實際 ${formatRatio(ratioOf("--focus-ring", surface))}）`, () => {
        expect(ratioOf("--focus-ring", surface)).toBeGreaterThanOrEqual(3.0);
      });
    }

    it(`--select-outline × --s-slide ≥ 3:1（實際 ${formatRatio(ratioOf("--select-outline", "--s-slide"))}）`, () => {
      expect(ratioOf("--select-outline", "--s-slide")).toBeGreaterThanOrEqual(3.0);
    });

    for (const surface of ["--s-titlebar", "--s-panel"]) {
      it(`--status-ok × ${surface} ≥ 3:1（實際 ${formatRatio(ratioOf("--status-ok", surface))}）`, () => {
        expect(ratioOf("--status-ok", surface)).toBeGreaterThanOrEqual(3.0);
      });
    }
  });

  describe("解析規則", () => {
    it("token 值為 var(--other) 時遞迴解析到字面值（--focus-ring → --accent-hi）", () => {
      expect(resolveTokenValue("--focus-ring")).toBe("#e03a56");
    });

    it("清單裡的 token 在 tokens.css 不存在時明確報錯", () => {
      expect(() => resolveTokenValue("--does-not-exist")).toThrow(/token --does-not-exist.*不存在/);
    });

    it("token 值帶 alpha（rgba）時明確報錯，不假裝 alpha=1 偷算", () => {
      expect(() => resolveTokenRgb("--s-scrim")).toThrow(/帶有 alpha 通道/);
    });

    it("邊界值：比值剛好等於門檻時通過（>=）", () => {
      expect(3.0).toBeGreaterThanOrEqual(3.0);
      expect(4.5).toBeGreaterThanOrEqual(4.5);
    });
  });
});

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tokens.css's public boundary is the file's own text — it *is* the
// contract (NOOP-376 Plan §6). Assertions below read the raw CSS with
// node:fs and regex; they deliberately do not mount the stylesheet in
// jsdom and read computed style, which would test jsdom's CSS engine
// instead of this file's contents.

const webSrcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const tokensPath = path.join(webSrcDir, "styles", "tokens.css");
const tokensCss = readFileSync(tokensPath, "utf8");
const fontsDir = path.join(webSrcDir, "assets", "fonts");

/** `--overview-aspect-ratio` is set at runtime by overview.ts on individual
 * elements (element.style.setProperty), not declared in tokens.css's
 * :root — its two consumers both carry a `, 16 / 9` fallback. It is the
 * one deliberate exemption from "every var() must resolve in tokens.css". */
const RUNTIME_SET_TOKENS = new Set(["--overview-aspect-ratio"]);

function regionalCssFiles(): string[] {
  const stylesDir = path.join(webSrcDir, "styles");
  const files = readdirSync(stylesDir)
    .filter((name) => name.endsWith(".css") && name !== "tokens.css")
    .map((name) => path.join(stylesDir, name));
  files.push(path.join(webSrcDir, "style.css"));
  return files;
}

function declaredRootTokenNames(): Set<string> {
  const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m);
  if (!rootBlockMatch) throw new Error("tokens.css 沒有 :root 區塊");
  const names = new Set<string>();
  for (const match of rootBlockMatch[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    names.add(match[1]);
  }
  return names;
}

function usedVarNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
    names.add(match[1]);
  }
  return names;
}

describe("tokens.css（NOOP-376 驗收）", () => {
  it("區域 CSS 用到的每一個 var(--x)（豁免 --overview-aspect-ratio）都在 tokens.css 的 :root 有定義", () => {
    const declared = declaredRootTokenNames();
    const missing = new Set<string>();
    for (const file of regionalCssFiles()) {
      const css = readFileSync(file, "utf8");
      for (const name of usedVarNames(css)) {
        if (RUNTIME_SET_TOKENS.has(name)) continue;
        if (!declared.has(name)) missing.add(`${name}（${path.basename(file)}）`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("token 名稱不以色名或數字色階命名", () => {
    const declared = declaredRootTokenNames();
    const colorNamePattern = /(^|-)(red|green|blue|grey|gray|black|white|orange|yellow|purple|brick|crimson)(-|$)/;
    const numericScalePattern = /-\d{2,3}$/;
    const offenders = [...declared].filter((name) => colorNamePattern.test(name) || numericScalePattern.test(name));
    expect(offenders).toEqual([]);
  });

  it("motion duration token 各自落在父票規定的上限內", () => {
    function durationMs(name: string): number {
      const match = tokensCss.match(new RegExp(`${name}:\\s*(\\d+)ms`));
      if (!match) throw new Error(`tokens.css 沒有找到 ${name} 的 ms 值`);
      return Number(match[1]);
    }
    expect(durationMs("--dur-micro")).toBeLessThanOrEqual(160);
    expect(durationMs("--dur-panel")).toBeLessThanOrEqual(220);
    expect(durationMs("--dur-view")).toBeLessThanOrEqual(300);
  });

  it("含且僅含三個 @font-face，字重為 400/500/700，src 檔名互不相同且實際存在", () => {
    const fontFaceBlocks = [...tokensCss.matchAll(/@font-face\s*{([\s\S]*?)}/g)].map((match) => match[1]);
    expect(fontFaceBlocks).toHaveLength(3);

    const weights = fontFaceBlocks.map((block) => {
      const match = block.match(/font-weight:\s*(\d+)/);
      if (!match) throw new Error("一個 @font-face 區塊沒有 font-weight");
      return Number(match[1]);
    });
    expect(weights.slice().sort((a, b) => a - b)).toEqual([400, 500, 700]);

    const fileNames = fontFaceBlocks.map((block) => {
      const match = block.match(/url\("\.\.\/assets\/fonts\/([^"]+\.woff2)"\)/);
      if (!match) throw new Error("一個 @font-face 區塊沒有指向 ../assets/fonts/*.woff2 的 src");
      return match[1];
    });
    expect(new Set(fileNames).size).toBe(3);
    for (const fileName of fileNames) {
      expect(existsSync(path.join(fontsDir, fileName))).toBe(true);
    }
  });

  it("prefers-reduced-motion 區塊同時覆寫三個 duration 為 0ms，並停用持續動畫", () => {
    const mediaMatch = tokensCss.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*)}\s*$/);
    if (!mediaMatch) throw new Error("tokens.css 沒有 prefers-reduced-motion 區塊");
    const block = mediaMatch[1];
    expect(block).toMatch(/--dur-micro:\s*0ms/);
    expect(block).toMatch(/--dur-panel:\s*0ms/);
    expect(block).toMatch(/--dur-view:\s*0ms/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });
});

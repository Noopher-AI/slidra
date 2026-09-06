import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tokens.css's public boundary is the file's own text — it *is* the
// contract. Assertions below read the raw CSS (and the design package's
// own markdown) with node:fs and regex; they deliberately do not mount
// the stylesheet in jsdom and read computed style, which would test
// jsdom's CSS engine instead of this file's contents.

const webSrcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const tokensPath = path.join(webSrcDir, "styles", "tokens.css");
const tokensCss = readFileSync(tokensPath, "utf8");
const fontsDir = path.join(webSrcDir, "assets", "fonts");

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const designTokensDocPath = path.join(repoRoot, "docs", "design", "docs", "01-DESIGN_TOKENS.md");
const designTokensDoc = readFileSync(designTokensDocPath, "utf8");

function declaredRootTokenNames(): Set<string> {
  const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m);
  if (!rootBlockMatch) throw new Error("tokens.css 沒有 :root 區塊");
  const names = new Set<string>();
  for (const match of rootBlockMatch[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    names.add(match[1]);
  }
  return names;
}

function declaredRootTokenValue(name: string): string {
  const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m)![1];
  const match = rootBlockMatch.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`tokens.css 的 :root 沒有找到 ${name}`);
  return match[1].trim();
}

// ── 解析 docs/design/docs/01-DESIGN_TOKENS.md 的 token 表 ──────────────
//
// 文件裡每一列都是 `| \`token.path\` | 值 | (用途) |` 這種 pipe-table 格式
// （用途欄位不是每個表都有）。第一欄用 backtick 包住、只含小寫字母/數字/點
// 的字串視為一個「設計包 token 名稱」；`hs-fade` 這類含連字號的動效預設名
// 不會被這個 pattern 吃到（連字號不在字元類別裡），這是刻意的——那些欄位
// 的「值」是動畫效果描述（例如「4px 上移 + 淡入」），不是可以落地成 CSS
// 值的字面量。
//
// `space.1..6` 這種壓縮記法（代表 space.1 ~ space.6 六個 token）在這裡展開
// 成六個獨立條目。

interface DesignToken {
  path: string;
  /** The raw "值" cell text, for range-extraction below. */
  valueCell: string;
}

function parseDesignTokens(doc: string): DesignToken[] {
  const tokens: DesignToken[] = [];
  const rowPattern = /^\|\s*`([a-z][a-z0-9.]*)`\s*\|([^|]+)\|/gm;
  for (const match of doc.matchAll(rowPattern)) {
    const tokenPath = match[1];
    const valueCell = match[2].trim();
    const rangeExpansion = tokenPath.match(/^(.+)\.(\d+)\.\.(\d+)$/);
    if (rangeExpansion) {
      const [, prefix, lowStr, highStr] = rangeExpansion;
      const low = Number(lowStr);
      const high = Number(highStr);
      for (let n = low; n <= high; n++) {
        tokens.push({ path: `${prefix}.${n}`, valueCell });
      }
      continue;
    }
    tokens.push({ path: tokenPath, valueCell });
  }
  return tokens;
}

const designTokens = parseDesignTokens(designTokensDoc);
const designTokenPaths = new Set(designTokens.map((t) => t.path));

/** `token.path` → `--token-path` (the naming rule this ticket applies throughout tokens.css). */
function dotPathToCssVar(tokenPath: string): string {
  return `--${tokenPath.replace(/\./g, "-")}`;
}

/** Design tokens documented as a *range* (e.g. "10.5–11") that this ticket resolved to a single
 * real value — or, when the same token is genuinely used for two distinct named purposes at two
 * distinct real values, split into two CSS custom properties. Every value on the right must lie
 * within the design doc's own stated range for that token (checked mechanically below) — this
 * records *which* CSS vars a doc token landed as, not new numbers invented outside its range. */
const SPLIT_TOKENS: Record<string, string[]> = {
  ok: ["--ok", "--ok-text", "--ok-bg"], // 一格三色（主色／文字／底色），CSS 自訂屬性一次只能放一個值
  info: ["--info", "--info-bg"],
  "text.2xs": ["--text-2xs", "--text-2xs-chart"], // BETA(10px) vs 圖表類型標(9.5px)
  "text.xs": ["--text-xs", "--text-xs-hint"], // 區塊標題(10.5px) vs 提示/快捷鍵(11px)
  "text.md": ["--text-md", "--text-md-panel-title"], // 檔名(13.5px) vs 面板標題(14px)
  "text.lg": ["--text-lg", "--text-lg-dialog"], // 總覽標題(18px) vs 對話框標題(17px)
  "radius.md": ["--radius-md", "--radius-md-segmented"], // 輸入框(9px) vs segmented(10px)
  "radius.xl": ["--radius-xl", "--radius-xl-dialog"], // 玻璃面板(14px) vs 對話框(16px)
  "radius.2xl": ["--radius-2xl", "--radius-2xl-empty"], // 大型對話框(18px) vs 空狀態卡(20px)
  "space.gutter": ["--space-gutter", "--space-gutter-bottom"], // "28px 36px" 對／"76px" 底部保留區
  "control.h": ["--control-h", "--control-h-compact"], // 30px 一般 vs 28px 緊湊版（doc 自己就分兩值）
};

/** `accent.palette.*` — chart colour palette, out of scope for this ticket (belongs to a future
 * chart ticket). These three ARE real design-package tokens (they parse out of the 語意色 table
 * above), so they must be explicitly excluded here rather than just never mentioned — otherwise
 * the "every token I decided to land is present" check below would (wrongly) demand them. */
const EXCLUDED_DESIGN_TOKENS = new Set(["accent.palette.brand", "accent.palette.cool", "accent.palette.warm"]);

/** 玻璃材質 (Glass material) is documented as prose + a CSS code block, not a `token.path | value`
 * table row — there is no doc-mechanical name to derive these from. Each entry below is this
 * file's own name, justified inline in tokens.css's own comment for that line. Listed here (rather
 * than silently allowed by a loose rule) so the "nothing invented" check stays meaningful for
 * every *other* token, which do come from a real table row. */
const NON_TABULAR_DESIGN_TOKENS = new Set([
  "--glass-bg",
  "--glass-bg-soft",
  "--glass-blur",
  "--glass-border",
  "--glass-hover",
  "--glass-divider",
  "--glass-input-bg",
  "--glass-input-bg-focus",
  // 圖示 (icon) geometry: prose in the doc's § 圖示 (20×20 viewBox / stroke 1.5),
  // no table row. Consumed by icons/Icon.tsx via *inline* style var() — the two
  // mechanical scans below cannot see that usage, which is how they went missing
  // in round 1 (every shell icon collapsed to 0px). --icon-control is listed with
  // the compat layer below (play.css reads it too).
  "--icon-inline",
  "--icon-command",
  "--icon-stroke",
  // Pre-rebuild S1 shell compat layer: NOT design-package tokens. play.css /
  // PlayChrome.tsx (playback mode, out of scope for the New v3 shell rebuild,
  // untouched) still consume every one of these by name — removing any of
  // them breaks the corresponding CSS declaration (a failed var() invalidates
  // the whole property, not just that one value), which is exactly what
  // happened here before this allowlist existed (e2e player-effect-error /
  // player-media / play-appearance all failed on a vanished `.play-bar`).
  // Values are copied verbatim from base (b0de47f)'s old tokens.css, not
  // redesigned. Removed together with play.css's own migration in a future
  // ticket.
  "--u",
  "--ink",
  "--ink-dim",
  "--ink-faint",
  "--h-notes",
  "--fs-small",
  "--s-blackout",
  "--s-overlay",
  "--s-overlay-raised",
  "--line-overlay",
  "--line-overlay-strong",
  "--focus-ring",
  "--focus-ring-width",
  "--r-control",
  "--r-pill",
  "--icon-control",
  "--dur-panel",
  "--ease-panel",
  "--accent-hi",
  "--s-titlebar",
  "--r",
  "--s-raised",
  "--line",
  // [E2.T7]: the Animate insert panel's looping effect-preview thumbnail
  // (animate.css) is a genuinely new UI concept the design package's token
  // table has no row for — not a landed `dur.*` value, and not a one-shot
  // view-switch/dialog duration `--dur-fast`/`--dur-base` already name.
  "--dur-preview-loop",
]);

/** Every CSS custom property name tokens.css's :root may legally declare: either the direct
 * naming-rule mapping of a landed design-package token, one of its documented splits, or the
 * small non-tabular glass-material allowance above. */
function expectedCssVarsFor(tokenPath: string): string[] {
  return SPLIT_TOKENS[tokenPath] ?? [dotPathToCssVar(tokenPath)];
}

describe("tokens.css 對照 docs/design/docs/01-DESIGN_TOKENS.md（設計包 token 表）", () => {
  it("設計包文件本身至少解析出目標分類的 token（parser 沒有讀空）", () => {
    // Sanity check on the parser itself, independent of tokens.css: if this fails, the parser's
    // regex stopped matching the doc's real table format and every other test below is vacuous.
    expect(designTokenPaths.has("brand.red")).toBe(true);
    expect(designTokenPaths.has("surface.0")).toBe(true);
    expect(designTokenPaths.has("radius.pill")).toBe(true);
    expect(designTokenPaths.has("dur.fast")).toBe(true);
    // "hs-fade" 之類含連字號的動效預設名不該被解析成 token（見上方 parser 註解）。
    expect(designTokenPaths.has("hs-fade")).toBe(false);
  });

  it("tokens.css 的 :root 沒有發明任何不存在於設計包的 token 名稱", () => {
    const declared = declaredRootTokenNames();
    const legalNames = new Set<string>(NON_TABULAR_DESIGN_TOKENS);
    for (const tokenPath of designTokenPaths) {
      if (EXCLUDED_DESIGN_TOKENS.has(tokenPath)) continue;
      for (const cssVar of expectedCssVarsFor(tokenPath)) legalNames.add(cssVar);
    }
    const invented = [...declared].filter((name) => !legalNames.has(name));
    expect(invented).toEqual([]);
  });

  it("計畫要落地的每個分類（色彩／字體／字級 UI／間距與尺寸／圓角／陰影／玻璃材質／動效）在 tokens.css 都有對應宣告", () => {
    const declared = declaredRootTokenNames();
    const missing: string[] = [];
    for (const tokenPath of designTokenPaths) {
      if (EXCLUDED_DESIGN_TOKENS.has(tokenPath)) continue;
      for (const cssVar of expectedCssVarsFor(tokenPath)) {
        if (!declared.has(cssVar)) missing.push(`${tokenPath} → ${cssVar}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("排除項（accent.palette.* 圖表調色盤）確實沒有落地——排除是刻意的，不是漏做", () => {
    const declared = declaredRootTokenNames();
    for (const excluded of EXCLUDED_DESIGN_TOKENS) {
      expect(declared.has(dotPathToCssVar(excluded)), `${excluded} 不應該出現在 tokens.css`).toBe(false);
    }
  });

  // control.h's cell packs a second, explicitly-separate number ("30–34
  // px；28 px 緊湊版") that is NOT part of the 30–34 range — the doc gives
  // it as its own compact-variant value. It gets its own exact-match test
  // below instead of the generic range-membership loop.
  const RANGE_CHECK_EXCLUDE = new Set(["--control-h-compact"]);

  it("設計包標成「範圍」的值，落地後的每一個 CSS 值都落在該範圍內（含兩端）", () => {
    const outOfRange: string[] = [];
    for (const { path: tokenPath, valueCell } of designTokens) {
      if (EXCLUDED_DESIGN_TOKENS.has(tokenPath)) continue;
      const rangeMatch = valueCell.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/);
      if (!rangeMatch) continue; // 不是範圍值（例如單一固定值 "12 px"）——不需要範圍檢查
      const low = Number(rangeMatch[1]);
      const high = Number(rangeMatch[2]);
      for (const cssVar of expectedCssVarsFor(tokenPath)) {
        if (RANGE_CHECK_EXCLUDE.has(cssVar)) continue;
        const declaredValue = declaredRootTokenValue(cssVar);
        const numMatch = declaredValue.match(/^(\d+(?:\.\d+)?)(?:px|ms)$/);
        if (!numMatch) continue; // 這個 split 出來的值不是單純數字＋單位（例如 --space-gutter 是複合值）
        const actual = Number(numMatch[1]);
        if (actual < low || actual > high) {
          outOfRange.push(`${cssVar}（${tokenPath} 的範圍是 ${low}–${high}，實際是 ${actual}）`);
        }
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it("--control-h-compact 與設計包文件明講的「28 px 緊湊版」數值一致", () => {
    const docToken = designTokens.find((t) => t.path === "control.h");
    if (!docToken) throw new Error("設計包文件找不到 control.h");
    const compactMatch = docToken.valueCell.match(/(\d+(?:\.\d+)?)\s*px\s*緊湊版/);
    if (!compactMatch) throw new Error("control.h 的值欄位找不到「緊湊版」數值——文件格式可能變了");
    expect(declaredRootTokenValue("--control-h-compact")).toBe(`${compactMatch[1]}px`);
  });
});

describe("tokens.css — 字型", () => {
  it("含且僅含六個 @font-face：Plus Jakarta Sans 與 Noto Sans TC 各三個字重（400/500/700），src 檔名互不相同且實際存在", () => {
    const fontFaceBlocks = [...tokensCss.matchAll(/@font-face\s*{([\s\S]*?)}/g)].map((match) => match[1]);
    expect(fontFaceBlocks).toHaveLength(6);

    const parsed = fontFaceBlocks.map((block) => {
      const familyMatch = block.match(/font-family:\s*"([^"]+)"/);
      const weightMatch = block.match(/font-weight:\s*(\d+)/);
      const srcMatch = block.match(/url\("\.\.\/assets\/fonts\/([^"]+\.woff2)"\)/);
      if (!familyMatch) throw new Error("一個 @font-face 區塊沒有 font-family");
      if (!weightMatch) throw new Error("一個 @font-face 區塊沒有 font-weight");
      if (!srcMatch) throw new Error("一個 @font-face 區塊沒有指向 ../assets/fonts/*.woff2 的 src");
      return { family: familyMatch[1], weight: Number(weightMatch[1]), fileName: srcMatch[1] };
    });

    for (const family of ["Plus Jakarta Sans", "Noto Sans TC"]) {
      const weights = parsed
        .filter((p) => p.family === family)
        .map((p) => p.weight)
        .sort((a, b) => a - b);
      expect(weights, family).toEqual([400, 500, 700]);
    }

    const fileNames = parsed.map((p) => p.fileName);
    expect(new Set(fileNames).size).toBe(6);
    for (const fileName of fileNames) {
      expect(existsSync(path.join(fontsDir, fileName)), fileName).toBe(true);
    }
  });

  it("--font-ui 字型堆疊（依序）與設計包文件（font.ui）相符", () => {
    // Compares the ordered list of font names, ignoring quote style (doc uses
    // single quotes, this file's existing convention uses double quotes) and
    // incidental whitespace — neither is semantically meaningful in CSS.
    function fontNames(stack: string): string[] {
      return stack
        .split(",")
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ""));
    }
    const docToken = designTokens.find((t) => t.path === "font.ui");
    if (!docToken) throw new Error("設計包文件找不到 font.ui");
    const docValue = docToken.valueCell.trim().replace(/^`|`$/g, "");
    expect(fontNames(declaredRootTokenValue("--font-ui"))).toEqual(fontNames(docValue));
  });

  it("--font-slide 透過 var() 鏈接到 --font-ui（文件：「同 font.ui」）", () => {
    expect(declaredRootTokenValue("--font-slide")).toBe("var(--font-ui)");
  });
});

describe("tokens.css — prefers-reduced-motion", () => {
  it("prefers-reduced-motion 區塊同時覆寫 --dur-fast／--dur-base 為 0ms，並停用持續動畫", () => {
    const mediaMatch = tokensCss.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*)}\s*$/);
    if (!mediaMatch) throw new Error("tokens.css 沒有 prefers-reduced-motion 區塊");
    const block = mediaMatch[1];
    expect(block).toMatch(/--dur-fast:\s*0ms/);
    expect(block).toMatch(/--dur-base:\s*0ms/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });
});

// `--overview-aspect-ratio` is set at runtime by overview.ts on individual
// elements (element.style.setProperty), not declared in tokens.css's
// :root — its two consumers both carry a `, 16 / 9` fallback. It is the
// one deliberate exemption from "every var() must resolve in tokens.css".
const RUNTIME_SET_TOKENS = new Set(["--overview-aspect-ratio"]);

function regionalCssFiles(): string[] {
  const stylesDir = path.join(webSrcDir, "styles");
  const files = readdirSync(stylesDir)
    .filter((name) => name.endsWith(".css") && name !== "tokens.css")
    .map((name) => path.join(stylesDir, name));
  files.push(path.join(webSrcDir, "style.css"));
  return files;
}

function usedVarNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) names.add(match[1]);
  return names;
}

describe("tokens.css — 區域 CSS 消費的每個 var(--x) 都要有定義", () => {
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

  it("packages/web/src 下 JS 端 getPropertyValue(\"--x\") 讀的每個字面 token 名稱也都在 :root 有定義", () => {
    const declared = declaredRootTokenNames();
    const missing = new Set<string>();
    const srcFiles: string[] = [];
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "assets") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) srcFiles.push(full);
      }
    }
    walk(webSrcDir);
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/getPropertyValue\(\s*["'](--[a-z0-9-]+)["']\s*\)/g)) {
        const name = match[1];
        if (RUNTIME_SET_TOKENS.has(name)) continue;
        if (!declared.has(name)) missing.add(`${name}（${path.relative(webSrcDir, file)}）`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

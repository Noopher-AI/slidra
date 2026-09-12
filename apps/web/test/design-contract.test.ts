import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 全域設計契約掃描（NOOP-9 Plan §4.1/§4.2）：所有產品 UI CSS（tokens.css 除
// 外，它是宣告入口，由 tokens.test.ts 用另一組規則守）＋ apps/web/src
// 下的 TS/TSX/JS inline style，都不得直接寫死色值／duration／easing——一律
// 透過 var(--x) 消費 tokens.css。這是對*原始碼文字*的約束（用瀏覽器讀
// computed style 驗不出「值是不是寫成 var(--x)」，var() 解析後和字面值一模
// 一樣），所以跟 tokens.test.ts／side-panel-css-tokens.test.ts 一樣用
// node:fs＋regex 讀原始文字，不掛 jsdom 樣式表。

const webSrcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const stylesDir = path.join(webSrcDir, "styles");

/** Blanks out `/* ... *‌/` comment bodies while preserving line breaks, so line numbers computed from the stripped text still line up with the original file. */
function withoutCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Same idea as {@link withoutCssComments}, plus `//` line comments, for TS/TSX/JS source. */
function withoutCodeComments(code: string): string {
  const blockStripped = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return blockStripped.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** A closed list of literal values/tokens that are legitimate even in a stylesheet that otherwise
 * must consume tokens.css by name — a 1px hairline border, a 0 reset, `none`, or a 50%/100%
 * percentage (circular avatars via `border-radius: 50%`, full-bleed backgrounds). Deliberately
 * exact strings, not a loose regex: a blanket allowance ("any 1-2px value", "any round
 * percentage") would silently permit the very hardcoding this test exists to catch. Used two ways
 * below: a bare match from the general px/rem scan is dropped if it equals one of these strings
 * exactly; a border-radius/box-shadow value has every `var(--x)` reference stripped out first, and
 * is only an offense if what's left contains a token that ISN'T one of these strings. */
const CSS_LITERAL_ALLOWLIST: ReadonlySet<string> = new Set(["1px", "50%", "100%", "0", "none"]);

/** Same patterns as apps/web/test/side-panel-css-tokens.test.ts / play-grid-css-tokens.test.ts used
 * (hex/rgb/duration/easing/cubic-bezier) — this file supersedes their generic sweep across every
 * regional CSS file, not just the six they used to cover individually — plus three more forbidden
 * shapes added here: literal px/rem lengths, literal border-radius values, and literal box-shadow
 * values, so hardcoded spacing/radius/shadow gets caught the same way hex colours already were.
 *
 * Percentages are deliberately NOT part of the general "字面 px/rem 數值" sweep: `width: 100%` /
 * `flex: 1 1 100%` are ordinary layout mechanics with no design-token equivalent, not a hardcoded
 * design value — forbidding bare percentages everywhere would flag routine layout CSS that has
 * nothing to do with tokens.css. Percentages are only meaningful (and only checked) inside
 * border-radius/box-shadow, where the dedicated patterns below already look at every value token. */
const CSS_FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex 色碼", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "字面 duration（ms/s）", pattern: /[0-9]+(?:\.[0-9]+)?(?:ms|s)\b/g },
  { name: "字面 easing 關鍵字", pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g },
  { name: "cubic-bezier()", pattern: /cubic-bezier\(/g },
  { name: "字面 px/rem 數值", pattern: /(?<![\w.#-])[0-9]+(?:\.[0-9]+)?(?:px|rem)\b/g },
  { name: "字面 border-radius 值", pattern: /border-radius\s*:\s*([^;]+)/g },
  { name: "字面 box-shadow 值", pattern: /box-shadow\s*:\s*([^;]+)/g },
];

/** True when `matchedText` (the full regex match for `patternName`) should NOT be reported —
 * either it's an exact hit on the general allowlist (the px/rem sweep), or — for border-radius/
 * box-shadow, whose pattern captures the entire value — every token that remains once all
 * `var(--x)` references are stripped out is itself on the allowlist (or there's nothing left). */
function isAllowedLiteral(patternName: string, matchedText: string): boolean {
  if (patternName === "字面 border-radius 值" || patternName === "字面 box-shadow 值") {
    const value = matchedText.slice(matchedText.indexOf(":") + 1);
    const withoutVars = value.replace(/var\(--[a-z0-9-]+\)/g, " ").trim();
    if (withoutVars === "") return true;
    return withoutVars.split(/\s+/).every((token) => CSS_LITERAL_ALLOWLIST.has(token.replace(/,$/, "")));
  }
  return CSS_LITERAL_ALLOWLIST.has(matchedText);
}

/** Every regional stylesheet under styles/ except tokens.css, plus style.css — mirrors apps/web/test/tokens.test.ts's regionalCssFiles(). readdirSync means a newly added .css file is picked up automatically, no test edit required.
 *
 * `play.css` is also excluded: it is playback-mode chrome, explicitly out of scope for the New v3
 * shell rebuild (a separate future ticket owns it) and untouched by that work — it still runs on
 * the pre-rebuild `--u` spacing unit (`calc(var(--u) * N)`), not design-package tokens, and still
 * has literal px values predating this file's px/rem/border-radius/box-shadow patterns (added as
 * part of the shell rebuild). Scanning it here would fail on a file nobody is migrating this round;
 * the exclusion is removed when play.css's own migration ticket lands. */
function regionalCssFiles(): string[] {
  const files = readdirSync(stylesDir)
    .filter((name) => name.endsWith(".css") && name !== "tokens.css" && name !== "play.css")
    .map((name) => path.join(stylesDir, name));
  files.push(path.join(webSrcDir, "style.css"));
  return files;
}

interface Offense {
  file: string;
  line: number;
  name: string;
  text: string;
}

function scanCss(filePath: string): Offense[] {
  const raw = readFileSync(filePath, "utf8");
  const stripped = withoutCssComments(raw);
  const offenses: Offense[] = [];
  for (const { name, pattern } of CSS_FORBIDDEN_PATTERNS) {
    for (const match of stripped.matchAll(pattern)) {
      if (isAllowedLiteral(name, match[0])) continue;
      offenses.push({ file: path.basename(filePath), line: lineAt(stripped, match.index!), name, text: match[0] });
    }
  }
  return offenses;
}

describe("design-contract.test.ts — CSS 不得寫死色值／duration／easing（NOOP-9 Plan §4.1）", () => {
  it("所有產品 UI CSS（tokens.css 除外）每個值都來自 var(--x)", () => {
    const offenses = regionalCssFiles().flatMap(scanCss);
    const messages = offenses.map((o) => `${o.file}:${o.line} ${o.name}: ${o.text}`);
    expect(messages).toEqual([]);
  });

  it("tokens.css 本身不在掃描範圍內（它是宣告入口，由 tokens.test.ts 另外守）", () => {
    expect(regionalCssFiles().some((f) => path.basename(f) === "tokens.css")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────

/** `file` is a single relative path (from apps/web/src), not a glob — every entry names exactly one file. `allowed` is the closed list of literal values that file may contain; `reason` is why. All three fields are required (checked below at runtime, since apps/web/test/** is outside tsconfig's `include` — see NOOP-9 Plan §3.1 — so a missing field here would not be caught by `npm run typecheck`). */
interface InlineStyleException {
  file: string;
  allowed: string[];
  reason: string;
}

/** The only hits in apps/web/src today (NOOP-9 Plan §3.6, re-verified by this file's own scan below): generated faithful-rendering documents (canvas.ts, overview.ts) and a sandboxed-iframe runtime script (player-runtime.js) — the exception categories the architecture names. [E2.T17]: App.tsx's own former exception (insertImportedAsset()'s "#889"/"#c66" video/audio placeholder fills) is gone — those two literals moved into `packages/core/src/element-edit.ts` (not scanned here) once `insertImportedAsset` started sharing `media-insert.ts`'s geometry/kind decision with the Image/Video/Audio panels, so App.tsx no longer contains either literal (removing the row here is required, not optional — the self-check below fails loudly if a stale exception has no matching hit). */
const INLINE_STYLE_EXCEPTIONS: InlineStyleException[] = [
  { file: "canvas.ts", allowed: ["#fff"], reason: "生成的忠實渲染文件，#fff 是投影片紙張本色，不是產品 UI" },
  { file: "overview.ts", allowed: ["#fff"], reason: "生成的忠實渲染文件，#fff 是投影片紙張本色，不是產品 UI" },
  // [E2.T7]: same category the ms-only duration pattern below already
  // structurally excuses this file for (see CODE_FORBIDDEN_PATTERNS'
  // comment) — these "ease"/"linear" strings are WAAPI `easing` option
  // values handed to `el.animate()` inside the sandboxed play iframe
  // (D4.4), evaluated at runtime inside untrusted-origin slide content,
  // never product-UI CSS/inline style. The duration pattern's structural
  // (regex-level) exemption cannot equally narrow this one, because "ease"/
  // "linear" are bare keywords with no numeric prefix to key off of — an
  // explicit allowlist entry is the only way to excuse them without
  // weakening the pattern for every other file.
  {
    file: "player-runtime.js",
    allowed: ["ease", "linear"],
    reason: "el.animate() 的 easing 參數，沙盒 iframe 執行期輸出，不是產品 UI",
  },
  // F8 (NOOP-289): slide-dom.ts's own copy of core's table/model.ts
  // readTableModel — "#000000" is the SAME fallback core's TableCell.textFill
  // reader already used (a table cell with no explicit fill), a slide-data
  // default mirroring core's contract, not a product-UI colour.
  {
    file: "slide-dom.ts",
    allowed: ["#000000"],
    reason: "表格儲存格 text-fill 讀不到值時的資料預設值，與 core 的 readTableModel 同一個預設，不是產品 UI",
  },
  // [E5.T8]/NOOP-353 拍板決定 7：沒有 accent 時插入元素的 fill/stroke 對比色，
  // 是決定本身指定的兩個具體值＋「沒有頁面背景就當白」的預設，不是可換掉的
  // 設計 token——這三個字面值就是規格,不是抓漏對象。
  {
    file: "contrast-fill.ts",
    allowed: ["#1f1a1a", "#f4f6f8", "#ffffff"],
    reason: "拍板決定 7（父票 NOOP-353／#279）指定的對比色常值與「無背景時當白」預設，不是產品 UI 樣式 token",
  },
];

/** ms-only (not bare seconds) — deliberately narrower than the CSS scan's duration pattern. Runtime scripts injected into the presentation iframe (player-runtime.js, selection-runtime.js) write CSS transition strings like `"opacity 0.4s"`; those are rendered output, not product-UI source, so this pattern does not reach into `s`-only durations at all (NOOP-9 Plan §4.2's contract table names `\d+ms` explicitly). */
const CODE_FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex 色碼", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "字面 duration（ms）", pattern: /\b[0-9]+(?:\.[0-9]+)?ms\b/g },
  { name: "字面 easing 關鍵字", pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g },
  { name: "cubic-bezier()", pattern: /cubic-bezier\(/g },
];

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "assets") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (/\.(ts|tsx|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function scanCode(filePath: string): Offense[] {
  const raw = readFileSync(filePath, "utf8");
  const stripped = withoutCodeComments(raw);
  const offenses: Offense[] = [];
  for (const { name, pattern } of CODE_FORBIDDEN_PATTERNS) {
    for (const match of stripped.matchAll(pattern)) {
      offenses.push({
        file: path.relative(webSrcDir, filePath).split(path.sep).join("/"),
        line: lineAt(stripped, match.index!),
        name,
        text: match[0],
      });
    }
  }
  return offenses;
}

describe("design-contract.test.ts — inline style 不得寫死色值／duration／easing（NOOP-9 Plan §4.2）", () => {
  it("例外清單的每一條都有 file／allowed（非空）／reason 三個欄位", () => {
    for (const entry of INLINE_STYLE_EXCEPTIONS) {
      expect(entry.file, "file 欄位").toBeTruthy();
      expect(entry.allowed.length, `${entry.file} 的 allowed 欄位`).toBeGreaterThan(0);
      expect(entry.reason, `${entry.file} 的 reason 欄位`).toBeTruthy();
    }
  });

  it("apps/web/src/**/*.{ts,tsx,js}（排除 assets/）只在例外清單涵蓋的地方出現直接色值／duration／easing", () => {
    const allOffenses = walkSourceFiles(webSrcDir).flatMap(scanCode);
    const byFile = new Map<string, Offense[]>();
    for (const offense of allOffenses) {
      if (!byFile.has(offense.file)) byFile.set(offense.file, []);
      byFile.get(offense.file)!.push(offense);
    }

    const exceptionByFile = new Map(INLINE_STYLE_EXCEPTIONS.map((e) => [e.file, e]));
    const problems: string[] = [];

    for (const [file, offenses] of byFile) {
      const exception = exceptionByFile.get(file);
      if (!exception) {
        for (const o of offenses) problems.push(`${file}:${o.line} ${o.name}: ${o.text}（不在例外清單中，未涵蓋的新命中）`);
        continue;
      }
      for (const o of offenses) {
        if (!exception.allowed.includes(o.text)) {
          problems.push(`${file}:${o.line} ${o.name}: ${o.text}（例外清單允許的值是 [${exception.allowed.join(", ")}]，不含這個命中）`);
        }
      }
    }

    for (const exception of INLINE_STYLE_EXCEPTIONS) {
      const actualTexts = new Set((byFile.get(exception.file) ?? []).map((o) => o.text));
      for (const allowedValue of exception.allowed) {
        if (!actualTexts.has(allowedValue)) {
          problems.push(`${exception.file} 的例外清單值 ${allowedValue} 已無對應命中，請刪掉這一條`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

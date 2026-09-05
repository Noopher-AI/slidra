import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 全域設計契約掃描（NOOP-9 Plan §4.1/§4.2）：所有產品 UI CSS（tokens.css 除
// 外，它是宣告入口，由 tokens.test.ts 用另一組規則守）＋ packages/web/src
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

/** Same five patterns as packages/web/test/side-panel-css-tokens.test.ts / play-grid-css-tokens.test.ts — this file supersedes their generic sweep across every regional CSS file, not just the six they used to cover individually. */
const CSS_FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex 色碼", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "字面 duration（ms/s）", pattern: /[0-9]+(?:\.[0-9]+)?(?:ms|s)\b/g },
  { name: "字面 easing 關鍵字", pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g },
  { name: "cubic-bezier()", pattern: /cubic-bezier\(/g },
];

/** Every regional stylesheet under styles/ except tokens.css, plus style.css — mirrors packages/web/test/tokens.test.ts's regionalCssFiles(). readdirSync means a newly added .css file is picked up automatically, no test edit required. */
function regionalCssFiles(): string[] {
  const files = readdirSync(stylesDir)
    .filter((name) => name.endsWith(".css") && name !== "tokens.css")
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

/** `file` is a single relative path (from packages/web/src), not a glob — every entry names exactly one file. `allowed` is the closed list of literal values that file may contain; `reason` is why. All three fields are required (checked below at runtime, since packages/web/test/** is outside tsconfig's `include` — see NOOP-9 Plan §3.1 — so a missing field here would not be caught by `npm run typecheck`). */
interface InlineStyleException {
  file: string;
  allowed: string[];
  reason: string;
}

/** The only 8 hits in packages/web/src today (NOOP-9 Plan §3.6, re-verified by this file's own scan below): default artwork content (App.tsx) and generated faithful-rendering documents (canvas.ts, overview.ts) — the two exception categories the architecture names. */
const INLINE_STYLE_EXCEPTIONS: InlineStyleException[] = [
  { file: "App.tsx", allowed: ["#f4f6f8", "#889", "#c66"], reason: "預設作品內容，屬投影片資料" },
  { file: "canvas.ts", allowed: ["#fff"], reason: "生成的忠實渲染文件，#fff 是投影片紙張本色，不是產品 UI" },
  { file: "overview.ts", allowed: ["#fff"], reason: "生成的忠實渲染文件，#fff 是投影片紙張本色，不是產品 UI" },
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

  it("packages/web/src/**/*.{ts,tsx,js}（排除 assets/）只在例外清單涵蓋的地方出現直接色值／duration／easing", () => {
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

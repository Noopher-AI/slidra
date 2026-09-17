// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Global design-contract scan (Plan §4.1/§4.2): all product-UI CSS (except
// tokens.css, which is the declaration entry point guarded by tokens.test.ts
// under its own rules) plus TS/TSX/JS inline styles under packages/web/src
// must never hardcode color values / durations / easing directly — every
// value must be consumed from tokens.css via var(--x). This is a constraint
// on the *source text* itself (reading a browser's computed style can't tell
// whether a value was written as var(--x), since it resolves to the same
// literal after parsing), so — like tokens.test.ts / side-panel-css-tokens.test.ts —
// this reads the raw source text with node:fs + regex rather than mounting a
// jsdom stylesheet.

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

/** Same patterns as packages/web/test/side-panel-css-tokens.test.ts / play-grid-css-tokens.test.ts used
 * (hex/rgb/duration/easing/cubic-bezier) — this file supersedes their generic sweep across every
 * regional CSS file, not just the six they used to cover individually — plus three more forbidden
 * shapes added here: literal px/rem lengths, literal border-radius values, and literal box-shadow
 * values, so hardcoded spacing/radius/shadow gets caught the same way hex colours already were.
 *
 * Percentages are deliberately NOT part of the general "literal px/rem value" sweep: `width: 100%` /
 * `flex: 1 1 100%` are ordinary layout mechanics with no design-token equivalent, not a hardcoded
 * design value — forbidding bare percentages everywhere would flag routine layout CSS that has
 * nothing to do with tokens.css. Percentages are only meaningful (and only checked) inside
 * border-radius/box-shadow, where the dedicated patterns below already look at every value token. */
const CSS_FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex color code", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "literal duration (ms/s)", pattern: /[0-9]+(?:\.[0-9]+)?(?:ms|s)\b/g },
  { name: "literal easing keyword", pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g },
  { name: "cubic-bezier()", pattern: /cubic-bezier\(/g },
  { name: "literal px/rem value", pattern: /(?<![\w.#-])[0-9]+(?:\.[0-9]+)?(?:px|rem)\b/g },
  { name: "literal border-radius value", pattern: /border-radius\s*:\s*([^;]+)/g },
  { name: "literal box-shadow value", pattern: /box-shadow\s*:\s*([^;]+)/g },
];

/** True when `matchedText` (the full regex match for `patternName`) should NOT be reported —
 * either it's an exact hit on the general allowlist (the px/rem sweep), or — for border-radius/
 * box-shadow, whose pattern captures the entire value — every token that remains once all
 * `var(--x)` references are stripped out is itself on the allowlist (or there's nothing left). */
function isAllowedLiteral(patternName: string, matchedText: string): boolean {
  if (patternName === "literal border-radius value" || patternName === "literal box-shadow value") {
    const value = matchedText.slice(matchedText.indexOf(":") + 1);
    const withoutVars = value.replace(/var\(--[a-z0-9-]+\)/g, " ").trim();
    if (withoutVars === "") return true;
    return withoutVars.split(/\s+/).every((token) => CSS_LITERAL_ALLOWLIST.has(token.replace(/,$/, "")));
  }
  return CSS_LITERAL_ALLOWLIST.has(matchedText);
}

/** Every regional stylesheet under styles/ except tokens.css, plus style.css — mirrors packages/web/test/tokens.test.ts's regionalCssFiles(). readdirSync means a newly added .css file is picked up automatically, no test edit required.
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

describe("design-contract.test.ts — CSS must not hardcode color values / durations / easing (Plan §4.1)", () => {
  it("every value in product-UI CSS (except tokens.css) comes from var(--x)", () => {
    const offenses = regionalCssFiles().flatMap(scanCss);
    const messages = offenses.map((o) => `${o.file}:${o.line} ${o.name}: ${o.text}`);
    expect(messages).toEqual([]);
  });

  it("tokens.css itself is out of scan scope (it's the declaration entry point, guarded separately by tokens.test.ts)", () => {
    expect(regionalCssFiles().some((f) => path.basename(f) === "tokens.css")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────

/** `file` is a single relative path (from packages/web/src), not a glob — every entry names exactly one file. `allowed` is the closed list of literal values that file may contain; `reason` is why. All three fields are required (checked below at runtime, since packages/web/test/** is outside tsconfig's `include` — see Plan §3.1 — so a missing field here would not be caught by `npm run typecheck`). */
interface InlineStyleException {
  file: string;
  allowed: string[];
  reason: string;
}

/** The only hits in packages/web/src today (Plan §3.6, re-verified by this file's own scan below): generated faithful-rendering documents (canvas.ts, overview.ts) and a sandboxed-iframe runtime script (player-runtime.js) — the exception categories the architecture names. App.tsx's own former exception (insertImportedAsset()'s "#889"/"#c66" video/audio placeholder fills) is gone — those two literals moved into `packages/core/src/element-edit.ts` (not scanned here) once `insertImportedAsset` started sharing `media-insert.ts`'s geometry/kind decision with the Image/Video/Audio panels, so App.tsx no longer contains either literal (removing the row here is required, not optional — the self-check below fails loudly if a stale exception has no matching hit). */
const INLINE_STYLE_EXCEPTIONS: InlineStyleException[] = [
  { file: "canvas/frame-documents.ts", allowed: ["#fff"], reason: "Generated faithful-rendering document; #fff is the slide's own paper color, not product UI" },
  { file: "overview.ts", allowed: ["#fff"], reason: "Generated faithful-rendering document; #fff is the slide's own paper color, not product UI" },
  // Same category the ms-only duration pattern below already
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
    reason: "el.animate()'s easing parameter, runtime output inside the sandboxed iframe, not product UI",
  },
  // F8: slide-dom.ts's own copy of core's table/model.ts
  // readTableModel — "#000000" is the SAME fallback core's TableCell.textFill
  // reader already used (a table cell with no explicit fill), a slide-data
  // default mirroring core's contract, not a product-UI colour.
  {
    file: "slide-dom.ts",
    allowed: ["#000000"],
    reason: "The data default when a table cell's text-fill can't be read, the same default as core's readTableModel, not a product UI value",
  },
  // Decision 7: the contrast fill/stroke colors for inserted elements without
  // an accent are two concrete values specified by the decision itself, plus
  // a "treat as white when there's no page background" default — not a
  // swappable design token. These three literal values ARE the spec, not
  // something this test should be catching.
  {
    file: "contrast-fill.ts",
    allowed: ["#1f1a1a", "#f4f6f8", "#ffffff"],
    reason: "Ruling 7 (parent ticket NOOP-353/#279)'s contrast-color literals plus the 'treat as white with no background' default, not a swappable product UI style token",
  },
];

/** ms-only (not bare seconds) — deliberately narrower than the CSS scan's duration pattern. Runtime scripts injected into the presentation iframe (player-runtime.js, selection-runtime.js) write CSS transition strings like `"opacity 0.4s"`; those are rendered output, not product-UI source, so this pattern does not reach into `s`-only durations at all (Plan §4.2's contract table names `\d+ms` explicitly). */
const CODE_FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "hex color code", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba()", pattern: /\brgba?\(/g },
  { name: "literal duration (ms)", pattern: /\b[0-9]+(?:\.[0-9]+)?ms\b/g },
  { name: "literal easing keyword", pattern: /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])/g },
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

describe("design-contract.test.ts — inline styles must not hardcode color values / durations / easing (Plan §4.2)", () => {
  it("every exception-list entry has file / allowed (non-empty) / reason fields", () => {
    for (const entry of INLINE_STYLE_EXCEPTIONS) {
      expect(entry.file, "file field").toBeTruthy();
      expect(entry.allowed.length, `${entry.file}'s allowed field`).toBeGreaterThan(0);
      expect(entry.reason, `${entry.file}'s reason field`).toBeTruthy();
    }
  });

  it("packages/web/src/**/*.{ts,tsx,js} (excluding assets/) only has direct color values / durations / easing where the exception list covers them", () => {
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
        for (const o of offenses) problems.push(`${file}:${o.line} ${o.name}: ${o.text} (not in the exception list, uncovered new hit)`);
        continue;
      }
      for (const o of offenses) {
        if (!exception.allowed.includes(o.text)) {
          problems.push(`${file}:${o.line} ${o.name}: ${o.text} (exception list only allows [${exception.allowed.join(", ")}], which doesn't include this hit)`);
        }
      }
    }

    for (const exception of INLINE_STYLE_EXCEPTIONS) {
      const actualTexts = new Set((byFile.get(exception.file) ?? []).map((o) => o.text));
      for (const allowedValue of exception.allowed) {
        if (!actualTexts.has(allowedValue)) {
          problems.push(`${exception.file}'s exception-list value ${allowedValue} no longer has a matching hit — remove this entry`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

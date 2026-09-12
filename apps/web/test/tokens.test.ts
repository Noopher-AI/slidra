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

// The web bundle no longer depends on core's chart module at all — this
// reads the Rust CLI's own palette constants with node:fs + regex instead,
// the same "the file's own text is the contract" posture this whole test
// file already applies to tokens.css/the design doc.
const chartRenderRsPath = path.join(repoRoot, "crates", "slidra", "src", "chart", "render.rs");
const chartRenderRs = readFileSync(chartRenderRsPath, "utf8");

/** `CHART_PALETTE_HEX_<PALETTE>: [&str; 6] = [ "#...", ... ];` → the six hex strings, in order. */
function chartPaletteHex(palette: "BRAND" | "COOL" | "WARM"): string[] {
  const match = chartRenderRs.match(new RegExp(`CHART_PALETTE_HEX_${palette}:[^=]*=\\s*\\[([^\\]]+)\\]`));
  if (!match) throw new Error(`render.rs is missing CHART_PALETTE_HEX_${palette}`);
  return [...match[1].matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
}

function declaredRootTokenNames(): Set<string> {
  const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m);
  if (!rootBlockMatch) throw new Error("tokens.css has no :root block");
  const names = new Set<string>();
  for (const match of rootBlockMatch[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    names.add(match[1]);
  }
  return names;
}

function declaredRootTokenValue(name: string): string {
  const rootBlockMatch = tokensCss.match(/:root\s*{([\s\S]*?)^}/m)![1];
  const match = rootBlockMatch.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`tokens.css's :root does not declare ${name}`);
  return match[1].trim();
}

// ── Parsing the token table in docs/design/docs/01-DESIGN_TOKENS.md ──────
//
// Each row in the doc is a pipe-table row of the form
// `| \`token.path\` | value | (purpose) |` (not every table has the purpose
// column). The first column, wrapped in backticks and containing only
// lowercase letters/digits/dots, is treated as a "design package token
// name"; hyphenated animation-preset names like `hs-fade` are deliberately
// NOT matched by this pattern (hyphens aren't in the character class) —
// their "value" column is a prose description of the animation effect
// (e.g. "4px shift up + fade in"), not a literal that can land as a CSS
// value.
//
// Compressed notation like `space.1..6` (meaning the six tokens space.1
// through space.6) is expanded here into six separate entries.

interface DesignToken {
  path: string;
  /** The raw "value" cell text, for range-extraction below. */
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

/** Design tokens documented as a *range* (e.g. "10.5–11") that got resolved to a single
 * real value — or, when the same token is genuinely used for two distinct named purposes at two
 * distinct real values, split into two CSS custom properties. Every value on the right must lie
 * within the design doc's own stated range for that token (checked mechanically below) — this
 * records *which* CSS vars a doc token landed as, not new numbers invented outside its range. */
const SPLIT_TOKENS: Record<string, string[]> = {
  ok: ["--ok", "--ok-text", "--ok-bg"], // one doc cell packs three colours (main/text/background); a CSS custom property can only hold one value
  info: ["--info", "--info-bg"],
  "text.2xs": ["--text-2xs", "--text-2xs-chart"], // BETA badge (10px) vs chart type label (9.5px)
  "text.xs": ["--text-xs", "--text-xs-hint"], // section heading (10.5px) vs hint/shortcut (11px)
  "text.md": ["--text-md", "--text-md-panel-title"], // filename (13.5px) vs panel title (14px)
  "text.lg": ["--text-lg", "--text-lg-dialog"], // overview title (18px) vs dialog title (17px)
  "radius.md": ["--radius-md", "--radius-md-segmented"], // input field (9px) vs segmented control (10px)
  "radius.xl": ["--radius-xl", "--radius-xl-dialog"], // glass panel (14px) vs dialog (16px)
  "radius.2xl": ["--radius-2xl", "--radius-2xl-empty"], // large dialog (18px) vs empty-state card (20px)
  "space.gutter": ["--space-gutter", "--space-gutter-bottom"], // "28px 36px" pair vs "76px" bottom reserved area
  "control.h": ["--control-h", "--control-h-compact"], // 30px regular vs 28px compact variant (the doc itself splits these into two values)
  // Each `accent.palette.*` doc cell packs six hex colours into one
  // token path — one CSS custom property cannot hold six values, so it
  // splits the same way `ok`/`info` above do, six-ways instead of two.
  "accent.palette.brand": [1, 2, 3, 4, 5, 6].map((n) => `--accent-palette-brand-${n}`),
  "accent.palette.cool": [1, 2, 3, 4, 5, 6].map((n) => `--accent-palette-cool-${n}`),
  "accent.palette.warm": [1, 2, 3, 4, 5, 6].map((n) => `--accent-palette-warm-${n}`),
};

/** No tokens are currently excluded. `accent.palette.*` used to be the one exclusion (chart colour
 * palette, "belongs to a future chart ticket") — that work has since landed via the
 * `SPLIT_TOKENS` six-way split above instead, so it's no longer excluded. */
const EXCLUDED_DESIGN_TOKENS = new Set<string>([]);

/** Glass material is documented as prose + a CSS code block, not a `token.path | value`
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
  // Icon geometry: prose in the doc's icon section (20×20 viewBox / stroke 1.5),
  // no table row. Consumed by icons/Icon.tsx via *inline* style var() — the two
  // mechanical scans below cannot see that usage, which is how they went missing
  // initially (every shell icon collapsed to 0px). --icon-control is listed with
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
  // redesigned. Will be removed together with play.css's own migration in a
  // future pass.
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
  "--r",
  "--s-raised",
  "--line",
  // The Animate insert panel's looping effect-preview thumbnail
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

describe("tokens.css against docs/design/docs/01-DESIGN_TOKENS.md (design package token table)", () => {
  it("the design package doc itself parses out at least the tokens in each target category (the parser isn't reading empty)", () => {
    // Sanity check on the parser itself, independent of tokens.css: if this fails, the parser's
    // regex stopped matching the doc's real table format and every other test below is vacuous.
    expect(designTokenPaths.has("brand.red")).toBe(true);
    expect(designTokenPaths.has("surface.0")).toBe(true);
    expect(designTokenPaths.has("radius.pill")).toBe(true);
    expect(designTokenPaths.has("dur.fast")).toBe(true);
    // A hyphenated animation-preset name like "hs-fade" should not be parsed as a token (see the parser comment above).
    expect(designTokenPaths.has("hs-fade")).toBe(false);
  });

  it("tokens.css's :root doesn't invent any token name absent from the design package", () => {
    const declared = declaredRootTokenNames();
    const legalNames = new Set<string>(NON_TABULAR_DESIGN_TOKENS);
    for (const tokenPath of designTokenPaths) {
      if (EXCLUDED_DESIGN_TOKENS.has(tokenPath)) continue;
      for (const cssVar of expectedCssVarsFor(tokenPath)) legalNames.add(cssVar);
    }
    const invented = [...declared].filter((name) => !legalNames.has(name));
    expect(invented).toEqual([]);
  });

  it("every planned category (colour/font/UI type scale/spacing & sizing/radius/shadow/glass material/motion) has a corresponding declaration in tokens.css", () => {
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

  it("EXCLUDED_DESIGN_TOKENS is currently empty, now that accent.palette.* has landed and there are no remaining exclusions (an older test iterated over the empty set, which was a no-op; this assertion replaces it so \"the set is empty\" is itself a visible assertion instead of silently testing nothing)", () => {
    expect(EXCLUDED_DESIGN_TOKENS.size).toBe(0);
  });

  // control.h's cell packs a second, explicitly-separate number ("30–34
  // px; 28 px compact variant") that is NOT part of the 30–34 range — the
  // doc gives it as its own compact-variant value. It gets its own
  // exact-match test below instead of the generic range-membership loop.
  const RANGE_CHECK_EXCLUDE = new Set(["--control-h-compact"]);

  it("every value the design package marks as a \"range\" lands as a CSS value within that range (inclusive)", () => {
    const outOfRange: string[] = [];
    for (const { path: tokenPath, valueCell } of designTokens) {
      if (EXCLUDED_DESIGN_TOKENS.has(tokenPath)) continue;
      const rangeMatch = valueCell.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/);
      if (!rangeMatch) continue; // not a range value (e.g. a single fixed value like "12 px") — no range check needed
      const low = Number(rangeMatch[1]);
      const high = Number(rangeMatch[2]);
      for (const cssVar of expectedCssVarsFor(tokenPath)) {
        if (RANGE_CHECK_EXCLUDE.has(cssVar)) continue;
        const declaredValue = declaredRootTokenValue(cssVar);
        const numMatch = declaredValue.match(/^(\d+(?:\.\d+)?)(?:px|ms)$/);
        if (!numMatch) continue; // this split-out value isn't a plain number + unit (e.g. --space-gutter is a compound value)
        const actual = Number(numMatch[1]);
        if (actual < low || actual > high) {
          outOfRange.push(`${cssVar} (${tokenPath}'s range is ${low}–${high}, actual is ${actual})`);
        }
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it("--control-h-compact matches the compact-variant value the design package doc states explicitly", () => {
    const docToken = designTokens.find((t) => t.path === "control.h");
    if (!docToken) throw new Error("design package doc is missing control.h");
    const compactMatch = docToken.valueCell.match(/(\d+(?:\.\d+)?)\s*px compact variant/);
    if (!compactMatch) throw new Error("control.h's value cell has no \"compact variant\" number — the doc format may have changed");
    expect(declaredRootTokenValue("--control-h-compact")).toBe(`${compactMatch[1]}px`);
  });

  it("every token the design package marks as a colour (its value cell contains a #RRGGBB literal) lands as a valid hex colour code (previously there was no format check — --accent-palette-brand-1 could be changed to \"notacolor\" and this would still pass)", () => {
    const HEX_COLOR = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;
    const malformed: string[] = [];
    for (const { path: tokenPath, valueCell } of designTokens) {
      if (EXCLUDED_DESIGN_TOKENS.has(tokenPath)) continue;
      if (!/#[0-9a-fA-F]{3,8}\b/.test(valueCell)) continue; // value cell has no hex literal -> not a colour token
      for (const cssVar of expectedCssVarsFor(tokenPath)) {
        const declaredValue = declaredRootTokenValue(cssVar);
        if (!HEX_COLOR.test(declaredValue)) malformed.push(`${cssVar}: "${declaredValue}"`);
      }
    }
    expect(malformed).toEqual([]);
  });

  it("the three accent.palette.* CSS variable sets match crates/slidra's CHART_PALETTE_HEX_* colour-for-colour (the two palettes used to be maintained independently with nothing tying them together; this now compares against the Rust side, since the equivalent TS constants were removed from web along with core)", () => {
    for (const [palette, key] of [["brand", "BRAND"], ["cool", "COOL"], ["warm", "WARM"]] as const) {
      chartPaletteHex(key).forEach((hex, index) => {
        const cssVar = `--accent-palette-${palette}-${index + 1}`;
        expect(declaredRootTokenValue(cssVar).toLowerCase()).toBe(hex.toLowerCase());
      });
    }
  });
});

describe("tokens.css — fonts", () => {
  it("contains exactly six @font-face rules: three weights each (400/500/700) for Plus Jakarta Sans and Noto Sans TC, with distinct src filenames that actually exist", () => {
    const fontFaceBlocks = [...tokensCss.matchAll(/@font-face\s*{([\s\S]*?)}/g)].map((match) => match[1]);
    expect(fontFaceBlocks).toHaveLength(6);

    const parsed = fontFaceBlocks.map((block) => {
      const familyMatch = block.match(/font-family:\s*"([^"]+)"/);
      const weightMatch = block.match(/font-weight:\s*(\d+)/);
      const srcMatch = block.match(/url\("\.\.\/assets\/fonts\/([^"]+\.woff2)"\)/);
      if (!familyMatch) throw new Error("an @font-face block is missing font-family");
      if (!weightMatch) throw new Error("an @font-face block is missing font-weight");
      if (!srcMatch) throw new Error("an @font-face block has no src pointing at ../assets/fonts/*.woff2");
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

  it("the --font-ui font stack (in order) matches the design package doc (font.ui)", () => {
    // Compares the ordered list of font names, ignoring quote style (doc uses
    // single quotes, this file's existing convention uses double quotes) and
    // incidental whitespace — neither is semantically meaningful in CSS.
    function fontNames(stack: string): string[] {
      return stack
        .split(",")
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ""));
    }
    const docToken = designTokens.find((t) => t.path === "font.ui");
    if (!docToken) throw new Error("design package doc is missing font.ui");
    const docValue = docToken.valueCell.trim().replace(/^`|`$/g, "");
    expect(fontNames(declaredRootTokenValue("--font-ui"))).toEqual(fontNames(docValue));
  });

  it("--font-slide links to --font-ui via var() (doc: \"same as font.ui\")", () => {
    expect(declaredRootTokenValue("--font-slide")).toBe("var(--font-ui)");
  });
});

describe("tokens.css — prefers-reduced-motion", () => {
  it("the prefers-reduced-motion block overrides both --dur-fast and --dur-base to 0ms and disables looping animations", () => {
    const mediaMatch = tokensCss.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*)}\s*$/);
    if (!mediaMatch) throw new Error("tokens.css has no prefers-reduced-motion block");
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

describe("tokens.css — every var(--x) consumed by regional CSS must be defined", () => {
  it("every var(--x) used by regional CSS (exempting --overview-aspect-ratio) is defined in tokens.css's :root", () => {
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

  it("every literal token name read by getPropertyValue(\"--x\") on the JS side under packages/web/src is also defined in :root", () => {
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

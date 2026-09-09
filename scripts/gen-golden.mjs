#!/usr/bin/env node
// NOOP-278: generates golden fixtures for `crates/co-motion/tests/golden/`
// by running the REAL TypeScript implementation (`packages/core`'s built
// `dist/`) — never by hand-computing expected values, and never by
// capturing the Rust port's own output. A fixture whose expected value came
// from anywhere other than the TS source it's meant to check would pass no
// matter what the Rust port did wrong, so this script imports
// `packages/core/dist` directly rather than reimplementing any of its
// logic.
//
// Requires `packages/core` to already be built (`npm run build --workspace=packages/core`)
// — this script does not build it, so a stale `dist/` produces a stale
// fixture; run the build first if `packages/core/src` changed since the
// last fixture generation.
//
// Usage: node scripts/gen-golden.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "crates", "co-motion", "tests", "golden");
mkdirSync(outDir, { recursive: true });

function writeJson(name, data) {
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

// --- svgnum.json ------------------------------------------------------------
//
// >= 200 values per plan AC9, spanning the ranges this project's real
// coordinates/widths occupy (roughly 1e-4 .. 1e5) plus a few boundary/edge
// values explicitly called out in the plan (0, -0, a rounding-boundary
// value, 1/3, a large value near the JS exponential-notation threshold).
// NaN/Infinity are deliberately excluded — `format_svg_number` treats those
// as a caller bug (panic), not a value with a defined golden output.
async function genSvgNumber() {
  const { formatSvgNumber } = await import(join(repoRoot, "packages/core/dist/svg-number.js"));

  const values = [];
  values.push(0, -0, 1, -1, 300, -300, 27.84, 62.592, 97.344, 104.256);
  values.push(1 / 3, -1 / 3, 2 / 3);
  values.push(0.00005, 0.000049999, 0.30005, 1.00005);
  values.push(123456789.123456, -123456789.123456);
  values.push(0.0001, 0.00001, 100000, 99999.9999);
  // NOTE: 1e21 is deliberately NOT included here. `toFixed`'s spec bypasses
  // fixed-point formatting entirely for |x| >= 1e21 (returns a plain
  // `ToString(x)`, i.e. `"1e+21"`), which Rust's f64 `Display` never
  // produces (it has no exponential-notation output at all) — this is the
  // `KNOWN GAP` documented in svgnum.rs's module comment, deliberately
  // out of scope per the plan (unreachable for this project's real
  // coordinate/dimension values). Including it here would make this a
  // permanently-red golden case for a divergence everyone already agreed
  // not to fix. 1e-7 IS included: toFixed(4) rounds it to 0 either way, so
  // both engines agree ("0"), it's not actually a gap.
  values.push(1e-7);

  // Deterministic pseudo-random spread across the realistic coordinate
  // range (project canvases are ~1280x720 px; widths/heights/offsets stay
  // well under 1e5). A fixed seed keeps this fixture reproducible across
  // regenerations rather than churning on every run for no reason.
  let state = 0x2545f4914f6cdd1dn;
  function nextRandom() {
    state ^= state << 13n;
    state &= 0xffffffffffffffffn;
    state ^= state >> 7n;
    state ^= state << 17n;
    state &= 0xffffffffffffffffn;
    return Number(state % 1000000n) / 1000000;
  }
  for (let i = 0; i < 200; i++) {
    const magnitude = [0.01, 1, 10, 100, 1000, 10000][i % 6];
    const sign = i % 7 === 0 ? -1 : 1;
    values.push(sign * nextRandom() * magnitude);
  }

  const cases = values.map((input) => ({ input, expected: formatSvgNumber(input) }));
  writeJson("svgnum.json", cases);
}

// --- text_wrap_fixture.json --------------------------------------------------
//
// The exact scenario from the implementation plan (NOOP-277, section 5/AC9):
// `co-motion textbox add <id> slides/001.svg --x 100 --y 100 --width 300
// --font-size 24` with a two-paragraph CJK+ASCII mixed string, run through
// the real CLI end-to-end (not just wrapText/renderTextBoxContent in
// isolation) so the fixture is exactly what a human ran and inspected, not
// a reconstruction. This fixture is a regression pin, independently
// verified once already (2026-09-08, this ticket's Run 1) against a live
// `node packages/cli/bin/co-motion.js textbox add ...` invocation.
async function genTextWrapFixture() {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const home = mkdtempSync(join(tmpdir(), "co-motion-golden-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "co-motion-golden-ws-"));
  const cliBin = join(repoRoot, "packages/cli/bin/co-motion.js");
  const env = { ...process.env, CO_MOTION_HOME: home };

  const comotPath = join(workspace, "t.comot");
  execFileSync("node", [cliBin, "new", comotPath, "--name", "測試"], { env });
  const openOutput = execFileSync("node", [cliBin, "open", comotPath], { env }).toString();
  const id = JSON.parse(openOutput.split("\n").slice(1).join("\n")).id;

  const text = "中文字排版測試與 ASCII mixed content wrapping\n第二段落";
  execFileSync(
    "node",
    [cliBin, "textbox", "add", id, "slides/001.svg", "--x", "100", "--y", "100", "--width", "300", "--font-size", "24", "--text", text],
    { env },
  );

  const svg = execFileSync("node", [cliBin, "cat", id, "slides/001.svg"], { env }).toString();
  const textElementMatch = svg.match(/<text font-family="Noto Sans TC" font-size="24"[^>]*>(.*?)<\/text>/s);
  const heightMatch = svg.match(/data-comot-text-height="([^"]+)"/);
  if (!textElementMatch || !heightMatch) {
    throw new Error(`gen-golden: could not extract fixture from generated SVG:\n${svg}`);
  }

  writeJson("text_wrap_fixture.json", {
    input: {
      text,
      width: 300,
      fontSizePx: 24,
      fontFamily: "Noto Sans TC",
    },
    expectedInnerMarkup: textElementMatch[1],
    expectedTextHeight: heightMatch[1],
  });
}

// --- scan.json ---------------------------------------------------------
//
// NOOP-292 (round 2 of NOOP-278's review): scan.rs's 18 hand-written
// `#[cfg(test)]` cases have expected values written by the same porting
// pass that wrote `scan_document` itself — self-verification, per Review
// round 1 (NOOP-283). This fixture instead runs the REAL `scanDocument`
// (`packages/core/dist/slide/scan.js`) against deliberately tricky input
// (comments/CDATA hiding fake markup, a DOCTYPE internal subset, quote
// tracking, an embedded pseudo-attribute, CJK attribute values and text
// content) and captures its actual tree/offsets — covering the module's
// four rules (see `scan.rs`'s own header comment) — plus one case per
// distinct error message the scanner can produce.
async function genScan() {
  const { scanDocument } = await import(join(repoRoot, "packages/core/dist/slide/scan.js"));

  // Tree cases: `scanDocument`'s return value (ScannedNode[]) is already
  // plain JSON-safe data (tag/attributes/start/end/contentStart/contentEnd/
  // selfClosing/children, all numbers/strings/booleans/arrays) — captured
  // verbatim, not reshaped.
  const treeCases = [
    {
      label: "comment-cdata-quote-tracking-pseudo-attribute-cjk",
      // Rule 1 (comment/CDATA skipped whole, so the fake markup inside is
      // never read as real markup) + rule 2 (`>` inside a quoted `d` value
      // does not end the `<path>` tag early) + rule 3 (the embedded
      // ` id="el-a"` inside `data-note`'s quoted value is part of the value,
      // never a second attribute) + CJK in attribute values and text
      // content, all in one document.
      svg:
        `<svg>` +
        `<!-- <fake>假標籤</fake> -->` +
        `<![CDATA[ <also-fake/> ]]>` +
        `<rect id="測試一" data-note="a &gt; b" width="10"/>` +
        `<path d="M10 10 L20>20" id="路徑二"/>` +
        `<text data-note=' id="el-a"'>你好，世界！Hello</text>` +
        `</svg>`,
    },
    {
      label: "doctype-internal-subset-bracket-depth-and-duplicate-attribute",
      // Rule 1: the `>` closing `<!ENTITY ...>` inside the DOCTYPE's `[...]`
      // internal subset must not end the DOCTYPE early — only the `>`
      // after the matching `]` does (bracket-depth counting). Also exercises
      // first-attribute-wins on a duplicate `id`.
      svg: `<!DOCTYPE svg [<!ENTITY x "y">]><svg id="a" id="b"><g/></svg>`,
    },
    {
      label: "nested-multiline-cjk-with-commented-out-fake-self-closing-tag",
      svg:
        `<svg>\n` +
        `  <g id="群組一">\n` +
        `    <text font-family="Noto Sans TC">第一行\n` +
        `    <!-- 註解也可以有 CJK 假標籤 <偽標籤/> --></text>\n` +
        `  </g>\n` +
        `</svg>`,
    },
  ].map(({ label, svg }) => ({ label, svg, expected: scanDocument(svg) }));

  function expectedError(svg) {
    try {
      scanDocument(svg);
    } catch (err) {
      return err.message;
    }
    throw new Error(`gen-golden: expected scanDocument to throw for: ${svg}`);
  }

  // One case per distinct error message scan.rs's module doc comment lists
  // (11 templates across "標記語法錯誤" and "屬性語法錯誤").
  const errorCases = [
    { label: "empty-tag-name", svg: "<>" },
    { label: "open-tag-missing-gt", svg: `<foo note="測試"` },
    { label: "attribute-name-unparseable", svg: `<a ="x"/>` },
    { label: "attribute-missing-equals", svg: `<a bar/>` },
    { label: "attribute-value-not-quoted", svg: `<a bar=1/>` },
    // A bare `"` right after the tag name: readOpenTag's own quote-tracking
    // `>`-search treats it as OPENING a quote, so a later unquoted `>`
    // legitimately ends the tag; scanAttributes then re-walks the same
    // region with its own name/value split, recovers the literal `"` as
    // the attribute NAME, and immediately hits the region boundary before
    // finding a matching close quote for the value it starts reading next
    // (see crates/co-motion/src/slide/scan.rs's own test of this same
    // structural edge case for the full explanation).
    { label: "attribute-value-quote-unterminated", svg: `<a "="/>` },
    { label: "close-tag-missing-gt", svg: `<a></a` },
    { label: "stray-close-tag-at-top-level", svg: `<a></a></a>` },
    { label: "close-tag-name-mismatch", svg: `<a></b>` },
    { label: "eof-with-unclosed-element", svg: `<a><b></b>` },
    { label: "unclosed-processing-instruction", svg: `<a><?pi unterminated</a>` },
  ].map(({ label, svg }) => ({ label, svg, expectedMessage: expectedError(svg) }));

  writeJson("scan.json", { tree: treeCases, errors: errorCases });
}

// --- bbox.json ----------------------------------------------------------
//
// NOOP-292: one golden case per primitive/element kind A9 requires
// (rect/ellipse/line/path incl. arcs/group/table/text), run through the
// REAL `primitiveBounds`/`elementBounds`/`pathBounds`
// (`packages/core/dist/geometry/bbox.js`), never hand-computed. Every
// numeric field is captured through `formatSvgNumber` (the same 4-decimal,
// trailing-zero-free string this codebase compares golden fixtures with
// everywhere else), matching plan A9's "比較序列化後的 format_svg_number
// 字串" instruction exactly.
async function genBbox() {
  const { formatSvgNumber } = await import(join(repoRoot, "packages/core/dist/svg-number.js"));
  const { primitiveBounds, elementBounds, pathBounds } = await import(
    join(repoRoot, "packages/core/dist/geometry/bbox.js")
  );
  const { parseFont } = await import(join(repoRoot, "packages/core/dist/text-metrics.js"));
  const { readFileSync } = await import("node:fs");

  const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  function fmtRect(rect) {
    return {
      x: formatSvgNumber(rect.x),
      y: formatSvgNumber(rect.y),
      width: formatSvgNumber(rect.width),
      height: formatSvgNumber(rect.height),
    };
  }

  function prim(tag, attrs, extra = {}) {
    return {
      tag,
      attrs: new Map(Object.entries(attrs)),
      text: "",
      tspanCount: 0,
      runs: [],
      ...extra,
    };
  }

  function leafElement(id, kind, primitives, extra = {}) {
    return {
      id,
      name: null,
      media: null,
      kind,
      transform: null,
      matrix: IDENTITY,
      children: [],
      primitives,
      textWidth: null,
      textHeight: null,
      textAlign: "left",
      table: null,
      ...extra,
    };
  }

  // rect / ellipse / line: primitive-level bounds, no text context needed.
  const primitiveSpecs = [
    { label: "rect", tag: "rect", attrs: { x: "5", y: "10", width: "20", height: "30" } },
    { label: "ellipse", tag: "ellipse", attrs: { cx: "15", cy: "25", rx: "5", ry: "8" } },
    { label: "line", tag: "line", attrs: { x1: "12", y1: "3", x2: "4", y2: "9" } },
  ];
  const primitiveCases = primitiveSpecs.map(({ label, tag, attrs }) => ({
    label,
    tag,
    attrs,
    expected: fmtRect(primitiveBounds(prim(tag, attrs))),
  }));

  // path: a cubic Bézier (real curve extrema, not just straight segments —
  // already spot-checked against the Rust port by hand in Review round 1,
  // NOOP-283) plus the deliberately-unsupported elliptical-arc path, which
  // both engines must reject with the identical message.
  const pathOkD = "M0 0 C 10 100 90 -50 100 0";
  const pathOkCase = { label: "path-cubic-bezier", d: pathOkD, expected: fmtRect(pathBounds(pathOkD)) };

  const pathArcD = "M0 0 A5 5 0 0 1 10 10";
  let pathArcMessage;
  try {
    pathBounds(pathArcD);
    throw new Error(`gen-golden: expected pathBounds to reject an arc: ${pathArcD}`);
  } catch (err) {
    pathArcMessage = err.message;
  }
  const pathArcCase = { label: "path-elliptical-arc-rejected", d: pathArcD, expectedError: pathArcMessage };

  // group: element-level union of two children's transformed boxes.
  const groupChildA = leafElement("child-a", "rect", [prim("rect", { x: "2", y: "3", width: "8", height: "6" })]);
  const groupChildB = leafElement("child-b", "ellipse", [
    prim("ellipse", { cx: "30", cy: "10", rx: "4", ry: "2" }),
  ]);
  const group = leafElement("group-1", "group", [], { children: [groupChildA, groupChildB] });
  const groupCase = { label: "group", expected: fmtRect(elementBounds(group)) };

  // table: declared grid extent (cols/rows sum), not a primitive union.
  const tableCols = [50, 70, 30];
  const tableRows = [20, 25];
  const table = leafElement("table-1", "table", [], {
    table: { cols: tableCols, rows: tableRows, header: false, theme: {}, source: null, cells: [] },
  });
  const tableCase = { label: "table", cols: tableCols, rows: tableRows, expected: fmtRect(elementBounds(table)) };

  // text: a plain `<text>` (no tspans) — x/y/measured-width path, using the
  // real embedded default font so glyph advances are exactly what the Rust
  // port's `DEFAULT_FONT_BYTES` (the same physical .ttf file) will measure.
  const fontBytes = readFileSync(
    join(repoRoot, "packages/core/src/assets/fonts/NotoSansTC-Presentation.ttf"),
  );
  const font = parseFont(new Uint8Array(fontBytes));
  const fonts = new Map([["Noto Sans TC", font]]);
  const textAttrs = { x: "10", y: "50", "font-family": "Noto Sans TC", "font-size": "24" };
  const textPrimitive = prim("text", textAttrs, { text: "Hello 世界" });
  const textContext = { fonts, textWidth: null, textHeight: null, elementId: "text-1" };
  const textCase = {
    label: "text-plain",
    attrs: textAttrs,
    text: "Hello 世界",
    expected: fmtRect(primitiveBounds(textPrimitive, textContext)),
  };

  writeJson("bbox.json", {
    primitives: primitiveCases,
    path: { ok: pathOkCase, arcRejected: pathArcCase },
    group: groupCase,
    table: tableCase,
    text: textCase,
  });
}

// --- font.json ------------------------------------------------------------
//
// NOOP-292: `parseFont`'s line metrics plus >=50 `measureTextWidth` cases
// (string x font size), all run against the REAL bundled font
// (`packages/core/dist/text-metrics.js`'s `parseFont`/`measureTextWidth`
// over the same physical `.ttf` the Rust port embeds via
// `include_bytes!`) — never hand-computed.
async function genFont() {
  const { formatSvgNumber } = await import(join(repoRoot, "packages/core/dist/svg-number.js"));
  const { parseFont, measureTextWidth } = await import(
    join(repoRoot, "packages/core/dist/text-metrics.js")
  );
  const { readFileSync } = await import("node:fs");

  const fontBytes = readFileSync(
    join(repoRoot, "packages/core/src/assets/fonts/NotoSansTC-Presentation.ttf"),
  );
  const font = parseFont(new Uint8Array(fontBytes));

  const metrics = {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    lineGap: font.lineGap,
  };

  // >= 50 (string, font size) pairs: empty string, ASCII words/sentences,
  // ligature-prone pairs (fi/ffi/AV), CJK, emoji (astral code points —
  // outside format-4's BMP, format-12/notdef-fallback territory),
  // whitespace-only, punctuation, and mixed scripts.
  const strings = [
    "",
    "A",
    "a",
    "AB",
    "ab",
    "Hello",
    "hello world",
    "The quick brown fox jumps over the lazy dog",
    "1234567890",
    "!@#$%^&*()",
    "fi",
    "ffi",
    "AV",
    "VA",
    "WA",
    "Type",
    "Waffle",
    "測試",
    "中文字排版測試",
    "你好，世界！",
    "繁體中文字型量測",
    "一二三四五六七八九十",
    "😀",
    "😀😀",
    "Hello😀World",
    "🚀🔥✨",
    "café",
    "naïve",
    "日本語テスト",
    "한국어 테스트",
    "MixedCJK中文ABC123",
    " leading space",
    "trailing space ",
    "double  space",
    "line\twith\ttabs",
    "punctuation, semicolons; colons:",
    "quotes\"'and'\"marks",
    "emDash—enDash–",
    "ellipsis…",
    "Ligature test: fi fl ffi ffl",
    "Kerning test: AV AW AY VA WA YA",
    "0123456789ABCDEF",
    "aAbBcCdDeE",
    "xyz XYZ",
    "測試ABC混合123",
    "Hello, 世界! 123",
    "  ",
    "\t",
    "。，、！？「」『』",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
    "中文標點：，。！？",
    "𠀀𠀁𠀂",
  ];
  const sizes = [8, 12, 16, 24, 32, 48];

  const cases = strings.map((text, i) => ({
    text,
    fontSizePx: sizes[i % sizes.length],
    expected: formatSvgNumber(measureTextWidth(font, text, sizes[i % sizes.length])),
  }));

  writeJson("font.json", { metrics, measureTextWidth: cases });
}

// --- text_wrap_extra_cases.json -------------------------------------------
//
// NOOP-292 (Review round 1, NOOP-283): the plan's single `text_wrap_fixture`
// case (full CLI end-to-end) doesn't cover CJK-only, ASCII-only, an
// explicit hard break, list-paragraph indents (bullet/number), a single
// word wider than the box, or an empty paragraph. These six run
// `wrapText`/`renderTextBoxContent` directly (`packages/core/dist/text/
// wrap.js`, `.../render.js`) — the same two functions the CLI-level fixture
// exercises, just without the CLI round trip — over the real bundled font,
// and (for the list case) real `parseListTokens`/`listIndents`
// (`.../text/list.js`) rather than a hand-picked indent constant.
async function genTextWrapExtraCases() {
  const { formatSvgNumber } = await import(join(repoRoot, "packages/core/dist/svg-number.js"));
  const { parseFont } = await import(join(repoRoot, "packages/core/dist/text-metrics.js"));
  const { wrapText } = await import(join(repoRoot, "packages/core/dist/text/wrap.js"));
  const { renderTextBoxContent } = await import(join(repoRoot, "packages/core/dist/text/render.js"));
  const { parseListTokens, listIndents } = await import(join(repoRoot, "packages/core/dist/text/list.js"));
  const { readFileSync } = await import("node:fs");

  const fontBytes = readFileSync(
    join(repoRoot, "packages/core/src/assets/fonts/NotoSansTC-Presentation.ttf"),
  );
  const font = parseFont(new Uint8Array(fontBytes));
  const fontFamily = "Noto Sans TC";

  function wrapCase(label, text, width, fontSizePx, extraOptions = {}) {
    const wrapped = wrapText(text, { width, font, fontSizePx, ...extraOptions });
    return {
      label,
      input: { text, width, fontSizePx, fontFamily, ...(extraOptions.indents ? { indents: extraOptions.indents } : {}) },
      expectedInnerMarkup: renderTextBoxContent(wrapped.lines, []),
      expectedTextHeight: formatSvgNumber(wrapped.height),
    };
  }

  const cases = [];

  cases.push(wrapCase("cjk-only", "中文測試內容全形標點，句子換行示範文字排版效果如何", 200, 20));

  cases.push(
    wrapCase(
      "ascii-only",
      "The quick brown fox jumps over the lazy dog and keeps running",
      180,
      16,
    ),
  );

  cases.push(wrapCase("hard-break", "第一段內容\n第二段內容，稍微長一點以便換行測試", 150, 18));

  // Bullet AND number in one fixture — wrap.ts/wrap.rs only ever see a
  // per-paragraph indent NUMBER (list.ts/list.rs is what turns a
  // bullet/number token into that number, both via the same
  // `LIST_INDENT_EM` regardless of kind), so a real
  // `parseListTokens`/`listIndents` run over [bullet, none, number] is what
  // actually distinguishes this case from a hand-picked indent — not two
  // separate fixtures that would produce numerically identical indents.
  {
    const text = "項目一內容稍長會自動換行測試\n一般段落沒有清單樣式\n第二個列表項目也需要編號";
    const width = 140;
    const fontSizePx = 16;
    const tokens = parseListTokens("bullet none number", 3, "list-fixture");
    const indents = listIndents(tokens, fontSizePx);
    cases.push(wrapCase("list-bullet-and-number-indent", text, width, fontSizePx, { indents }));
  }

  cases.push(wrapCase("overlong-single-word", "Supercalifragilisticexpialidocious", 50, 20));

  cases.push(wrapCase("empty-paragraph", "第一段落內容\n\n第三段落內容在此", 200, 18));

  writeJson("text_wrap_extra_cases.json", cases);
}

// --- media_format.json ----------------------------------------------------
//
// NOOP-281/F5: `detect_media_format`'s byte-header sniffing (~15 formats)
// had only hand-written Rust unit tests whose expected values were reasoned
// by the same porting pass that wrote the function — self-verification, the
// exact pattern this ticket's own review guidance flags as weak evidence
// for a byte-magic-number table. This fixture runs the REAL
// `detectMediaFormat` (`packages/core/dist/media-format.js`) against the
// same byte sequences, plus the "extension lies, header wins" case, so the
// Rust port is checked against the TS oracle instead of against its own
// reasoning about the TS oracle.
async function genMediaFormat() {
  const { detectMediaFormat } = await import(
    join(repoRoot, "packages/core/dist/media-format.js")
  );

  function repeatZeros(n) {
    return new Array(n).fill(0);
  }
  function bytesOf(str) {
    return Array.from(Buffer.from(str, "latin1"));
  }

  const cases = [
    { label: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0] },
    { label: "jpeg", bytes: [0xff, 0xd8, 0xff, 0xe0, 0, 0] },
    { label: "gif", bytes: bytesOf("GIF89a....") },
    { label: "webp", bytes: [...bytesOf("RIFF"), 0, 0, 0, 0, ...bytesOf("WEBP")] },
    { label: "wav", bytes: [...bytesOf("RIFF"), 0, 0, 0, 0, ...bytesOf("WAVE")] },
    { label: "riff-unknown-format-tag", bytes: [...bytesOf("RIFF"), 0, 0, 0, 0, ...bytesOf("AVI ")] },
    { label: "mp4-generic-brand", bytes: [0, 0, 0, 0x18, ...bytesOf("ftyp"), ...bytesOf("isom")] },
    { label: "mov-qt-brand", bytes: [0, 0, 0, 0x14, ...bytesOf("ftyp"), ...bytesOf("qt  ")] },
    { label: "m4v", bytes: [0, 0, 0, 0x18, ...bytesOf("ftyp"), ...bytesOf("M4V ")] },
    { label: "m4a", bytes: [0, 0, 0, 0x18, ...bytesOf("ftyp"), ...bytesOf("M4A ")] },
    { label: "webm", bytes: [0x1a, 0x45, 0xdf, 0xa3, 0, 0] },
    { label: "ogv-theora", bytes: [...bytesOf("OggS"), ...repeatZeros(20), ...bytesOf("\x80theora")] },
    { label: "opus", bytes: [...bytesOf("OggS"), ...repeatZeros(20), ...bytesOf("OpusHead")] },
    { label: "oga-vorbis", bytes: [...bytesOf("OggS"), ...repeatZeros(20), ...bytesOf("\x01vorbis")] },
    { label: "ogg-unrecognised-codec-is-none", bytes: [...bytesOf("OggS"), ...repeatZeros(40)] },
    { label: "mp3-id3", bytes: [...bytesOf("ID3"), 3, 0, 0, 0, 0, 0, 0] },
    { label: "mp3-frame-sync-layer-iii", bytes: [0xff, 0xfb, 0x90, 0x00] },
    { label: "aac-adts-frame-sync", bytes: [0xff, 0xf1, 0x50, 0x80] },
    { label: "unknown-bytes-is-none", bytes: [0, 1, 2, 3, 4, 5, 6, 7] },
  ];

  const results = cases.map(({ label, bytes }) => ({
    label,
    bytes,
    expected: detectMediaFormat(new Uint8Array(bytes)),
  }));

  writeJson("media_format.json", results);
}

await genSvgNumber();
await genTextWrapFixture();
await genScan();
await genBbox();
await genFont();
await genTextWrapExtraCases();
await genMediaFormat();

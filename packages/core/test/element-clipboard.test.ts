import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import {
  extractElementsForCopy,
  parseClipboardSvg,
  pasteElements,
  sanitizeClipboardMarkup,
  serializeClipboardSvg,
  type ClipboardPayload,
} from "../src/element-clipboard.js";
import { STYLE_ATTRIBUTE_WHITELIST } from "../src/element-edit.js";
import { assertSlideCompliant } from "../src/slide/format.js";
import { attributeValue, scanDocument } from "../src/slide/scan.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const wrap = (body: string, viewBox = "0 0 1280 720"): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

describe("serializeClipboardSvg / parseClipboardSvg round-trip", () => {
  it("round-trips a payload with one element and no effects", () => {
    const payload: ClipboardPayload = {
      sourceSlidePath: "slides/001.svg",
      elements: ['<g id="el-a" transform="translate(10 20)"><rect width="100" height="50"/></g>'],
      effects: [],
      viewBox: "0 0 1280 720",
    };
    const markup = serializeClipboardSvg(payload);
    expect(markup).toContain('data-comot-clipboard="elements"');
    expect(markup).toContain('data-comot-source="slides/001.svg"');
    expect(parseClipboardSvg(markup)).toEqual(payload);
  });

  it("round-trips a payload with elements and effects", () => {
    const payload: ClipboardPayload = {
      sourceSlidePath: "slides/002.svg",
      elements: ['<g id="el-a"><rect width="10" height="10"/></g>', '<g id="el-b"><rect width="5" height="5"/></g>'],
      effects: ['<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>'],
      viewBox: "0 0 1920 1080",
    };
    const markup = serializeClipboardSvg(payload);
    expect(parseClipboardSvg(markup)).toEqual(payload);
  });

  it("extractElementsForCopy captures the source slide's viewBox", () => {
    const svg = wrap('<g id="el-a"><rect width="10" height="10"/></g>', "0 0 1920 1080");
    const payload = extractElementsForCopy(svg, "slides/001.svg", ["el-a"]);
    expect(payload.viewBox).toBe("0 0 1920 1080");
  });

  it("serializeClipboardSvg falls back to a default viewBox when the payload has none (pre-existing clipboard file)", () => {
    const payload: ClipboardPayload = {
      sourceSlidePath: "slides/001.svg",
      elements: ['<g id="el-a"><rect width="10" height="10"/></g>'],
      effects: [],
    };
    expect(() => serializeClipboardSvg(payload)).not.toThrow();
    expect(serializeClipboardSvg(payload)).toContain('viewBox="0 0 1280 720"');
  });

  it("parseClipboardSvg returns null for plain foreign SVG (no clipboard marker)", () => {
    expect(parseClipboardSvg(wrap('<g id="el-a"><rect width="10" height="10"/></g>'))).toBeNull();
  });

  it("parseClipboardSvg returns null for non-SVG / unparsable text", () => {
    expect(parseClipboardSvg("hello world")).toBeNull();
    expect(parseClipboardSvg("<svg><rect></svg>")).toBeNull();
  });
});

describe("sanitizeClipboardMarkup", () => {
  it("accepts a clean element fragment, including the effects.test.ts hand-built payload shape", () => {
    expect(() => sanitizeClipboardMarkup('<g id="el-src"><rect width="10" height="10"/></g>', "element")).not.toThrow();
  });

  it("accepts a clean effect fragment with only whitelisted attributes", () => {
    expect(() =>
      sanitizeClipboardMarkup('<comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>', "effect"),
    ).not.toThrow();
  });

  it("rejects <script> anywhere in an element fragment", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><rect width="10" height="10"/><script>alert(1)</script></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects an on* event handler attribute", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a" onload="alert(1)"><rect width="10" height="10"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects an effect attribute outside the RawEffectAttributes whitelist", () => {
    expect(() =>
      sanitizeClipboardMarkup('<comot:effect target="el-a" family="enter" effect="fade" start="on-click" onx="1"/>', "effect"),
    ).toThrow(CoMotionError);
  });

  it("a <g> missing an id is rejected via the reused compliance check", () => {
    expect(() => sanitizeClipboardMarkup('<g><rect width="1" height="1"/></g>', "element")).toThrow(CoMotionError);
  });

  // --- rejection / acceptance / declaration matrices ---
  // Cell ids match [E2.T18] r3 plan §6.4 so a reviewer can check this table against
  // that one line by line. Rows tagged "pre-existing regression" are earlier rounds'
  // individual `it()`s, kept verbatim rather than rewritten to the plan's own (distinct)
  // literal for the same cell — both a canonical cell payload and a pre-existing
  // regression payload survive where the two differ.
  const REJECT_MATRIX: ReadonlyArray<[cell: string, markup: string]> = [
    ["C01", '<g id="el-a"><image href="javascript:alert(1)" width="1" height="1"/></g>'],
    ["C02", '<g id="el-a"><image href="&#106;avascript:alert(1)" width="1" height="1"/></g>'],
    ["C03", '<g id="el-a"><image href="&#x6a;avascript:alert(1)" width="1" height="1"/></g>'],
    ["C04", '<g id="el-a"><rect style="fill:url(data:image/svg+xml,x)" width="1" height="1"/></g>'],
    ["C05", '<g id="el-a"><image href="x https://evil.example/y" width="1" height="1"/></g>'],
    [
      "C05 (pre-existing regression, plain absolute)",
      '<g id="el-a"><image href="https://evil.example/x.png" width="1" height="1"/></g>',
    ],
    ["C06", '<g id="el-a"><image href="&#104;ttps://evil.example/x.png" width="1" height="1"/></g>'],
    ["C07", '<g id="el-a"><image href="&#x68;ttps://evil.example/x.png" width="1" height="1"/></g>'],
    ["C08", '<g id="el-a"><image xlink:href="&#x68;ttps://evil.example/x.png" width="1" height="1"/></g>'],
    [
      "C08 (pre-existing regression, decimal)",
      '<g id="el-a"><image xlink:href="&#104;ttps://evil.example/x.png" width="1" height="1"/></g>',
    ],
    ["C09", '<g id="el-a"><image href="&#x2f;&#x2f;evil.example/x.png" width="1" height="1"/></g>'],
    ["C10", '<g id="el-a"><rect fill="x &#x2f;&#x2f;evil.example/y" width="1" height="1"/></g>'],
    ["C11", '<g id="el-a"><rect style="fill:url(https://evil.example/x.svg#g)" width="1" height="1"/></g>'],
    ["C12", '<g id="el-a"><rect style="fill:&#x75;rl(&#x2f;&#x2f;evil.example/x.svg#g)" width="1" height="1"/></g>'],
    ["C14", '<g id="el-a"><rect filter="&#x75;rl(&#x2f;&#x2f;evil.example/f.svg#f)" width="1" height="1"/></g>'],
    ["C15", '<g id="el-a"><rect style="fill:url(&quot;//evil.example/x.svg&quot;)" width="1" height="1"/></g>'],
    ["C16", '<g id="el-a"><rect style="fill:url(#&#x2f;&#x2f;evil.example)" width="1" height="1"/></g>'],
    ["C17", '<g id="el-a"><image href="https:evil.example/x.png" width="1" height="1"/></g>'],
    ["C18", '<g id="el-a"><image href="HTTPS:evil.example/x.png" width="1" height="1"/></g>'],
    ["C19", '<g id="el-a"><image href=" https:evil.example/x.png" width="1" height="1"/></g>'],
    ["C20", '<g id="el-a"><image href="&#x68;ttps:evil.example/x.png" width="1" height="1"/></g>'],
    ["C21", '<g id="el-a"><image src="//evil.example/x.png" width="1" height="1"/></g>'],
    ["C22", '<g id="el-a"><image xlink:href="mailto:a@b.c" width="1" height="1"/></g>'],
    ["C23", '<g id="el-a"><image href="&#x110000;abc" width="1" height="1"/></g>'],
    ["C24", '<g id="el-a"><image href="&#99999999999;abc" width="1" height="1"/></g>'],
    ["C25", '<g id="el-a"><rect fill="&#xD800;x" width="1" height="1"/></g>'],
    ["X1", '<g id="el-a"><image href="\\\\evil.example\\x.png" width="1" height="1"/></g>'],
    ["X2", '<g id="el-a"><image href="\\/evil.example/x.png" width="1" height="1"/></g>'],
    [
      "X4",
      '<g id="el-a" xmlns:xl="http://www.w3.org/1999/xlink"><image xl:href="https:evil.example/x.png" width="1" height="1"/></g>',
    ],
    // r5 (NOOP-201 §6.2): round-4 bypasses I1 (URL-parser delegation) and I2/I3 close.
    ["N1", '<g id="el-a"><image href="/\t/evil.example/x.png" width="1" height="1"/></g>'],
    ["N2", '<g id="el-a"><image href="/\n/evil.example/x.png" width="1" height="1"/></g>'],
    ["N3", '<g id="el-a"><image href="/\r/evil.example/x.png" width="1" height="1"/></g>'],
    ["N4", '<g id="el-a"><image HREF="https:evil.example/x.png" width="1" height="1"/></g>'],
    ["N5", '<g id="el-a"><image XLINK:HREF="https:evil.example/x.png" width="1" height="1"/></g>'],
    ["N6", '<g id="el-a"><image SRC="https:evil.example/x.png" width="1" height="1"/></g>'],
    ["N7", '<g id="el-a"><image Href="https:evil.example/x.png" width="1" height="1"/></g>'],
    [
      "N8",
      '<g id="el-a" xmlns:xl="http://www.w3.org/1999/xlink"><image Xl:HrEf="https:evil.example/x.png" width="1" height="1"/></g>',
    ],
    ["N9", '<g id="el-a"><image a:b:href="https:evil.example/x.png" width="1" height="1"/></g>'],
    ["N10", '<g id="el-a"><image href="/&#9;/evil.example/x.png" width="1" height="1"/></g>'],
    ["N11", '<g id="el-a"><rect style="fill:\\75rl(\\00002f\\00002fevil.example/x.svg#g)" width="1" height="1"/></g>'],
    ["N12", '<g id="el-a"><image href="ht\tps://evil.example/x.png" width="1" height="1"/></g>'],
    // r6 (NOOP-210/[E2.T18r6] AC1): r5's three CSS-carrying bypasses, closed by
    // dropping `style` from the allowlist entirely rather than adding a fourth
    // CSS-shape rule — none of these ever reach a value check, all three fail
    // at "style not in allowlist".
    ["R1", '<g id="el-a"><rect style="fill:url(https:evil.example/x.svg#g" width="1" height="1"/></g>'],
    ["R2", '<g id="el-a"><rect style="cursor:image-set(&quot;https:evil.example/c.png&quot; 1x),auto" width="1" height="1"/></g>'],
    ["R3", '<g id="el-a"><rect style="background-image:image-set(&quot;https:evil.example/c.png&quot; 1x)" width="1" height="1"/></g>'],
    // r6 (AC3): r5 judged these two "not a problem" under the denylist; the
    // allowlist closes them for free (style / data-x are simply not on any
    // tag's attribute list), which is the concrete case for allowlist > denylist.
    ["J1", '<g id="el-a"><rect style="fill:src(https://evil.example/x.png)" width="1" height="1"/></g>'],
    ["J2", '<g id="el-a" data-x="https://evil.example/x"><rect width="1" height="1"/></g>'],
  ];

  it.each(REJECT_MATRIX)("rejects %s", (_cell, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "element")).toThrow(CoMotionError);
  });

  const ACCEPT_MATRIX: ReadonlyArray<[cell: string, markup: string]> = [
    // r6 ([E2.T18r6] 決定 D4): rewritten, not deleted — style is gone from the
    // allowlist entirely, so the internal reference this cell guards against
    // over-rejection now has to live on the native attribute the serializer
    // actually writes it on (`fill`, not `style`).
    ["P01", '<g id="el-a"><rect fill="url(#grad1)" width="1" height="1"/></g>'],
    ["P02", '<g id="el-a"><image href="#frag" width="1" height="1"/></g>'],
    ["P03", '<g id="el-a"><image href="images/logo.png" width="1" height="1"/></g>'],
    // r6 (決定 D4): rewritten — `&#x10FFFF;` is a legal high-codepoint XML
    // character reference, but it isn't a legal `PAINT` value; the cell's
    // point (a legal reference must not be over-rejected as illegal XML) now
    // has to live on a free-text attribute instead of `fill`.
    ["P04", '<g id="el-a" data-comot-name="&#x10FFFF;"><rect width="1" height="1"/></g>'],
    ["P05", '<g id="el-a" data-comot-name="第 3 章：url(#a) 的說明"><rect width="1" height="1"/></g>'],
    // r5 (NOOP-201 §6.2): guardrails for I1/I3 — must not over-reject.
    ["P06", '<g id="el-a"><image href="" width="1" height="1"/></g>'],
    ["P07", '<g id="el-a"><path d="M0 0\nL1 1"/></g>'],
    ["P08", '<g id="el-a"><image href="../img/a.png" width="1" height="1"/></g>'],
    ["P09", '<g id="el-a"><image href="a&amp;b.png" width="1" height="1"/></g>'],
    // r7 ([E2.T18r7] FAIL #2): write-side source is `element insert`'s `href`,
    // which imposes no ASCII restriction — a Chinese-named asset path is
    // ordinary input on a Traditional-Chinese-first product, not an edge case.
    ["P10", '<g id="el-a"><image href="../assets/照片.png" width="1" height="1"/></g>'],
  ];

  it.each(ACCEPT_MATRIX)("accepts %s", (_cell, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "element")).not.toThrow();
  });

  // r6 ([E2.T18r6] §6.4, AC5): shapes `serializeClipboardSvg` actually
  // produces that no prior round's matrix covered — literal values taken
  // verbatim from the plan's pod-verified `element copy` output (§3.3), not
  // hand-typed, so a wrong grammar entry shows up as a false rejection here.
  const ACCEPT_SHAPES: ReadonlyArray<[cell: string, markup: string]> = [
    [
      "ellipse with a rotate() transform",
      '<g id="el-JybPIISuQCCR" transform="translate(200 20) rotate(30)"><ellipse cx="40" cy="20" rx="40" ry="20" fill="#0b3d91"/></g>',
    ],
    [
      "locked line",
      '<g data-comot-lock="true" id="el-P0I-HMrTeIUb"><line x1="0" y1="0" x2="100" y2="100" stroke="#000" stroke-width="3"/></g>',
    ],
    [
      "media placeholder (data-comot-media relative path)",
      '<g id="el-eYFfylM1nOMY" data-comot-media="../assets/clip.webm" transform="translate(400 20)"><rect x="0" y="0" width="60" height="60"/></g>',
    ],
    [
      "text box: list spec + a bold/italic run tspan + a break tspan + a list-marker text",
      '<g id="el-X_hoxBy60u_O" data-comot-text-width="220" data-comot-text-height="104.256" data-comot-text-align="center" transform="translate(600 100)">' +
        '<text data-comot-list="bullet none" font-family="Noto Sans TC" font-size="24" fill="#fff" xml:space="preserve">' +
        '<tspan x="44" y="27.84"><tspan font-weight="700" font-style="italic">第一段</tspan>文字很長</tspan>' +
        '<tspan x="56" y="62.592" data-comot-break="1">需要換行測試</tspan><tspan x="74" y="97.344">第二段</tspan></text>' +
        '<text data-comot-list-marker="true" font-family="Noto Sans TC" font-size="24" fill="#fff" xml:space="preserve">' +
        '<tspan x="0" y="27.84">•</tspan></text></g>',
    ],
  ];

  it.each(ACCEPT_SHAPES)("accepts %s", (_label, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "element")).not.toThrow();
  });

  const EFFECT_ACCEPT_SHAPES: ReadonlyArray<[cell: string, markup: string]> = [
    ["enter/fade", '<comot:effect target="el-jtW-4ng6_Mpb" family="enter" effect="fade" start="on-click" duration="500" delay="100"/>'],
    [
      "path effect with d",
      '<comot:effect target="el-dyi7D-u9p3SX" family="path" effect="path" start="after-previous" duration="0.6" delay="0" d="M0 0 L100 100"/>',
    ],
    ["media/play", '<comot:effect target="el-eYFfylM1nOMY" family="media" effect="play" start="on-click" duration="0" delay="0"/>'],
  ];

  it.each(EFFECT_ACCEPT_SHAPES)("accepts effect %s", (_label, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "effect")).not.toThrow();
  });

  // r6 (§6.4): behavior-contract boundary rows from §4.1 that no existing
  // matrix cell covers — an empty container, an unknown tag, a type error, a
  // rejected transform function alongside three over-rejection guards.
  const BEHAVIOR_BOUNDARY: ReadonlyArray<[label: string, markup: string, shouldThrow: boolean]> = [
    ["an empty container (with an id) is rejected", '<g id="el-a"></g>', true],
    ["an unknown tag (<use>) is rejected", '<g id="el-a"><use href="#x" width="1" height="1"/></g>', true],
    ["a non-numeric width is rejected", '<g id="el-a"><rect width="abc" height="1"/></g>', true],
    ["transform=\"url(#a)\" is rejected", '<g id="el-a" transform="url(#a)"><rect width="1" height="1"/></g>', true],
    ["fill=\"url(#grad1)\" (internal reference) is accepted", '<g id="el-a"><rect fill="url(#grad1)" width="1" height="1"/></g>', false],
    ["an identity transform=\"\" is accepted", '<g id="el-a" transform=""><rect width="1" height="1"/></g>', false],
    ["an id on a primitive (not just the container) is accepted", '<g id="el-a"><text id="el-a-text" x="0" y="0">hi</text></g>', false],
    [
      "an indented/newline convert-output fragment is accepted",
      '<g id="el-tBF580-7QNrp" data-comot-name="標題">\n    <text x="640" y="360" text-anchor="middle" font-family="Noto Sans TC" font-size="48">allowlist-probe</text>\n  </g>',
      false,
    ],
    // r7 ([E2.T18r7] FAIL #1): write-side source is `element-text.ts:110-116`'s
    // `data-comot-list` contract — one token per paragraph, `content.split("\n")`,
    // no upper bound. A three-paragraph list is ordinary input; the r6 grammar
    // capped at two tokens and rejected it.
    [
      "a data-comot-list with three tokens (three-paragraph text box) is accepted",
      '<g id="el-a"><text data-comot-list="bullet none none" font-size="24" xml:space="preserve"><tspan x="0" y="1">a</tspan></text></g>',
      false,
    ],
    // r7 ([E2.T18r7] FAIL #3): write-side source is `element-group.ts`'s
    // `setElementName` — it never bounds `name`'s length, and length isn't a
    // security property for a non-reference-carrying free-text attribute (D9).
    [
      "a data-comot-name longer than 512 characters is accepted",
      `<g id="el-a" data-comot-name="${"長".repeat(600)}"><rect width="1" height="1"/></g>`,
      false,
    ],
    // r7 ([E2.T18r7] FAIL #4): a prototype-chain property name must fall
    // through to the same "not on the allowlist" rejection as any other
    // unrecognised attribute — not resolve to an inherited `Object.prototype`
    // value (which was truthy and passed), and not throw a raw JS TypeError
    // instead of CoMotionError (`valueOf`/`__proto__`'s old failure mode).
    ["a constructor attribute name is rejected, not silently accepted via Object.prototype", '<g id="el-a"><rect width="1" height="1" constructor="x"/></g>', true],
    ["a toString attribute name is rejected, not silently accepted via Object.prototype", '<g id="el-a"><rect width="1" height="1" toString="x"/></g>', true],
    ["a __proto__ attribute name is rejected with CoMotionError, not a raw TypeError", '<g id="el-a"><rect width="1" height="1" __proto__="x"/></g>', true],
  ];

  it.each(BEHAVIOR_BOUNDARY)("%s", (_label, markup, shouldThrow) => {
    if (shouldThrow) {
      expect(() => sanitizeClipboardMarkup(markup, "element")).toThrow(CoMotionError);
    } else {
      expect(() => sanitizeClipboardMarkup(markup, "element")).not.toThrow();
    }
  });

  const DECLARATION_MATRIX: ReadonlyArray<[cell: string, markup: string]> = [
    ["D01", '<g id="el-a"><!DOCTYPE foo><rect width="1" height="1"/></g>'],
    ["D02", '<g id="el-a"><!ENTITY foo "bar"><rect width="1" height="1"/></g>'],
    ["D03", '<g id="el-a"><text x="0" y="0"><![CDATA[<script>alert(1)</script>]]></text></g>'],
    ["D04", '<g id="el-a"><!--<script>alert(1)</script>--><rect width="1" height="1"/></g>'],
  ];

  it.each(DECLARATION_MATRIX)("rejects %s", (_cell, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "element")).toThrow(CoMotionError);
  });

  // r5 (NOOP-201 §6.2, I4): the fragment must scan to exactly one root of the expected tag.
  it("rejects an element fragment with more than one root node", () => {
    const markup = '<g id="el-a"><rect width="1" height="1"/></g><style>@import "//evil.example/x.css";</style>';
    expect(() => sanitizeClipboardMarkup(markup, "element")).toThrow(CoMotionError);
  });

  it("rejects an effect fragment whose root tag isn't comot:effect", () => {
    expect(() => sanitizeClipboardMarkup('<rect width="1" height="1"/>', "effect")).toThrow(CoMotionError);
  });
});

/**
 * r5 (NOOP-201 §6.2)/r6 ([E2.T18r6] §6.3, test-budget pass): this describe
 * used to carry 5 additional `it.each` cases asserting the platform `URL`
 * parser's own normalisation behavior (TAB/LF stripping, backslash-as-path-
 * separator, case-insensitive scheme, authority-less absolute) — each one
 * duplicates an input that already has independent, public-API coverage in
 * `REJECT_MATRIX` (N1/N2/X1/C18 respectively) exercised through
 * `sanitizeClipboardMarkup` itself. Pruned: they tested the platform, not
 * this module, and a public-API regression test already covers every input
 * they used to name. Kept: "complementary externals" below, the one
 * property (the two-probe-base design's actual reason to exist) no
 * `REJECT_MATRIX` cell exercises directly.
 */
describe("WHATWG URL parser characteristics I1 depends on", () => {
  const HTTPS_BASE = "https://clipboard.invalid/base/";

  it("an https: value against an http: base and an http: value against an https: base are complementary externals", () => {
    expect(new URL("https:evil.example/x.png", "http://clipboard.invalid/base/").host).toBe("evil.example");
    expect(new URL("http:evil.example/x.png", HTTPS_BASE).host).toBe("evil.example");
  });
});

/**
 * [E2.T18r7] 債: r6's four mis-rejections all traced back to a grammar cell
 * that was copied from a probe corpus's output rather than derived from the
 * write side, so the corpus's blind spots became the grammar's blind spots.
 * This test pins one concrete write-side/grammar seam directly: every
 * attribute name `element style set` (`element-edit.ts`'s
 * `STYLE_ATTRIBUTE_WHITELIST`) is allowed to write must have *some* grammar
 * entry on `<text>` (the one tag carrying both `COMMON` and `TEXTISH`) — if
 * a future `STYLE_ATTRIBUTE_WHITELIST` addition has no `SAMPLE_VALUES` entry
 * below, the first assertion catches that gap explicitly rather than the
 * loop silently skipping it.
 */
describe("traceability: element style set's attribute names all have a clipboard grammar entry", () => {
  const SAMPLE_VALUES: Readonly<Record<string, string>> = {
    fill: "#000000",
    stroke: "none",
    "stroke-width": "1",
    "stroke-dasharray": "1 2",
    opacity: "1",
    "font-family": "Noto Sans TC",
    "font-size": "16",
    "font-weight": "700",
    "text-anchor": "middle",
  };

  it("STYLE_ATTRIBUTE_WHITELIST has a known sample value for every entry", () => {
    const missing = STYLE_ATTRIBUTE_WHITELIST.filter((name) => !(name in SAMPLE_VALUES));
    expect(missing).toEqual([]);
  });

  it.each(STYLE_ATTRIBUTE_WHITELIST.map((name) => [name, SAMPLE_VALUES[name]] as const))(
    "%s=%s is accepted on <text>",
    (name, value) => {
      const markup = `<g id="el-a"><text ${name}="${value}" font-size="16">a</text></g>`;
      expect(() => sanitizeClipboardMarkup(markup, "element")).not.toThrow();
    },
  );
});

describe("A6: serialized clipboard output never contains script or external references", () => {
  it("copying a source slide with a script/onload/external href does not surface any of that in the serialized clipboard SVG (the write path is a compliant slide, so the source itself is already rejected before it could be saved)", () => {
    const dirtySvg = wrap(
      '<g id="el-a"><rect width="10" height="10"/><script>alert(1)</script></g>' +
        '<g id="el-b" onload="x()"><rect width="1" height="1"/></g>' +
        '<g id="el-c"><image xlink:href="https://evil.example/x.png" width="1" height="1"/></g>',
    );
    // A source slide this shape is already non-compliant and could never have been written by this app.
    expect(() => extractElementsForCopy(dirtySvg, "slides/001.svg", ["el-a"])).toThrow(CoMotionError);
  });
});

/**
 * r6 ([E2.T18r6] §3.5/AC7): the wrapper `<svg>`'s own `viewBox` attribute
 * was never validated or escaped before this round — `sourceSlidePath` was,
 * `viewBox` wasn't. A `viewBox` shaped like `0 0 1 1" onload="fetch(...)`
 * closes its own quote and opens a live attribute on the wrapper itself,
 * defeating `serializeClipboardSvg`'s own claim that nothing this app
 * writes to the clipboard can be the unsafe half of a round trip.
 */
describe("AC7: the wrapper <svg>'s viewBox can't inject an attribute", () => {
  it("re-serializing an element copied from a slide with a malicious viewBox does not carry the injection into the output", () => {
    const maliciousSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox='0 0 1 1" onload="fetch(1)'>` +
      '<g id="el-a"><rect width="10" height="10"/></g></svg>';
    const payload = extractElementsForCopy(maliciousSvg, "slides/001.svg", ["el-a"]);
    const output = serializeClipboardSvg(payload);
    expect(output).not.toContain("onload=");
  });

  it("parseClipboardSvg returns null for a clipboard SVG whose viewBox carries the same injection", () => {
    const hostileSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox='0 0 1 1" onload="fetch(1)' ` +
      'data-comot-clipboard="elements" data-comot-source="slides/001.svg">' +
      '<g id="el-a"><rect width="10" height="10"/></g></svg>';
    expect(parseClipboardSvg(hostileSvg)).toBeNull();
  });
});

/**
 * r6 ([E2.T18r6] §5 AC4, §6.4): every element/effect fragment co-motion's
 * own serializer can actually produce, across every compliant fixture slide
 * in the repo, must be accepted — the allowlist's whole premise is "shapes
 * the serializer produces", so a false rejection here means a real user
 * copy/paste would break. Walks `e2e/fixtures/**\/slides/*.svg` and
 * `demo/slides/*.svg` rather than a hand-picked subset, so a shape this
 * suite's authors didn't think to hand-write still gets checked.
 */
describe("AC4: every real serializer output across the repo's fixture slides passes the allowlist", () => {
  function collectSlidePaths(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".svg") && path.basename(dir) === "slides") {
          found.push(full);
        }
      }
    };
    for (const root of ["e2e/fixtures", "demo"]) walk(path.join(repoRoot, root));
    return found;
  }

  it("no false rejection across every compliant slide's top-level elements and effects", () => {
    const slidePaths = collectSlidePaths();
    expect(slidePaths.length).toBeGreaterThan(0);

    let checkedFragments = 0;
    for (const slidePath of slidePaths) {
      const svg = readFileSync(slidePath, "utf8");
      try {
        assertSlideCompliant(svg, slidePath);
      } catch {
        continue; // not every fixture deck is a compliant slide on purpose (e.g. hostile-deck).
      }

      const svgRoot = scanDocument(svg).find((node) => node.tag === "svg");
      if (!svgRoot) continue;
      const topLevelIds = svgRoot.children
        .filter((child) => child.tag === "g")
        .map((child) => attributeValue(child, "id"))
        .filter((id): id is string => id !== null);
      if (topLevelIds.length === 0) continue;

      const payload = extractElementsForCopy(svg, slidePath, topLevelIds);
      for (const element of payload.elements) {
        expect(() => sanitizeClipboardMarkup(element, "element")).not.toThrow();
        checkedFragments++;
      }
      for (const effect of payload.effects) {
        expect(() => sanitizeClipboardMarkup(effect, "effect")).not.toThrow();
        checkedFragments++;
      }
    }
    expect(checkedFragments).toBeGreaterThan(0);
  });
});

describe("pasteElements sanitizes before splicing (the mount point every paste path shares, not only parseClipboardSvg)", () => {
  it("rejects an unsafe element in the payload instead of splicing it into the target slide", () => {
    const target = wrap('<g id="host"><rect width="1" height="1"/></g>');
    const payload: ClipboardPayload = {
      sourceSlidePath: "slides/001.svg",
      elements: ['<g id="el-a"><rect width="10" height="10"/><script>alert(1)</script></g>'],
      effects: [],
    };
    expect(() => pasteElements(target, "slides/002.svg", payload, 0, 0, () => "el-new")).toThrow(CoMotionError);
  });

  it("rejects an unsafe effect in the payload the same way", () => {
    const target = wrap('<g id="host"><rect width="1" height="1"/></g>');
    const payload: ClipboardPayload = {
      sourceSlidePath: "slides/001.svg",
      elements: ['<g id="el-a"><rect width="1" height="1"/></g>'],
      effects: ['<comot:effect target="el-a" family="enter" effect="fade" start="on-click" onx="1"/>'],
    };
    expect(() => pasteElements(target, "slides/002.svg", payload, 0, 0, () => "el-new")).toThrow(CoMotionError);
  });
});

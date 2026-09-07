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
  ];

  it.each(REJECT_MATRIX)("rejects %s", (_cell, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "element")).toThrow(CoMotionError);
  });

  const ACCEPT_MATRIX: ReadonlyArray<[cell: string, markup: string]> = [
    ["P01", '<g id="el-a"><rect style="fill:url(#grad1)" width="1" height="1"/></g>'],
    ["P02", '<g id="el-a"><image href="#frag" width="1" height="1"/></g>'],
    ["P03", '<g id="el-a"><image href="images/logo.png" width="1" height="1"/></g>'],
    ["P04", '<g id="el-a"><rect fill="&#x10FFFF;" width="1" height="1"/></g>'],
    ["P05", '<g id="el-a" data-comot-name="第 3 章：url(#a) 的說明"><rect width="1" height="1"/></g>'],
    // r5 (NOOP-201 §6.2): guardrails for I1/I3 — must not over-reject.
    ["P06", '<g id="el-a"><image href="" width="1" height="1"/></g>'],
    ["P07", '<g id="el-a"><path d="M0 0\nL1 1"/></g>'],
    ["P08", '<g id="el-a"><image href="../img/a.png" width="1" height="1"/></g>'],
    ["P09", '<g id="el-a"><image href="a&amp;b.png" width="1" height="1"/></g>'],
  ];

  it.each(ACCEPT_MATRIX)("accepts %s", (_cell, markup) => {
    expect(() => sanitizeClipboardMarkup(markup, "element")).not.toThrow();
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
 * r5 (NOOP-201 §6.2): I1 bets URL-attribute safety on the global `URL`
 * parser actually performing the normalisation steps the sanitizer no
 * longer hand-codes. This is the one describe in this file that asserts a
 * platform API's behavior rather than this module's own code — if a future
 * Node/browser `URL` implementation stops doing one of these, this should
 * go red instead of the gap opening silently.
 */
describe("WHATWG URL parser characteristics I1 depends on", () => {
  const HTTPS_BASE = "https://clipboard.invalid/base/";
  const HTTP_BASE = "http://clipboard.invalid/base/";

  it.each([
    ["strips an interior TAB", "/\t/evil.example/x.png", HTTPS_BASE, "evil.example"],
    ["strips an interior LF", "/\n/evil.example/x.png", HTTPS_BASE, "evil.example"],
    ["treats a backslash as a path separator (special scheme)", "\\\\evil.example\\x.png", HTTPS_BASE, "evil.example"],
    ["is case-insensitive on scheme", "HTTPS:evil.example/x.png", HTTPS_BASE, "clipboard.invalid"],
    ["accepts an authority without //", "https:evil.example/x.png", HTTPS_BASE, "clipboard.invalid"],
  ])("%s", (_label, value, base, expectedHost) => {
    expect(new URL(value, base).host).toBe(expectedHost);
  });

  it("an https: value against an http: base and an http: value against an https: base are complementary externals", () => {
    expect(new URL("https:evil.example/x.png", HTTP_BASE).host).toBe("evil.example");
    expect(new URL("http:evil.example/x.png", HTTPS_BASE).host).toBe("evil.example");
  });
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

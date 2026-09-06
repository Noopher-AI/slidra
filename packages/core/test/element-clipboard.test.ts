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

  it("rejects a javascript: URI", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><image href="javascript:alert(1)" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects an absolute https:// reference", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><image href="https://evil.example/x.png" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects a url(...) that is not a same-document fragment reference", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><rect style="fill:url(https://evil.example/x.svg#g)" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("accepts a url(#id) same-document fragment reference", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><rect style="fill:url(#grad1)" width="1" height="1"/></g>', "element"),
    ).not.toThrow();
  });

  it("rejects a <!DOCTYPE declaration", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><!DOCTYPE foo><rect width="1" height="1"/></g>', "element"),
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

  it("rejects an href hiding an external URL behind decimal XML character references (&#104; -> 'h')", () => {
    expect(() =>
      sanitizeClipboardMarkup(
        '<g id="el-a"><image href="&#104;ttps://evil.example/x.png" width="1" height="1"/></g>',
        "element",
      ),
    ).toThrow(CoMotionError);
  });

  it("rejects an href hiding an external URL behind hex XML character references (&#x68; -> 'h')", () => {
    expect(() =>
      sanitizeClipboardMarkup(
        '<g id="el-a"><image href="&#x68;ttps://evil.example/x.png" width="1" height="1"/></g>',
        "element",
      ),
    ).toThrow(CoMotionError);
  });

  it("rejects a protocol-relative reference hidden behind entity-encoded slashes (&#x2f;&#x2f; -> '//')", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><image href="&#x2f;&#x2f;evil.example/x.png" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects xlink:href hiding an external URL behind entity encoding", () => {
    expect(() =>
      sanitizeClipboardMarkup(
        '<g id="el-a"><image xlink:href="&#104;ttps://evil.example/x.png" width="1" height="1"/></g>',
        "element",
      ),
    ).toThrow(CoMotionError);
  });

  it("rejects an href hiding a javascript: scheme behind entity encoding", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><image href="&#106;avascript:alert(1)" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects an absolute https:// URL that appears mid-value, not just at the start", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><image href="x https://evil.example/y" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects a url(...) reference whose entity encoding changes it after decoding, even though it still starts with '#' either way (no legitimate reason to entity-encode a same-document url(...) reference)", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><rect style="fill:url(#&#x2f;&#x2f;evil.example)" width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects a fragment containing a CDATA section (scanDocument silently skips it, which would let a <script> string ride through unexamined)", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><text x="0" y="0"><![CDATA[<script>alert(1)</script>]]></text></g>', "element"),
    ).toThrow(CoMotionError);
  });

  it("rejects a fragment containing an HTML/XML comment for the same reason", () => {
    expect(() =>
      sanitizeClipboardMarkup('<g id="el-a"><!--<script>alert(1)</script>--><rect width="1" height="1"/></g>', "element"),
    ).toThrow(CoMotionError);
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

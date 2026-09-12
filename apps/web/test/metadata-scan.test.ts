import { describe, expect, it } from "vitest";
import { readSlideComments, scanDocument } from "../src/metadata-scan.js";

/**
 * F8: the web bundle's own byte-offset scanner, replacing core's
 * `scanDocument`/`readSlideComments` (core's slide/comments.ts). `notes.ts`'s
 * own `readSlideNotes` is already covered by `notes.test.ts` — these two
 * tests cover both an `xmlns:slidra`-bound and an unbound (legacy) file
 * reading the same way, the whole reason a byte-offset scanner was kept
 * instead of switching to `DOMParser` for this one reader (see this
 * module's own doc comment).
 */

describe("scanDocument / readSlideComments (F8)", () => {
  it("with an xmlns:slidra binding: reads out <slidra:comment>", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><slidra:comments xmlns:slidra="https://slidra.app/ns/2026">' +
      '<slidra:comment id="c1" target="page" author="Ada" created="2026-01-01T00:00:00Z">First comment</slidra:comment>' +
      "</slidra:comments></metadata>" +
      "</svg>";
    expect(readSlideComments(svg)).toEqual([
      { id: "c1", target: "page", author: "Ada", created: "2026-01-01T00:00:00Z", text: "First comment" },
    ]);
  });

  it("an old file with no xmlns:slidra binding: DOMParser treats it as malformed, but scanDocument's byte-offset scan reads out <slidra:comment> anyway", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      "<metadata><slidra:comments>" +
      '<slidra:comment id="c1" target="el-a" author="Bob" created="2025-06-01T00:00:00Z">Legacy comment, no bound namespace</slidra:comment>' +
      "</slidra:comments></metadata>" +
      "</svg>";
    // Sanity check on the premise: DOMParser really does reject this.
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("parsererror").length).toBeGreaterThan(0);

    expect(readSlideComments(svg)).toEqual([
      { id: "c1", target: "el-a", author: "Bob", created: "2025-06-01T00:00:00Z", text: "Legacy comment, no bound namespace" },
    ]);
  });

  it("scanDocument itself: a non-self-closing element with an attribute has correct offsets and attribute reads", () => {
    const svg = '<svg viewBox="0 0 1 1"><g id="el-a">x</g></svg>';
    const roots = scanDocument(svg);
    expect(roots).toHaveLength(1);
    const g = roots[0].children[0];
    expect(g.tag).toBe("g");
    const idStart = svg.indexOf('id="');
    const idEnd = svg.indexOf('"', idStart + 'id="'.length) + 1;
    expect(g.attributes).toEqual([{ name: "id", value: "el-a", start: idStart, end: idEnd }]);
  });
});

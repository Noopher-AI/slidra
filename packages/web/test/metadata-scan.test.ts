import { describe, expect, it } from "vitest";
import { readSlideComments, scanDocument } from "../src/metadata-scan.js";

/**
 * F8 (NOOP-289 決定 M1): the web bundle's own byte-offset scanner,
 * replacing core's `scanDocument`/`readSlideComments`
 * (core's slide/comments.ts). `notes.ts`'s own `readSlideNotes` is already
 * covered by `notes.test.ts` — these two tests are the ones the plan asks
 * for: both an `xmlns:comot`-bound and an unbound (legacy) file read the
 * same way, the whole reason a byte-offset scanner was kept instead of
 * switching to `DOMParser` for this one reader (see this module's own doc
 * comment).
 */

describe("scanDocument / readSlideComments（F8, NOOP-289 決定 M1）", () => {
  it("有 xmlns:comot 繫結：讀得出 <comot:comment>", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      '<metadata><comot:comments xmlns:comot="https://co-motion.dev/ns">' +
      '<comot:comment id="c1" target="page" author="Ada" created="2026-01-01T00:00:00Z">第一則留言</comot:comment>' +
      "</comot:comments></metadata>" +
      "</svg>";
    expect(readSlideComments(svg)).toEqual([
      { id: "c1", target: "page", author: "Ada", created: "2026-01-01T00:00:00Z", text: "第一則留言" },
    ]);
  });

  it("舊檔沒有 xmlns:comot 繫結：DOMParser 會判定損毀，但 scanDocument 是逐位元組掃描，一樣讀得出 <comot:comment>", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
      "<metadata><comot:comments>" +
      '<comot:comment id="c1" target="el-a" author="Bob" created="2025-06-01T00:00:00Z">舊版留言，沒有繫結命名空間</comot:comment>' +
      "</comot:comments></metadata>" +
      "</svg>";
    // Sanity check on the premise: DOMParser really does reject this.
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("parsererror").length).toBeGreaterThan(0);

    expect(readSlideComments(svg)).toEqual([
      { id: "c1", target: "el-a", author: "Bob", created: "2025-06-01T00:00:00Z", text: "舊版留言，沒有繫結命名空間" },
    ]);
  });

  it("scanDocument 本身：一個帶屬性、無自我封閉的元素，offsets 與屬性讀取正確", () => {
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

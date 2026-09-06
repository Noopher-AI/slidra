import { describe, expect, it } from "vitest";
import { CoMotionNotFoundError } from "../src/errors.js";
import {
  addSlideComment,
  deleteSlideComment,
  editSlideComment,
  readSlideComments,
  type SlideComment,
} from "../src/slide/comments.js";
import { deleteElements } from "../src/element-edit.js";
import { mintElementIds } from "../src/slide-ops.js";

/**
 * [E2.T8] AC10/AC11/AC12: the `<comot:comments>` splice model, the dangling
 * cleanup `element delete` applies to it, and the id/target remap
 * `slide duplicate`'s `mintElementIds` applies to it. Expectations are
 * either hand-written literal strings or the exact input a splice must
 * leave untouched — never the function's own output re-asserted back at
 * itself.
 */

function slide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">${inner}</svg>`;
}

const NS = `xmlns:comot="https://co-motion.dev/ns"`;

const comment: SlideComment = {
  id: "c-aaaaaaaaaaaa",
  target: "el-target1234",
  author: "author",
  created: "2026-09-06T05:40:11.204Z",
  text: "把這個標題改短一點",
};

describe("readSlideComments", () => {
  it("no <metadata> at all reads as []", () => {
    expect(readSlideComments(slide('<g id="el-a"><rect/></g>'))).toEqual([]);
  });

  it("<metadata> present but no <comot:comments> reads as []", () => {
    expect(readSlideComments(slide("<metadata><comot:notes>hi</comot:notes></metadata>"))).toEqual([]);
  });

  it("an empty <comot:comments> reads as []", () => {
    expect(readSlideComments(slide(`<metadata><comot:comments ${NS}></comot:comments></metadata>`))).toEqual([]);
  });

  it("reads multiple comments back in document order, escapes decoded", () => {
    const svg = slide(
      `<metadata><comot:comments ${NS}>` +
        `<comot:comment id="c-1" target="page" author="agent" created="2026-01-01T00:00:00.000Z">整頁 &amp; 重寫</comot:comment>` +
        `<comot:comment id="c-2" target="el-x" author="author" created="2026-01-02T00:00:00.000Z">&lt;標題&gt;</comot:comment>` +
        `</comot:comments></metadata>`,
    );
    expect(readSlideComments(svg)).toEqual([
      { id: "c-1", target: "page", author: "agent", created: "2026-01-01T00:00:00.000Z", text: "整頁 & 重寫" },
      { id: "c-2", target: "el-x", author: "author", created: "2026-01-02T00:00:00.000Z", text: "<標題>" },
    ]);
  });
});

describe("addSlideComment", () => {
  it("creates <metadata> and <comot:comments> when both are missing, other bytes untouched", () => {
    const svg = slide('<g id="el-a"><rect/></g>');
    const result = addSlideComment(svg, comment);
    expect(result).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">` +
        `<metadata><comot:comments ${NS}>` +
        `<comot:comment id="c-aaaaaaaaaaaa" target="el-target1234" author="author" created="2026-09-06T05:40:11.204Z">把這個標題改短一點</comot:comment>` +
        `</comot:comments></metadata>` +
        `<g id="el-a"><rect/></g></svg>`,
    );
  });

  it("appends to an existing <comot:comments>, leaving the first comment and every other byte identical", () => {
    const first = `<comot:comment id="c-first" target="page" author="agent" created="2026-01-01T00:00:00.000Z">第一則</comot:comment>`;
    const svg = slide(`<metadata><comot:comments ${NS}>${first}</comot:comments></metadata><g id="el-a"><rect/></g>`);
    const result = addSlideComment(svg, comment);
    expect(result).toBe(
      slide(
        `<metadata><comot:comments ${NS}>${first}` +
          `<comot:comment id="c-aaaaaaaaaaaa" target="el-target1234" author="author" created="2026-09-06T05:40:11.204Z">把這個標題改短一點</comot:comment>` +
          `</comot:comments></metadata><g id="el-a"><rect/></g>`,
      ),
    );
  });

  it("rewrites the open tag to add a missing xmlns:comot, preserving prior content", () => {
    const svg = slide(`<metadata><comot:comments><comot:comment id="c-old" target="page" author="agent" created="x">舊</comot:comment></comot:comments></metadata>`);
    const result = addSlideComment(svg, comment);
    expect(result).toBe(
      slide(
        `<metadata><comot:comments ${NS}><comot:comment id="c-old" target="page" author="agent" created="x">舊</comot:comment>` +
          `<comot:comment id="c-aaaaaaaaaaaa" target="el-target1234" author="author" created="2026-09-06T05:40:11.204Z">把這個標題改短一點</comot:comment>` +
          `</comot:comments></metadata>`,
      ),
    );
  });

  it("escapes &, <, > in the comment text", () => {
    const svg = slide('<g id="el-a"><rect/></g>');
    const result = addSlideComment(svg, { ...comment, text: "A & B < C > D" });
    expect(result).toContain(">A &amp; B &lt; C &gt; D<");
  });
});

describe("editSlideComment", () => {
  it("replaces only the target comment's content, round-trips a newline verbatim", () => {
    const svg = slide(
      `<metadata><comot:comments ${NS}>` +
        `<comot:comment id="c-1" target="page" author="agent" created="t1">舊內容</comot:comment>` +
        `<comot:comment id="c-2" target="el-b" author="agent" created="t2">不動</comot:comment>` +
        `</comot:comments></metadata>`,
    );
    const result = editSlideComment(svg, "c-1", "新內容\n第二行");
    expect(result).toBe(
      slide(
        `<metadata><comot:comments ${NS}>` +
          `<comot:comment id="c-1" target="page" author="agent" created="t1">新內容\n第二行</comot:comment>` +
          `<comot:comment id="c-2" target="el-b" author="agent" created="t2">不動</comot:comment>` +
          `</comot:comments></metadata>`,
      ),
    );
  });

  it("throws CoMotionNotFoundError for an unknown comment id", () => {
    const svg = slide(`<metadata><comot:comments ${NS}></comot:comments></metadata>`);
    expect(() => editSlideComment(svg, "c-missing", "x")).toThrow(CoMotionNotFoundError);
  });
});

describe("deleteSlideComment", () => {
  it("removes the comment, leaves an empty <comot:comments> behind when it was the last one", () => {
    const svg = slide(`<metadata><comot:comments ${NS}><comot:comment id="c-1" target="page" author="agent" created="t1">x</comot:comment></comot:comments></metadata>`);
    const result = deleteSlideComment(svg, "c-1");
    expect(result).toBe(slide(`<metadata><comot:comments ${NS}></comot:comments></metadata>`));
  });

  it("removes only the named comment, leaving siblings byte-identical", () => {
    const kept = `<comot:comment id="c-2" target="el-b" author="agent" created="t2">留下</comot:comment>`;
    const svg = slide(
      `<metadata><comot:comments ${NS}><comot:comment id="c-1" target="page" author="agent" created="t1">刪掉</comot:comment>${kept}</comot:comments></metadata>`,
    );
    const result = deleteSlideComment(svg, "c-1");
    expect(result).toBe(slide(`<metadata><comot:comments ${NS}>${kept}</comot:comments></metadata>`));
  });

  it("throws CoMotionNotFoundError for an unknown comment id", () => {
    const svg = slide(`<metadata><comot:comments ${NS}></comot:comments></metadata>`);
    expect(() => deleteSlideComment(svg, "c-missing")).toThrow(CoMotionNotFoundError);
  });
});

describe("element delete cleans up dangling comment references (AC11)", () => {
  it("removes comments targeting a deleted element and its descendants, keeps comments on other elements and 'page'", () => {
    const svg = slide(
      `<metadata><comot:comments ${NS}>` +
        `<comot:comment id="c-1" target="el-a" author="agent" created="t1">指向被刪的 el-a</comot:comment>` +
        `<comot:comment id="c-2" target="el-inner" author="agent" created="t2">指向 el-a 的後代</comot:comment>` +
        `<comot:comment id="c-3" target="el-b" author="agent" created="t3">指向沒被刪的 el-b</comot:comment>` +
        `<comot:comment id="c-4" target="page" author="agent" created="t4">整頁留言</comot:comment>` +
        `</comot:comments></metadata>` +
        `<g id="el-a"><g id="el-inner"><rect/></g></g>` +
        `<g id="el-b"><rect/></g>`,
    );
    const result = deleteElements(svg, "slides/001.svg", ["el-a"]);
    expect(result).not.toContain("c-1");
    expect(result).not.toContain("c-2");
    expect(result).toContain('id="c-3"');
    expect(result).toContain('id="c-4"');
    expect(result).not.toContain('id="el-a"');
  });
});

describe("slide duplicate's id remap covers comments (AC12)", () => {
  it("a comment targeting a re-minted element: target follows the remap, id is freshly minted", () => {
    const svg = slide(
      `<metadata><comot:comments ${NS}><comot:comment id="c-old" target="el-old" author="agent" created="t1">x</comot:comment></comot:comments></metadata>` +
        `<g id="el-old"><rect/></g>`,
    );
    let elementCalls = 0;
    let commentCalls = 0;
    const result = mintElementIds(
      svg,
      () => `el-new-${elementCalls++}`,
      () => `c-new-${commentCalls++}`,
    );
    expect(result).toContain('target="el-new-0"');
    expect(result).toContain('id="c-new-0"');
    expect(result).not.toContain("el-old");
    expect(result).not.toContain("c-old");
  });

  it("a page-level comment: target='page' is left alone, id is still freshly minted", () => {
    const svg = slide(
      `<metadata><comot:comments ${NS}><comot:comment id="c-old" target="page" author="agent" created="t1">x</comot:comment></comot:comments></metadata>` +
        `<g id="el-old"><rect/></g>`,
    );
    const result = mintElementIds(svg, () => "el-new", () => "c-new");
    expect(result).toContain('target="page"');
    expect(result).toContain('id="c-new"');
    expect(result).not.toContain("c-old");
  });

  it("a slide with no comments: byte-identical apart from the element id (no regression on the existing behaviour)", () => {
    const svg = slide('<g id="el-old"><rect/></g>');
    const result = mintElementIds(svg, () => "el-new");
    expect(result).toBe(slide('<g id="el-new"><rect/></g>'));
  });
});

// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDeckComments, sortComments, type SlideCommentWithPath } from "../src/comments.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SLIDES = ["slides/001.svg", "slides/002.svg"];

function comment(overrides: Partial<SlideCommentWithPath>): SlideCommentWithPath {
  return { id: "c-x", slidePath: "slides/001.svg", target: "page", author: "author", created: "t", text: "x", ...overrides };
}

describe("sortComments", () => {
  it("orders by slide index first — a later slide's comment always comes after an earlier slide's", () => {
    const result = sortComments(
      [comment({ id: "c-2", slidePath: "slides/002.svg" }), comment({ id: "c-1", slidePath: "slides/001.svg" })],
      SLIDES,
    );
    expect(result.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(result.map((c) => c.number)).toEqual([1, 2]);
  });

  it("within one slide, a page-level comment sorts before an element-level one regardless of document order", () => {
    const result = sortComments(
      [
        comment({ id: "c-el", slidePath: "slides/001.svg", target: "el-a" }),
        comment({ id: "c-page", slidePath: "slides/001.svg", target: "page" }),
      ],
      SLIDES,
    );
    expect(result.map((c) => c.id)).toEqual(["c-page", "c-el"]);
  });

  it("preserves document order for two element-level comments on the same slide", () => {
    const result = sortComments(
      [
        comment({ id: "c-first", slidePath: "slides/001.svg", target: "el-a" }),
        comment({ id: "c-second", slidePath: "slides/001.svg", target: "el-b" }),
      ],
      SLIDES,
    );
    expect(result.map((c) => c.id)).toEqual(["c-first", "c-second"]);
  });

  it("assigns 1-based numbers across the whole deck", () => {
    const result = sortComments(
      [comment({ id: "c-1" }), comment({ id: "c-2" }), comment({ id: "c-3" })],
      SLIDES,
    );
    expect(result.map((c) => c.number)).toEqual([1, 2, 3]);
  });
});

describe("fetchDeckComments", () => {
  it("reads every slide's comments in slides order, attaching slidePath", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/raw/slides/001.svg") {
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg"><metadata><slidra:comments xmlns:slidra="https://slidra.app/ns/2026"><slidra:comment id="c-1" target="page" author="agent" created="t1">First page</slidra:comment></slidra:comments></metadata></svg>',
            { status: 200 },
          );
        }
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 });
      }),
    );

    const result = await fetchDeckComments(SLIDES);
    expect(result.errors).toEqual([]);
    expect(result.comments).toEqual([
      { id: "c-1", slidePath: "slides/001.svg", target: "page", author: "agent", created: "t1", text: "First page" },
    ]);
  });

  it("a non-200 response contributes an error, not a false 'no comments' for that slide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const result = await fetchDeckComments(["slides/001.svg"]);
    expect(result.comments).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("slides/001.svg");
  });

  it("a network failure (fetch rejects) contributes an error for that slide, doesn't abort the rest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/raw/slides/001.svg") throw new Error("network down");
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 });
      }),
    );

    const result = await fetchDeckComments(SLIDES);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("slides/001.svg");
    expect(result.comments).toEqual([]); // slides/002.svg still read, but has no comments
  });

  it("markup that fails to parse as a slide contributes an error, not a silent empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not xml at all {{{", { status: 200 })));

    const result = await fetchDeckComments(["slides/001.svg"]);
    expect(result.comments).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});

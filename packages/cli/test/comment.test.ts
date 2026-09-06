import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import { parseArgv } from "../src/argv.js";
import type { CommandRegistry } from "../src/registry.js";
import { CoMotionError } from "@co-motion/core";

/** [E2.T8] AC8: `comment add / edit / delete / list` — argv parsing plus the registered handlers, round-tripped through a real presentation. */

let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  process.env.CO_MOTION_HOME = coMotionHome;
  registry = createDefaultRegistry();
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(comotDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * `co-motion new`'s default `slides/001.svg` carries a bare, unwrapped
 * `<text>` title — genuinely non-`assertSlideCompliant` until `convert`
 * runs (unrelated pre-existing state, confirmed by running this suite
 * against it first: `comment add` failed every case with "裸圖元" before
 * ever reaching its own target-existence check). `comment add`/`edit`
 * check compliance up front (§4.5 of the plan, "與其他寫入命令一致"), so
 * every test here targets a blank `slide add` slide instead — empty, and
 * therefore compliant from the start.
 */
async function openFreshPresentation(): Promise<{ id: string; slidePath: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const added = await registry.dispatch<{ slidePath: string }>("slide add", { id });
  return { id, slidePath: added.data!.slidePath };
}

/** A real, addressable `<g>`-wrapped element on `slidePath`. */
async function addRealElement(id: string, slidePath: string): Promise<string> {
  const result = await registry.dispatch<{ elementId: string }>("textbox add", {
    id,
    slidePath,
    x: 100,
    y: 100,
    width: 200,
    text: "box",
  });
  return result.data!.elementId;
}

describe("parseArgv comment", () => {
  it("comment add: parses the four positionals plus optional --author", () => {
    const parsed = parseArgv(["comment", "add", "abc", "slides/001.svg", "el-x", "留言內容", "--author", "agent"]);
    expect(parsed.input).toEqual({ id: "abc", slidePath: "slides/001.svg", target: "el-x", text: "留言內容", author: "agent" });
  });

  it("comment add: --author is undefined when omitted", () => {
    const parsed = parseArgv(["comment", "add", "abc", "slides/001.svg", "page", "文字"]);
    expect(parsed.input).toEqual({ id: "abc", slidePath: "slides/001.svg", target: "page", text: "文字", author: undefined });
  });

  it("comment add: missing text reports the missing positional, not a flag string", () => {
    expect(() => parseArgv(["comment", "add", "abc", "slides/001.svg", "page"])).toThrow(CoMotionError);
  });

  it("comment edit: parses four positionals", () => {
    const parsed = parseArgv(["comment", "edit", "abc", "slides/001.svg", "c-1", "新文字"]);
    expect(parsed.input).toEqual({ id: "abc", slidePath: "slides/001.svg", commentId: "c-1", text: "新文字" });
  });

  it("comment delete: parses three positionals", () => {
    const parsed = parseArgv(["comment", "delete", "abc", "slides/001.svg", "c-1"]);
    expect(parsed.input).toEqual({ id: "abc", slidePath: "slides/001.svg", commentId: "c-1" });
  });

  it("comment list: slide-path omitted reads as undefined (deck-wide)", () => {
    const parsed = parseArgv(["comment", "list", "abc"]);
    expect(parsed.input).toEqual({ id: "abc", slidePath: undefined });
  });

  it("comment list: slide-path given is parsed", () => {
    const parsed = parseArgv(["comment", "list", "abc", "slides/001.svg"]);
    expect(parsed.input).toEqual({ id: "abc", slidePath: "slides/001.svg" });
  });

  it("unknown sub-command reports it by name", () => {
    expect(() => parseArgv(["comment", "bogus", "abc"])).toThrow(CoMotionError);
  });
});

describe("comment add", () => {
  it("target='page' succeeds and round-trips through comment list", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const added = await registry.dispatch<{ commentId: string }>("comment add", {
      id,
      slidePath,
      target: "page",
      text: "整頁重寫成三個要點",
    });
    expect(added.ok).toBe(true);
    const listed = await registry.dispatch<{ comments: unknown[] }>("comment list", { id, slidePath });
    expect(listed.data!.comments).toEqual([
      expect.objectContaining({ id: added.data!.commentId, target: "page", author: "agent", text: "整頁重寫成三個要點" }),
    ]);
  });

  it("target=a real element id succeeds", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const elementId = await addRealElement(id, slidePath);
    const added = await registry.dispatch<{ commentId: string }>("comment add", {
      id,
      slidePath,
      target: elementId,
      text: "把這個標題改短一點",
    });
    expect(added.ok).toBe(true);
  });

  it("target=an element id that doesn't exist on the slide is rejected, nothing written", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const before = (await registry.dispatch<{ content: string }>("cat", { id, path: slidePath })).data!.content;
    const result = await registry.dispatch("comment add", {
      id,
      slidePath,
      target: "el-does-not-exist",
      text: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("沒有元素 el-does-not-exist");
    const after = (await registry.dispatch<{ content: string }>("cat", { id, path: slidePath })).data!.content;
    expect(after).toBe(before);
  });

  it("a slide-path outside project.json's slides is rejected", async () => {
    const { id } = await openFreshPresentation();
    const result = await registry.dispatch("comment add", { id, slidePath: "slides/does-not-exist.svg", target: "page", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不是投影片");
  });

  it("empty text (after trim) is rejected", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const result = await registry.dispatch("comment add", { id, slidePath, target: "page", text: "   " });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("留言內容不可為空");
  });

  it("an empty --author is rejected", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const result = await registry.dispatch("comment add", { id, slidePath, target: "page", text: "x", author: "" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("author 不可為空");
  });
});

describe("comment edit", () => {
  it("replaces the text, leaves created untouched", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const added = await registry.dispatch<{ commentId: string }>("comment add", { id, slidePath, target: "page", text: "舊文字" });
    const before = (await registry.dispatch<{ comments: { created: string }[] }>("comment list", { id })).data!.comments[0];

    const edited = await registry.dispatch("comment edit", { id, slidePath, commentId: added.data!.commentId, text: "新文字" });
    expect(edited.ok).toBe(true);

    const after = (await registry.dispatch<{ comments: { text: string; created: string }[] }>("comment list", { id })).data!.comments[0];
    expect(after.text).toBe("新文字");
    expect(after.created).toBe(before.created);
  });

  it("an unknown comment-id fails with failureKind not-found", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const result = await registry.dispatch("comment edit", { id, slidePath, commentId: "c-missing", text: "x" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });
});

describe("comment delete", () => {
  it("removes the comment", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const added = await registry.dispatch<{ commentId: string }>("comment add", { id, slidePath, target: "page", text: "x" });
    const deleted = await registry.dispatch("comment delete", { id, slidePath, commentId: added.data!.commentId });
    expect(deleted.ok).toBe(true);
    const listed = await registry.dispatch<{ comments: unknown[] }>("comment list", { id, slidePath });
    expect(listed.data!.comments).toEqual([]);
  });

  it("an unknown comment-id fails with failureKind not-found", async () => {
    const { id, slidePath } = await openFreshPresentation();
    const result = await registry.dispatch("comment delete", { id, slidePath, commentId: "c-missing" });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });
});

describe("comment list", () => {
  it("no slide-path lists every slide's comments, deck-wide, in project.json's slides order", async () => {
    const { id, slidePath: firstSlide } = await openFreshPresentation();
    const secondAdded = await registry.dispatch<{ slidePath: string }>("slide add", { id });
    const secondSlide = secondAdded.data!.slidePath;

    await registry.dispatch("comment add", { id, slidePath: firstSlide, target: "page", text: "第一頁留言" });
    await registry.dispatch("comment add", { id, slidePath: secondSlide, target: "page", text: "第二頁留言" });

    const listed = await registry.dispatch<{ comments: { slidePath: string; text: string }[] }>("comment list", { id });
    expect(listed.data!.comments.map((c) => [c.slidePath, c.text])).toEqual([
      [firstSlide, "第一頁留言"],
      [secondSlide, "第二頁留言"],
    ]);
  });
});

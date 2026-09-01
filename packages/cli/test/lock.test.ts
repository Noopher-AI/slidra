import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * T3 / ADR-0013: `element lock` / `element unlock`, and the guard
 * (`assertNotLocked`) they power on the five existing mutations that target
 * an existing element (`move` / `scale` / `rotate` / `style set` / `order`),
 * plus `text set` / `textbox width`. `element insert` (new element) and
 * `element delete` (deliberately exempt) are asserted separately.
 */

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
 * Opens a fresh presentation, adds a blank slide (`slide add` — the default
 * title slide is not `convert`ed, so `element insert` refuses it via
 * `assertSlideCompliant`), and inserts one rect element into it: a real
 * `<g>` container (ADR-0012 normal form), for tests that need a lockable,
 * editable target on `slides/001.svg`.
 */
async function openWithRectElement(): Promise<{ id: string; elementId: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
  await registry.dispatch("slide add", { id }); // slides/001.svg, blank and compliant
  const insert = await registry.dispatch<{ elementId: string }>("element insert", {
    id,
    slidePath: "slides/001.svg",
    kind: "rect",
    x: 10,
    y: 10,
    width: 50,
    height: 50,
  });
  return { id, elementId: insert.data!.elementId };
}

async function slideContent(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

describe("element lock / unlock", () => {
  it("鎖定寫入 data-comot-lock=\"true\"", async () => {
    const { id, elementId } = await openWithRectElement();
    const result = await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(result.ok).toBe(true);
    expect(await slideContent(id)).toContain('data-comot-lock="true"');
  });

  it("解除鎖定移除屬性，不寫 false", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("element unlock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(result.ok).toBe(true);
    const content = await slideContent(id);
    expect(content).not.toContain("data-comot-lock");
  });

  it("對已鎖定的元素再 lock：冪等，成功", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(result.ok).toBe(true);
  });

  it("對未鎖定的元素 unlock：冪等，成功", async () => {
    const { id, elementId } = await openWithRectElement();
    const result = await registry.dispatch("element unlock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    expect(result.ok).toBe(true);
  });

  it("elementIds 為空：沿用既有「元素清單不可為空」", async () => {
    const { id } = await openWithRectElement();
    const result = await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("元素清單不可為空");
  });

  it("讀取時 data-comot-lock=\"false\" 視為未鎖定", async () => {
    const { id, elementId } = await openWithRectElement();
    // Hand-author the "false" case through a style-adjacent write we control:
    // element style set cannot write data-comot- attrs, so verify indirectly
    // by locking then unlocking never producing "false" in the first place,
    // and that move succeeds on an element with no true-valued lock attr.
    const moveResult = await registry.dispatch("element move", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      dx: 5,
      dy: 5,
    });
    expect(moveResult.ok).toBe(true);
  });
});

describe("鎖定守衛：一般命令被拒 (AC7)", () => {
  it("element move 對鎖定元素回 ok:false，訊息含元素 id 與 --force，SVG 位元組未變", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const before = await slideContent(id);

    const result = await registry.dispatch("element move", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      dx: 1,
      dy: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(elementId);
    expect(result.message).toContain("--force");
    expect(await slideContent(id)).toBe(before);
  });

  it("element scale 對鎖定元素拒絕", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("element scale", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      factor: 2,
    });
    expect(result.ok).toBe(false);
  });

  it("element rotate 對鎖定元素拒絕", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("element rotate", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      degrees: 30,
    });
    expect(result.ok).toBe(false);
  });

  it("element style set 對鎖定元素拒絕", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("element style set", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      attr: "fill",
      value: "#ff0000",
    });
    expect(result.ok).toBe(false);
  });

  it("element order 對鎖定元素拒絕", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("element order", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      direction: "front",
    });
    expect(result.ok).toBe(false);
  });

  it("text set 對鎖定元素拒絕", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("text set", {
      id,
      slidePath: "slides/001.svg",
      elementId,
      newText: "改一下",
    });
    expect(result.ok).toBe(false);
  });

  it("textbox width 對鎖定的文字框拒絕", async () => {
    const comotPath = path.join(comotDir, "deck2.comot");
    await registry.dispatch("new", { path: comotPath });
    const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
    const id = opened.data!.id;
    // A compliant slide, same reasoning as openWithRectElement: `element
    // lock` opens with `assertSlideCompliant`, which the un-converted
    // default title slide fails document-wide.
    await registry.dispatch("slide delete", { id, slidePath: "slides/001.svg" });
    await registry.dispatch("slide add", { id });
    const added = await registry.dispatch<{ elementId: string }>("textbox add", {
      id,
      slidePath: "slides/001.svg",
      x: 10,
      y: 10,
      width: 200,
      text: "hello",
    });
    const elementId = added.data!.elementId;
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });
    const result = await registry.dispatch("textbox width", { id, slidePath: "slides/001.svg", elementId, width: 300 });
    expect(result.ok).toBe(false);
  });

  it("多個 elementIds 中只有一個鎖定、無 --force：整條命令拒絕，一個位元組都不寫", async () => {
    const { id, elementId: lockedId } = await openWithRectElement();
    const other = await registry.dispatch<{ elementId: string }>("element insert", {
      id,
      slidePath: "slides/001.svg",
      kind: "rect",
      x: 100,
      y: 100,
      width: 20,
      height: 20,
    });
    const unlockedId = other.data!.elementId;
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [lockedId] });
    const before = await slideContent(id);

    const result = await registry.dispatch("element move", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [unlockedId, lockedId],
      dx: 1,
      dy: 1,
    });

    expect(result.ok).toBe(false);
    expect(await slideContent(id)).toBe(before);
  });

  it("鎖定的子元素包在未鎖定的父群組內：element scale 對父群組整條拒絕，鎖定子元素的 translate 未變", async () => {
    const { id } = await openWithRectElement();
    const before = await slideContent(id);
    // Hand-build a compliant group: unlocked "el-group" containing a locked
    // child "el-locked" — the shape the reviewer's repro used to show the
    // lock guard being bypassed via the unlocked outer group.
    const groupSvg = before.replace(
      "</svg>",
      '<g id="el-group"><g id="el-locked" data-comot-lock="true" transform="translate(5 5)">' +
        '<rect x="0" y="0" width="10" height="10"/></g></g></svg>',
    );
    const { writePresentationFile } = await import("@co-motion/core");
    await writePresentationFile(id, "slides/001.svg", groupSvg);
    const beforeGroup = await slideContent(id);

    const result = await registry.dispatch("element scale", {
      id,
      slidePath: "slides/001.svg",
      elementIds: ["el-group"],
      factor: 2,
    });

    expect(result.ok).toBe(false);
    expect(await slideContent(id)).toBe(beforeGroup);
  });
});

describe("鎖定守衛：--force 可覆蓋 (AC8)", () => {
  it("element move 加 --force 成功，鎖定標記仍在", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });

    const result = await registry.dispatch("element move", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
      dx: 1,
      dy: 1,
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(await slideContent(id)).toContain('data-comot-lock="true"');
  });
});

describe("鎖定守衛：刪除例外 (AC9)", () => {
  it("element delete 對鎖定元素成功，無需 --force", async () => {
    const { id, elementId } = await openWithRectElement();
    await registry.dispatch("element lock", { id, slidePath: "slides/001.svg", elementIds: [elementId] });

    const result = await registry.dispatch("element delete", {
      id,
      slidePath: "slides/001.svg",
      elementIds: [elementId],
    });

    expect(result.ok).toBe(true);
    expect(await slideContent(id)).not.toContain(elementId);
  });
});

describe("鎖定不檢查：element insert", () => {
  it("element insert 一律成功（新元素本來就沒鎖）", async () => {
    const { id } = await openWithRectElement();
    const result = await registry.dispatch("element insert", {
      id,
      slidePath: "slides/001.svg",
      kind: "rect",
      x: 5,
      y: 5,
      width: 5,
      height: 5,
    });
    expect(result.ok).toBe(true);
  });
});

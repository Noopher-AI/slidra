import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/commands.js";
import { parseArgv } from "../src/argv.js";
import type { CommandRegistry } from "../src/registry.js";

/**
 * `effect add / remove / move / set / list` ([E2.T7], NOOP-66/#206), driven
 * end-to-end through the CLI's own command registry — same pattern as
 * `packages/cli/test/element.test.ts`. Public boundary under test: dispatch
 * a command, read the slide bytes back through `cat`.
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

async function readSlide(id: string): Promise<string> {
  const result = await registry.dispatch<{ content: string }>("cat", { id, path: "slides/001.svg" });
  return result.data!.content;
}

async function insertRect(id: string, x: number, y: number): Promise<string> {
  const result = await registry.dispatch<{ elementId: string }>("element insert", {
    id, slidePath: "slides/001.svg", kind: "rect", x, y, width: 10, height: 10,
  });
  expect(result.ok).toBe(true);
  return result.data!.elementId;
}

/** A fresh, compliant (`<g>`-container form) presentation with two rect elements, `a` and `b`. */
async function openWithTwoRects(): Promise<{ id: string; a: string; b: string }> {
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "effect 測試" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const id = opened.data!.id;
  const converted = await registry.dispatch("convert", { id });
  expect(converted.ok).toBe(true);
  const a = await insertRect(id, 10, 10);
  const b = await insertRect(id, 100, 100);
  return { id, a, b };
}

describe("effect add", () => {
  it("在沒有效果清單的投影片新增一筆，effect list 讀得到", async () => {
    const { id, a } = await openWithTwoRects();
    const added = await registry.dispatch("effect add", {
      id, slidePath: "slides/001.svg", elementIds: [a], family: "enter", effect: "fade",
    });
    expect(added.ok).toBe(true);

    const listed = await registry.dispatch<{ effects: Array<{ target: string; family: string; effect: string }> }>(
      "effect list",
      { id, slidePath: "slides/001.svg" },
    );
    expect(listed.data!.effects).toEqual([
      expect.objectContaining({ target: a, family: "enter", effect: "fade", start: "on-click", duration: 0.6, delay: 0 }),
    ]);
  });

  it("多個 element-id：第一筆帶指定的 start，其餘一律 with-previous", async () => {
    const { id, a, b } = await openWithTwoRects();
    await registry.dispatch("effect add", {
      id, slidePath: "slides/001.svg", elementIds: [a, b], family: "enter", effect: "zoom", start: "after-previous",
    });
    const listed = await registry.dispatch<{ effects: Array<{ start: string }> }>("effect list", { id, slidePath: "slides/001.svg" });
    expect(listed.data!.effects.map((item) => item.start)).toEqual(["after-previous", "with-previous"]);
  });

  it("element-id 不存在時失敗，not-found", async () => {
    const { id, a } = await openWithTwoRects();
    const result = await registry.dispatch("effect add", {
      id, slidePath: "slides/001.svg", elementIds: [a, "el-nope"], family: "enter", effect: "fade",
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("not-found");
  });

  it("family=path 沒給 --d 時失敗", async () => {
    const { id, a } = await openWithTwoRects();
    const result = await registry.dispatch("effect add", { id, slidePath: "slides/001.svg", elementIds: [a], family: "path", effect: "path" });
    expect(result.ok).toBe(false);
  });

  it("family=path 給了 --d 時成功並保留 d", async () => {
    const { id, a } = await openWithTwoRects();
    await registry.dispatch("effect add", {
      id, slidePath: "slides/001.svg", elementIds: [a], family: "path", effect: "path", d: "M 0 0 L 50 50",
    });
    const listed = await registry.dispatch<{ effects: Array<{ d?: string }> }>("effect list", { id, slidePath: "slides/001.svg" });
    expect(listed.data!.effects[0].d).toBe("M 0 0 L 50 50");
  });

  it("undo 還原一次 effect add", async () => {
    const { id, a } = await openWithTwoRects();
    await registry.dispatch("effect add", { id, slidePath: "slides/001.svg", elementIds: [a], family: "enter", effect: "fade" });
    expect(await readSlide(id)).toContain("comot:effect");
    const undone = await registry.dispatch("undo", { id });
    expect(undone.ok).toBe(true);
    expect(await readSlide(id)).not.toContain("comot:effect");
  });
});

describe("effect remove / move / set", () => {
  async function openWithThreeEffects(): Promise<{ id: string; a: string; b: string }> {
    const { id, a, b } = await openWithTwoRects();
    await registry.dispatch("effect add", { id, slidePath: "slides/001.svg", elementIds: [a], family: "enter", effect: "fade" });
    await registry.dispatch("effect add", { id, slidePath: "slides/001.svg", elementIds: [b], family: "enter", effect: "zoom" });
    await registry.dispatch("effect add", { id, slidePath: "slides/001.svg", elementIds: [a], family: "emphasis", effect: "pulse" });
    return { id, a, b };
  }

  it("effect remove 移除單一效果項", async () => {
    const { id } = await openWithThreeEffects();
    const result = await registry.dispatch("effect remove", { id, slidePath: "slides/001.svg", indices: [2] });
    expect(result.ok).toBe(true);
    const listed = await registry.dispatch<{ effects: Array<{ effect: string }> }>("effect list", { id, slidePath: "slides/001.svg" });
    expect(listed.data!.effects.map((item) => item.effect)).toEqual(["fade", "pulse"]);
  });

  it("effect move up/down 交換相鄰效果項的順序", async () => {
    const { id } = await openWithThreeEffects();
    await registry.dispatch("effect move", { id, slidePath: "slides/001.svg", index: 2, direction: "up" });
    const listed = await registry.dispatch<{ effects: Array<{ effect: string }> }>("effect list", { id, slidePath: "slides/001.svg" });
    expect(listed.data!.effects.map((item) => item.effect)).toEqual(["zoom", "fade", "pulse"]);
  });

  it("effect set 改 duration/delay 立即生效", async () => {
    const { id } = await openWithThreeEffects();
    const result = await registry.dispatch("effect set", { id, slidePath: "slides/001.svg", index: 1, duration: 1.5, delay: 0.25 });
    expect(result.ok).toBe(true);
    const listed = await registry.dispatch<{ effects: Array<{ duration: number; delay: number }> }>("effect list", { id, slidePath: "slides/001.svg" });
    expect(listed.data!.effects[0]).toMatchObject({ duration: 1.5, delay: 0.25 });
  });

  it("effect set 沒給任何欄位時失敗", async () => {
    const { id } = await openWithThreeEffects();
    const result = await registry.dispatch("effect set", { id, slidePath: "slides/001.svg", index: 1 });
    expect(result.ok).toBe(false);
  });

  it("element delete 清掉懸空效果項", async () => {
    const { id, a, b } = await openWithThreeEffects();
    await registry.dispatch("element delete", { id, slidePath: "slides/001.svg", elementIds: [a] });
    const listed = await registry.dispatch<{ effects: Array<{ target: string }> }>("effect list", { id, slidePath: "slides/001.svg" });
    expect(listed.data!.effects.map((item) => item.target)).toEqual([b]);
  });

  it("effect list 回傳的 index 直接餵給 effect set 改到同一筆，不是前一筆（round-trip）", async () => {
    const { id } = await openWithThreeEffects();
    const before = await registry.dispatch<{ effects: Array<{ index: number; target: string; effect: string }> }>(
      "effect list",
      { id, slidePath: "slides/001.svg" },
    );
    const second = before.data!.effects[1];
    expect(second.effect).toBe("zoom");

    const result = await registry.dispatch("effect set", { id, slidePath: "slides/001.svg", index: second.index, duration: 2.5 });
    expect(result.ok).toBe(true);

    const after = await registry.dispatch<{ effects: Array<{ target: string; effect: string; duration: number }> }>(
      "effect list",
      { id, slidePath: "slides/001.svg" },
    );
    expect(after.data!.effects[0]).toMatchObject({ effect: "fade", duration: 0.6 });
    expect(after.data!.effects[1]).toMatchObject({ target: second.target, effect: "zoom", duration: 2.5 });
    expect(after.data!.effects[2]).toMatchObject({ effect: "pulse", duration: 0.6 });
  });
});

describe("effect list on a slide with no effect list", () => {
  it("失敗且訊息說明沒有效果清單", async () => {
    const { id } = await openWithTwoRects();
    const result = await registry.dispatch("effect list", { id, slidePath: "slides/001.svg" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/沒有效果清單/);
  });
});

describe("argv: effect", () => {
  it("effect add 解析 family/effect/start/duration/delay/d/index", () => {
    const parsed = parseArgv([
      "effect", "add", "pres-1", "slides/001.svg", "el-a,el-b",
      "--family", "path", "--effect", "path", "--start", "after-previous",
      "--duration", "1.2", "--delay", "0.3", "--d", "M 0 0", "--index", "2",
    ]);
    expect(parsed).toEqual({
      name: "effect add",
      input: {
        id: "pres-1", slidePath: "slides/001.svg", elementIds: ["el-a", "el-b"],
        family: "path", effect: "path", start: "after-previous", duration: 1.2, delay: 0.3, d: "M 0 0", index: 2,
      },
    });
  });

  it("effect remove 解析逗號分隔的 index 清單", () => {
    const parsed = parseArgv(["effect", "remove", "pres-1", "slides/001.svg", "1,3,2"]);
    expect(parsed).toEqual({ name: "effect remove", input: { id: "pres-1", slidePath: "slides/001.svg", indices: [1, 3, 2] } });
  });

  it("effect move 解析 index 與方向", () => {
    const parsed = parseArgv(["effect", "move", "pres-1", "slides/001.svg", "2", "up"]);
    expect(parsed).toEqual({ name: "effect move", input: { id: "pres-1", slidePath: "slides/001.svg", index: 2, direction: "up" } });
  });

  it("effect move 不支援的方向時拋錯", () => {
    expect(() => parseArgv(["effect", "move", "pres-1", "slides/001.svg", "2", "sideways"])).toThrow(/不支援的方向/);
  });

  it("effect set 至少給一個欄位（argv 層不驗證，交給 core）", () => {
    const parsed = parseArgv(["effect", "set", "pres-1", "slides/001.svg", "1", "--duration", "0.5"]);
    expect(parsed).toEqual({ name: "effect set", input: { id: "pres-1", slidePath: "slides/001.svg", index: 1, effect: undefined, start: undefined, duration: 0.5, delay: undefined, d: undefined } });
  });

  it("未知子命令拋錯", () => {
    expect(() => parseArgv(["effect", "nope"])).toThrow(/未知的子命令：effect nope/);
  });
});

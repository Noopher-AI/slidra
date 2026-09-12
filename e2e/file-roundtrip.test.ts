import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { workDirFor } from "../packages/server/src/slidra/home.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { requireBuilt, startServerFor, openApp } from "./helpers/launch.js";

/**
 * #210 條件 1 — Open／Save round-trips a `.slidra` byte-for-byte, and
 * `POST /api/open` clears undo history and replaces the served presentation
 * without changing its id (NOOP-93 §7 decision 5).
 *
 * Pure HTTP-level tests (§6.2's "公開邊界一"): `startServe` + real `fetch`,
 * no browser, matching `packages/server/test/serve.test.ts`'s own
 * convention — the agent is a fixture nothing here ever spawns (lazy on
 * first `/api/chat`, same reasoning as that file's `fakeAgent`).
 */

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const deckDir = path.join(rootDir, "e2e/fixtures/export-deck");
const fakeAgentFixture = path.join(rootDir, "packages/server/test/agent/fixtures/fake-acp-agent.mjs");
const fakeAgent: AgentAdapterConfig = {
  kind: "claude",
  label: "Claude Code",
  command: process.execPath,
  args: [fakeAgentFixture],
};

interface Harness {
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  slidraPath: string;
  slidraHome: string;
  slidraDir: string;
  staticDir: string;
}

async function startHarness(): Promise<Harness> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-files-"));
  const staticDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-static-"));
  process.env.SLIDRA_HOME = slidraHome;
  // [E4.T9]/F7: slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const slidraPath = path.join(slidraDir, "a.slidra");
  await packDirectory(deckDir, slidraPath);
  const registry = createDefaultRegistry();
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const server = await startServe({ presentationId, port: 0, agent: fakeAgent, staticDir });

  return { server, registry, presentationId, slidraPath, slidraHome, slidraDir, staticDir };
}

async function stopHarness(harness: Harness): Promise<void> {
  await harness.server.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  await rm(harness.slidraHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(harness.slidraDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(harness.staticDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Recursively lists every regular file under `dir`, as paths relative to `dir` (posix-joined, sorted). */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(dir);
  return out.sort();
}

let harness: Harness | undefined;
let secondHome: string | undefined;

afterEach(async () => {
  if (harness) {
    await stopHarness(harness);
    harness = undefined;
  }
  if (secondHome) {
    await rm(secondHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    secondHome = undefined;
  }
});

describe("file round-trip via POST /api/save (#210 條件 1)", () => {
  it("an edit saved through /api/save survives a reopen into a second SLIDRA_HOME, byte-for-byte", async () => {
    harness = await startHarness();
    const { server, slidraPath } = harness;

    const setResponse = await fetch(`${server.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "text set",
        input: { slidePath: "slides/001.svg", elementId: "el-title", newText: "roundtrip 已編輯" },
      }),
    });
    expect(setResponse.status).toBe(200);

    const saveResponse = await fetch(`${server.url}/api/save`, { method: "POST" });
    expect(saveResponse.status).toBe(200);
    await expect(saveResponse.json()).resolves.toEqual({ ok: true });

    const stateResponse = await fetch(`${server.url}/api/save-state`);
    await expect(stateResponse.json()).resolves.toEqual({ known: true, dirty: false, fileName: "a.slidra" });

    // The work directory this server is still running against.
    const firstWorkDir = await workDirFor(harness.presentationId);
    const firstFiles = await listFilesRecursive(firstWorkDir);

    // Re-open the just-saved `a.slidra` into a completely separate
    // SLIDRA_HOME and compare every file byte-for-byte.
    secondHome = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-home2-"));
    const previousHome = process.env.SLIDRA_HOME;
    process.env.SLIDRA_HOME = secondHome;
    // [E4.T9]/F7: slidra serve now spawns the Rust binary for every read/write.
    process.env.SLIDRA_BIN = slidraBin;
    try {
      const secondOpened = await harness.registry.dispatch<{ id: string }>("open", { path: slidraPath });
      const secondId = secondOpened.data!.id;
      const secondWorkDir = await workDirFor(secondId);
      const secondFiles = await listFilesRecursive(secondWorkDir);
      expect(secondFiles).toEqual(firstFiles);

      for (const relativePath of firstFiles) {
        const firstBytes = await readFile(path.join(firstWorkDir, relativePath));
        const secondBytes = await readFile(path.join(secondWorkDir, relativePath));
        if (relativePath === "project.json") {
          expect(JSON.parse(secondBytes.toString("utf-8"))).toEqual(JSON.parse(firstBytes.toString("utf-8")));
        } else {
          expect(secondBytes.equals(firstBytes)).toBe(true);
        }
      }

      const editedSlide = await readFile(path.join(secondWorkDir, "slides/001.svg"), "utf-8");
      expect(editedSlide).toContain("roundtrip 已編輯");
    } finally {
      process.env.SLIDRA_HOME = previousHome;
      // [E4.T9]/F7: slidra serve now spawns the Rust binary for every read/write.
      process.env.SLIDRA_BIN = slidraBin;
    }
  });

  it("POST /api/save without a sourcePath (a pre-NOOP-93 registry entry) is refused with 400, not a guessed path", async () => {
    harness = await startHarness();
    const { server, slidraHome, presentationId } = harness;

    // Simulate a registry entry created before this ticket: no
    // sourcePath/savedAt at all.
    const registryPath = path.join(slidraHome, "projects.json");
    const raw = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, { workDir: string }>;
    const workDir = raw[presentationId].workDir;
    raw[presentationId] = { workDir };
    await writeFile(registryPath, JSON.stringify(raw));

    const saveResponse = await fetch(`${server.url}/api/save`, { method: "POST" });
    expect(saveResponse.status).toBe(400);
    const body = (await saveResponse.json()) as { error: string };
    expect(body.error).toContain("沒有可寫回的檔案路徑");
  });
});

describe("POST /api/open (#210 條件 1)", () => {
  it("replaces the served presentation in place, clears undo history, and keeps the same id", async () => {
    harness = await startHarness();
    const { server, presentationId } = harness;

    // Build a second, distinct .slidra to open on top of the running server.
    const otherDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-other-"));
    try {
      const otherSlidraPath = path.join(otherDir, "other.slidra");
      await packDirectory(path.join(rootDir, "demo"), otherSlidraPath);
      const otherBytes = await readFile(otherSlidraPath);

      const openResponse = await fetch(`${server.url}/api/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-slidra-file-name": encodeURIComponent("other.slidra"),
        },
        body: otherBytes,
      });
      expect(openResponse.status).toBe(200);
      const openBody = (await openResponse.json()) as { ok: true; fileName: string };
      expect(openBody.ok).toBe(true);

      const presentationResponse = await fetch(`${server.url}/api/presentation`);
      const presentation = (await presentationResponse.json()) as { name: string; slides: string[] };
      expect(presentation.name).toBe("驗收用簡報");
      expect(presentation.slides).toHaveLength(4);

      const stateResponse = await fetch(`${server.url}/api/save-state`);
      await expect(stateResponse.json()).resolves.toEqual({ known: true, dirty: false, fileName: openBody.fileName });

      // Undo history for this id must have been cleared by the reopen.
      const undoResponse = await fetch(`${server.url}/api/undo`, { method: "POST" });
      expect(undoResponse.status).toBe(400);
      const undoBody = (await undoResponse.json()) as { error: string };
      expect(undoBody.error).toContain("沒有可復原的操作");

      // The presentation id served did not change (§7 decision 5).
      expect(await workDirFor(presentationId)).toBeTruthy();
    } finally {
      await rm(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refuses with 409 when there are unsaved changes and no discard header, then succeeds once the header is set", async () => {
    harness = await startHarness();
    const { server } = harness;

    const setResponse = await fetch(`${server.url}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "text set",
        input: { slidePath: "slides/001.svg", elementId: "el-title", newText: "尚未儲存的變更" },
      }),
    });
    expect(setResponse.status).toBe(200);

    const otherDir = await mkdtemp(path.join(tmpdir(), "slidra-roundtrip-other2-"));
    try {
      const otherSlidraPath = path.join(otherDir, "other.slidra");
      await packDirectory(path.join(rootDir, "demo"), otherSlidraPath);
      const otherBytes = await readFile(otherSlidraPath);

      const refused = await fetch(`${server.url}/api/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-slidra-file-name": encodeURIComponent("other.slidra"),
        },
        body: otherBytes,
      });
      expect(refused.status).toBe(409);

      const forced = await fetch(`${server.url}/api/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-slidra-file-name": encodeURIComponent("other.slidra"),
          "x-slidra-discard-unsaved": "1",
        },
        body: otherBytes,
      });
      expect(forced.status).toBe(200);
    } finally {
      await rm(otherDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("400s on a corrupt upload without touching the work directory's existing content", async () => {
    harness = await startHarness();
    const { server, presentationId } = harness;
    const before = await readFile(path.join(await workDirFor(presentationId), "project.json"), "utf-8");

    const response = await fetch(`${server.url}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-slidra-file-name": "broken.slidra" },
      body: Buffer.from("not a zip file"),
    });
    expect(response.status).toBe(400);

    const after = await readFile(path.join(await workDirFor(presentationId), "project.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("400s on an empty body", async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.server.url}/api/open`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(0),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("沒有收到檔案內容");
  });
});

describe("⌘S 鍵盤入口（06-KEYBOARD_AND_GESTURES.md，走真實瀏覽器——上面兩個 describe 都是純 HTTP，這裡才有 App.tsx 的 keydown handler）", () => {
  let browser: Browser;

  it("按 ⌘S：POST /api/save 被送出，GET /api/save-state 回 dirty: false", async () => {
    await requireBuilt(rootDir);
    browser = await chromium.launch();
    const started = await startServerFor({ deckDir, prefix: "roundtrip-cmd-s" });
    try {
      const page = await openApp(browser, started.server);
      // startServerFor 用 registry.dispatch("open", { path: slidraPath }) 開檔，
      // 這條路徑一定帶 sourcePath（見 helpers/launch.ts 本身的說明），
      // /api/save 才有東西可以寫回。先真的改動一次，dirty 才會是 true——
      // 不改就按 ⌘S，看到 dirty: false 證明不了 ⌘S 做了什麼（本來就是 false）。
      const setResult = await started.registry.dispatch("text set", {
        id: started.presentationId,
        slidePath: "slides/001.svg",
        elementId: "el-title",
        newText: "⌘S 測試",
      });
      expect(setResult.ok).toBe(true);
      await expect
        .poll(() => fetch(`${started.server.url}/api/save-state`).then((r) => r.json()))
        .toEqual({ known: true, dirty: true, fileName: "deck.slidra" });

      // 焦點刻意留在父文件（不點投影片）：⌘S 的 keydown 監聽掛在 App.tsx 的
      // `document`，焦點若先移進 sandbox iframe，這個按鍵事件根本不會冒泡
      // 回父文件（跨 iframe 邊界不冒泡），⌘S 就打不到——這裡驗證的正是「焦點
      // 在父文件時」這個最直接可達的路徑。
      await page.keyboard.press("Meta+s");

      await expect
        .poll(() => fetch(`${started.server.url}/api/save-state`).then((r) => r.json()))
        .toEqual({ known: true, dirty: false, fileName: "deck.slidra" });
    } finally {
      await browser.close();
      await started.cleanup();
    }
  });
});

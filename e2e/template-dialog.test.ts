import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { CommandRegistry } from "@co-motion/cli";
import type { RunningServer } from "../packages/server/src/serve.js";
import { openApp as openAppHelper, requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";

/**
 * [E4.T7] 範本管理對話框，Review NOOP-353 FAIL (b1) 指出的刪除失敗契約——見
 * Plan NOOP-351 §4.2：任何命令回 `ok:false` 時對話框內原樣顯示 message、確認
 * 區保持開啟、清單不變。上一輪只做了樂觀假設（`await onDelete` 後直接關閉確
 * 認），這裡補一個走真實 Chromium + 真實 server 邊界的失敗回應測試。
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(e2eDir, "fixtures/direct-manipulation-deck");

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(rootDir);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function startServerFor(): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  cleanup: () => Promise<void>;
}> {
  return startServerForHelper({ deckDir, prefix: "template-dialog", injectFonts: true });
}

async function readProject(registry: CommandRegistry, presentationId: string): Promise<{ templates?: unknown[] }> {
  const result = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "project.json" });
  if (!result.ok) throw new Error(result.message);
  return JSON.parse(result.data!.content);
}

it("刪除範本：伺服器回 500 時，確認區保持開啟、顯示錯誤訊息、project.json 不變", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const added = await registry.dispatch<{ templatePath: string }>("template add", {
      id: presentationId,
      from: "slides/001.svg",
      name: "審查用範本",
    });
    if (!added.ok) throw new Error(added.message);
    const templatePath = added.data!.templatePath;

    const beforeProject = await readProject(registry, presentationId);
    expect(beforeProject.templates).toHaveLength(1);

    const page = await openAppHelper(browser, server);
    openPages.push(page);

    await page.route("**/api/command", async (route) => {
      const body = route.request().postDataJSON() as { name?: string };
      if (body.name === "template delete") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "刪除失敗（審查注入）" }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('.tab:has-text("常用")').click();
    await page.locator('.cmd:has-text("範本")').click();
    const dialog = page.locator('[aria-label="範本管理"]');
    await expect.poll(() => dialog.count()).toBe(1);

    const item = dialog.locator(".template-dialog-item");
    await expect.poll(() => item.count()).toBe(1);

    await item.getByRole("button", { name: "刪除" }).click();
    await item.getByRole("button", { name: "確定刪除" }).click();

    const alert = item.locator('[role="alert"]');
    await expect.poll(() => alert.textContent().catch(() => null)).toBe("刪除失敗（審查注入）");
    // 確認區沒有因失敗而關閉：仍然看得到「確定刪除」。
    expect(await item.getByRole("button", { name: "確定刪除" }).count()).toBe(1);
    expect(await item.count()).toBe(1);

    const afterProject = await readProject(registry, presentationId);
    expect(afterProject).toEqual(beforeProject);
  } finally {
    await cleanup();
  }
});

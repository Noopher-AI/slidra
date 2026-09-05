import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, it } from "vitest";
import { firefox, webkit, type Browser } from "playwright";
import { requireBuilt, startServerFor as startServerForHelper } from "./helpers/launch.js";
import { runSmoke } from "./helpers/smoke.js";

/**
 * Firefox／WebKit structural smoke (NOOP-9 Plan §1/§2.1-3/§4.5): the parent
 * ticket's AC explicitly does not require cross-browser pixel parity — this
 * file has no `compareScreenshot` import anywhere (verifiable with `grep -L
 * compareScreenshot e2e/cross-browser-smoke.test.ts`), only the structural
 * checks in e2e/helpers/smoke.ts.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const demoDir = path.join(rootDir, "demo");

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
];

const ENGINES = [
  { name: "firefox", launcher: firefox },
  { name: "webkit", launcher: webkit },
];

beforeAll(async () => {
  await requireBuilt(rootDir);
});

for (const engine of ENGINES) {
  let browser: Browser;

  beforeAll(async () => {
    try {
      browser = await engine.launcher.launch();
    } catch (error) {
      throw new Error(`${engine.name} 啟動失敗（可能未安裝）：${(error as Error).message}`);
    }
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const viewport of VIEWPORTS) {
    it(`${engine.name} @ ${viewport.width}x${viewport.height}：核心流程可操作、無重疊、無裁切、非淺色破版`, async () => {
      const { server, cleanup } = await startServerForHelper({
        deckDir: demoDir,
        prefix: `cross-browser-smoke-${engine.name}-${viewport.width}`,
      });
      try {
        await runSmoke(browser, server, viewport);
      } catch (error) {
        throw new Error(`${engine.name} @ ${viewport.width}x${viewport.height}：${(error as Error).message}`);
      } finally {
        await cleanup();
      }
    });
  }
}

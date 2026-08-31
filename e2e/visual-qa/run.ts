import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { chromium, type Browser } from "playwright";
import { openApp, requireBuilt, startServerFor } from "../helpers/launch.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

/**
 * Single entry point for `npm run visual-qa`: opens the `demo/` deck once
 * per scenario, drives the ribbon exactly the way a human would, screenshots
 * the settled frame, and writes a manifest. Makes no judgment about whether
 * any screenshot looks right — that is `docs/visual-qa.md`'s job, applied by
 * a separate agent reading the output this file produces.
 */

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.join(e2eDir, "..");
const deckDir = path.join(rootDir, "demo");
const outDir = path.join(e2eDir, "visual-qa/out");

interface FlatScenario extends Scenario {
  cmdId: string;
}

function flattenScenarios(): FlatScenario[] {
  const flat: FlatScenario[] = [];
  const seenIds = new Set<string>();
  for (const [cmdId, scenarios] of Object.entries(SCENARIOS)) {
    if (scenarios.length === 0) throw new Error(`場景表 "${cmdId}" 對應空陣列，至少要有一個場景`);
    for (const scenario of scenarios) {
      if (seenIds.has(scenario.id)) throw new Error(`場景 id 重複："${scenario.id}"`);
      seenIds.add(scenario.id);
      flat.push({ ...scenario, cmdId });
    }
  }
  return flat;
}

function formatManifestRow(scenario: FlatScenario): string {
  return `| ${scenario.id} | ${scenario.description} | ${scenario.id}.png | ${scenario.note ?? "—"} |`;
}

async function runScenario(browser: Browser, scenario: FlatScenario): Promise<void> {
  const { server, registry, presentationId, cleanup } = await startServerFor({
    deckDir,
    prefix: `visual-qa-${scenario.id}`,
    injectFonts: true,
  });
  try {
    const page = await openApp(browser, server, { waitForFonts: true });
    try {
      await scenario.run({ page, server, registry, presentationId });
      await page.screenshot({ path: path.join(outDir, `${scenario.id}.png`) });
    } finally {
      await page.close();
    }
  } finally {
    await cleanup();
  }
}

it(
  "視覺 QA 場景執行器：跑完 22 個場景，輸出截圖與 manifest",
  async () => {
    await requireBuilt(rootDir);
    const scenarios = flattenScenarios();

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const browser = await chromium.launch();
    let chromiumVersion: string;
    try {
      chromiumVersion = browser.version();
      for (const scenario of scenarios) {
        try {
          await runScenario(browser, scenario);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`場景 "${scenario.id}" 執行失敗：${reason}`, { cause: error });
        }
      }
    } finally {
      await browser.close();
    }

    const sorted = [...scenarios].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lines = [
      "# 視覺 QA 場景清單",
      "",
      `執行時間：${new Date().toISOString()}　Chromium：${chromiumVersion}`,
      "",
      "| 場景 id | 操作 | 截圖 | 備註 |",
      "| --- | --- | --- | --- |",
      ...sorted.map(formatManifestRow),
      "",
    ];
    await writeFile(path.join(outDir, "index.md"), lines.join("\n"), "utf-8");
  },
  600_000,
);

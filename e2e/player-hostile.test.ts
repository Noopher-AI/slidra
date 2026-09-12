import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * Spec user story 22: a slide carrying malicious script cannot reach
 * presentation data. A separate fixture deck from `player-deck` /
 * `play-deck` (per the design doc — those decks' existing assertions must
 * not have to change shape to make room for a hostile fourth slide). The
 * hostile payload lives in `fixtures/hostile-deck/slides/001.svg`'s own
 * inline `<script>` and only runs once play mode grants `allow-scripts`;
 * view mode also carries `allow-scripts` (ADR-0011), so the boundary this
 * test defends is the `postMessage` mode gate, not the sandbox token itself.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/comotion");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/hostile-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();

  coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-e2e-hostile-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "comotion-e2e-hostile-files-"));
  process.env.COMOTION_HOME = coMotionHome;
  // [E4.T9]/F7: comotion serve now spawns the Rust binary for every read/write.
  process.env.COMOTION_BIN = coMotionBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "hostile-deck.comot");
  await packDirectory(deckFixtureDir, comotPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "此測試不會送出訊息",
    },
  };

  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.COMOTION_HOME;
  delete process.env.COMOTION_BIN;
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

it("惡意投影片的 script 進入播放模式後仍取不到簡報資料", async () => {
  const page = await browser.newPage();

  // Collected on the TOP page — this is the parent document the hostile
  // script's `parent.postMessage` targets, exactly as canvas.ts's own
  // listener does.
  const probeMessages: Array<{ outcome: string; status?: number; text?: string; message?: string }> = [];
  await page.exposeFunction("__recordProbe", (msg: (typeof probeMessages)[number]) => probeMessages.push(msg));
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string } | undefined;
      if (data?.source === "hostile-slide-probe") {
        (window as unknown as { __recordProbe: (m: unknown) => void }).__recordProbe(data);
      }
    });
  });

  // The app's own top-level `mountCanvas` also calls `/api/presentation`
  // (a normal, same-origin request with a real Origin header) — only a
  // response to a request carrying `Origin: null` would be the hostile
  // iframe's, so that is the one this test would hold to "must be 403" if
  // it ever shows up.
  const opaqueOriginResponses: number[] = [];
  page.on("response", (response) => {
    if (!response.url().endsWith("/api/presentation")) return;
    if (response.request().headers()["origin"] === "null") {
      opaqueOriginResponses.push(response.status());
    }
  });

  await page.goto(server.url);
  await expect
    .poll(() => page.frameLocator("iframe.slide-frame").locator("#el-title").textContent().catch(() => null), {
      timeout: 30_000,
    })
    .toBe("看起來人畜無害的投影片");

  await page.locator('.play-button').click();
  await expect.poll(() => page.locator(".titlebar").count()).toBe(0);

  // The hostile script fires its fetch immediately on load; wait for its
  // report to arrive rather than guessing a timeout.
  await expect.poll(() => probeMessages.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const probe = probeMessages[0];
  // Empirically, on this platform (headless Chromium 151), a bare
  // `fetch()` from a truly opaque-origin document is refused by the
  // browser itself before the request ever reaches the network —
  // `TypeError: Failed to fetch`, and no request for
  // `/api/presentation` carrying `Origin: null` is ever observed on the
  // wire (confirmed by `opaqueOriginResponses` staying empty below). That
  // is a *stronger* guarantee than ADR-0010's stated threat model assumes
  // ("an opaque origin can still send simple requests — it just can't
  // read the response"): here it cannot even send this one. This is
  // reported to the coordinator (see the unit's own report) rather than
  // treated as this test's problem to route around; the "fetch-resolved"
  // branch below is kept so this test still passes correctly if some
  // other engine, or a future Chromium, actually lets the simple request
  // reach the network the way the spec assumed.
  if (probe.outcome === "fetch-resolved") {
    // The request reached the network (an opaque origin can still write),
    // but must never have handed real presentation content to the script:
    // the server's `Origin: null` gate must have refused it.
    expect(probe.status).toBe(403);
    expect(probe.text ?? "").not.toContain("惡意投影片測試簡報");
    expect(opaqueOriginResponses.length).toBeGreaterThan(0);
    expect(opaqueOriginResponses.every((status) => status === 403)).toBe(true);
  } else {
    // The observed outcome on this platform: blocked before the script
    // ever saw a body, so it got nothing at all — never mind real data.
    expect(probe.outcome).toBe("fetch-rejected");
    expect(opaqueOriginResponses).toEqual([]);
  }
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

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
 * The spec requires that a slide carrying malicious script cannot reach
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
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
const deckFixtureDir = path.join(e2eDir, "fixtures/hostile-deck");
const binDir = path.join(rootDir, "node_modules/.bin");

let browser: Browser;
let slidraHome: string;
let slidraDir: string;
let server: RunningServer;

beforeAll(async () => {
  await requireBuilt(webDistIndex, "apps/web/dist does not exist, run npm run build first");

  browser = await chromium.launch();

  slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-hostile-home-"));
  slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-hostile-files-"));
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "hostile-deck.slidra");
  await packDirectory(deckFixtureDir, slidraPath);
  const opened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
  const presentationId = opened.data!.id;

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: "this test never sends a message",
    },
  };

  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  delete process.env.SLIDRA_HOME;
  delete process.env.SLIDRA_BIN;
  if (slidraHome) await rm(slidraHome, { recursive: true, force: true });
  if (slidraDir) await rm(slidraDir, { recursive: true, force: true });
});

it("a hostile slide's script still cannot reach presentation data once in play mode", async () => {
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
  // read the response"): here it cannot even send this one. This is a
  // stronger result than the test strictly needs, not a problem to route
  // around; the "fetch-resolved" branch below is kept so this test still
  // passes correctly if some other engine, or a future Chromium, actually
  // lets the simple request reach the network the way the spec assumed.
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

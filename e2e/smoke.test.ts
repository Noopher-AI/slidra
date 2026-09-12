import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";

/**
 * The browser end-to-end smoke test (issue #16). It exists to catch one
 * kind of failure and no other: the seam between the pieces. The frontend
 * modules, the server routes and the ACP wiring each have their own tests
 * already; what nothing else covers is "every part is fine on its own and
 * the whole thing still does not move".
 *
 * Everything here is real except the agent: a real `startServe`, the real
 * built `apps/web/dist` bundle, a real Chromium, a real presentation
 * created through the real `new`/`open` commands, and a real `comotion`
 * binary resolved from PATH. Only the agent is a fake ACP subprocess, so
 * the test needs neither Claude Code installed nor any API quota.
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const coMotionBin = path.join(rootDir, "target/release/comotion");
const webDistIndex = path.join(rootDir, "apps/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/editing-fake-acp-agent.mjs");
// Where npm's workspace linking puts the `comotion` executable. This is
// the PATH the fake agent's shell command resolves through — the same
// lookup that failed during #8's manual acceptance.
const binDir = path.join(rootDir, "node_modules/.bin");

const NEW_TITLE = "煙霧測試改過的標題";

let browser: Browser;
let coMotionHome: string;
let comotDir: string;
let registry: CommandRegistry;
let server: RunningServer;

beforeAll(async () => {
  // A build is a precondition of this test, not part of it: the test runs
  // against whatever is in apps/web/dist, which is exactly what makes
  // "the bundle itself is broken" a failure it can see. Missing build
  // output is an explicit error — never a skip, never a silent pass.
  await requireBuilt(webDistIndex, "apps/web/dist 不存在，請先執行 npm run build");

  browser = await chromium.launch();
  // Printed so a passing run visibly says which real browser it drove,
  // rather than leaving "a browser was involved" to be taken on trust.
  console.log(`瀏覽器：Chromium ${browser.version()}`);

  coMotionHome = await mkdtemp(path.join(tmpdir(), "comotion-e2e-home-"));
  comotDir = await mkdtemp(path.join(tmpdir(), "comotion-e2e-files-"));
  process.env.COMOTION_HOME = coMotionHome;
  // [E4.T9]/F7: comotion serve now spawns the Rust binary for every read/write.
  process.env.COMOTION_BIN = coMotionBin;

  registry = createDefaultRegistry();
  const comotPath = path.join(comotDir, "deck.comot");
  await registry.dispatch("new", { path: comotPath, name: "煙霧測試簡報" });
  const opened = await registry.dispatch<{ id: string }>("open", { path: comotPath });
  const presentationId = opened.data!.id;
  // `new` creates no slides (ADR-0018); this test addresses slides/001.svg.
  await registry.dispatch("slide add", { id: presentationId });

  const agent: AgentAdapterConfig = {
    kind: "claude",
    label: "Claude Code",
    command: process.execPath,
    args: [agentFixture],
    env: {
      // Deliberately NOT `${binDir}:${process.env.PATH}`. The ambient PATH
      // npm sets up also contains every ancestor directory's
      // node_modules/.bin — including the main checkout's, when this runs
      // in a git worktree — so inheriting it lets `comotion` resolve to
      // some *other* copy of this project and hides a broken link in this
      // one. The only two entries the agent's shell command legitimately
      // needs are this workspace's bin directory and the directory holding
      // the `node` its `#!/usr/bin/env node` shebang looks up.
      PATH: `${binDir}:${path.dirname(process.execPath)}`,
      E2E_PRESENTATION_ID: presentationId,
      E2E_NEW_TITLE: NEW_TITLE,
    },
  };

  // Port 0: the OS assigns a free port and we read the real one back.
  server = await startServe({ presentationId, port: 0, agent });
});

afterAll(async () => {
  // Browser first, server second — the order is load-bearing. The page's
  // EventSource reconnects on its own whenever a stream ends, so closing
  // the server while a tab is still open lets a fresh /api/chat/stream
  // request arrive *after* close()'s disposers have already drained the
  // set of live streams. That stream is then never closed, and
  // `server.close()` waits on it forever (it waits for established
  // connections rather than severing them). Killing the browser first
  // removes the thing that can reconnect. Running this file on its own
  // happened not to hit it; running it after other e2e files did.
  await browser?.close();
  await server?.close();
  delete process.env.COMOTION_HOME;
  delete process.env.COMOTION_BIN;
  // Guarded: beforeAll can fail before these exist (e.g. no build output),
  // and an unguarded rm(undefined) here would bury that error under its own.
  if (coMotionHome) await rm(coMotionHome, { recursive: true, force: true });
  if (comotDir) await rm(comotDir, { recursive: true, force: true });
});

it("在瀏覽器裡送出訊息後，畫布上的 SVG 文字真的變了", async () => {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(server.url);

  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text");
  // Reports an uncaught page error in place of the (absent) slide text, so
  // a broken bundle fails saying *why* rather than just timing out.
  const currentSlideText = async (): Promise<string | null> => {
    if (pageErrors.length > 0) return `頁面錯誤：${pageErrors.join("; ")}`;
    return slideText.textContent().catch(() => null);
  };

  // The bundle has to boot, fetch the presentation and paint the slide for
  // this to ever resolve — a broken dist fails right here.
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe("煙霧測試簡報");

  // The send button is disabled until the chat SSE stream is open, so
  // waiting for it is also waiting for the stream.
  await page.locator(".chat-input button:not([disabled])").waitFor({ timeout: 30_000 });
  await page.locator(".chat-input textarea").fill("把標題改掉");
  await page.locator(".chat-input button").click();

  // The whole chain in one assertion: POST /api/chat -> fake agent ->
  // fs/read_text_file -> permission allowlist -> `comotion text set` off
  // PATH -> file watcher -> /api/events -> canvas reload -> new SVG text.
  await expect.poll(currentSlideText, { timeout: 30_000 }).toBe(NEW_TITLE);

  expect(pageErrors).toEqual([]);
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

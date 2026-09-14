// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createDefaultRegistry, type CommandRegistry } from "./helpers/cli.js";
import { packDirectory } from "./helpers/pack.js";
import { startServe, type RunningServer } from "../packages/server/src/serve.js";
import type { AgentAdapterConfig } from "../packages/server/src/agent/session.js";
import { waitForAgentConnected } from "./helpers/launch.js";

/**
 * `05-INTERACTIONS.feature`'s "collaborating with AI" scenarios — the four
 * scenarios that belong in this file: commenting on an element, commenting
 * on a whole page, jumping to and editing a comment, and submitting, plus
 * a Save/Open round-trip and an agent-written comment showing up in
 * the GUI without a page refresh. The fifth scenario, "agent editing",
 * is `e2e/freeze.test.ts`'s own test, extended in place.
 *
 * `editing-fake-acp-agent.mjs` cannot serve this file — it only knows
 * `text set`. `comment-fake-acp-agent.mjs` branches on the author's message
 * text into `comment add`/`slide add`/`text set`, or echoes the prompt back
 * verbatim (the default case, which is what "submitting" actually asserts
 * on: proof the comment-context prefix server-side `session.ts` builds
 * really reached the agent).
 */

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(e2eDir, "..");
const slidraBin = path.join(rootDir, "target/release/slidra");
const webDistIndex = path.join(rootDir, "packages/web/dist/index.html");
const agentFixture = path.join(e2eDir, "fixtures/comment-fake-acp-agent.mjs");
const deckDir = path.join(e2eDir, "fixtures/ai-collab-deck");
const presentationFontDir = path.join(rootDir, "assets/fonts");
const binDir = path.join(rootDir, "node_modules/.bin");

const VIEWPORT = { width: 1440, height: 900 };

let browser: Browser;
let openPages: Page[] = [];

beforeAll(async () => {
  await requireBuilt(webDistIndex, "packages/web/dist does not exist, please run npm run build first");
  browser = await chromium.launch();
  console.log(`Browser: Chromium ${browser.version()}`);
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  for (const page of openPages) await page.close().catch(() => {});
  openPages = [];
});

async function requireBuilt(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

async function startServerFor(
  agentEnv: Record<string, string> = {},
  skills: { bundled?: Record<string, string>; user?: Record<string, string> } = {},
): Promise<{
  server: RunningServer;
  registry: CommandRegistry;
  presentationId: string;
  slidraPath: string;
  cleanup: () => Promise<void>;
}> {
  const slidraHome = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-home-"));
  const slidraDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-files-"));
  const deckStagingDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-deck-"));
  // Never resolve against the real machine's `~/.claude/skills` — a real
  // skill directory happening to exist on whatever machine runs this suite
  // would silently leak into `/` list assertions. Always temp dirs,
  // populated per-test via `skills.bundled`/`skills.user` (SKILL.md
  // frontmatter text, keyed by skill directory name) when a test needs a
  // deterministic entry.
  const bundledSkillsDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-bundled-"));
  const userSkillsDir = await mkdtemp(path.join(tmpdir(), "slidra-e2e-ai-collab-user-"));
  for (const [dir, entries] of [
    [bundledSkillsDir, skills.bundled] as const,
    [userSkillsDir, skills.user] as const,
  ]) {
    for (const [name, frontmatter] of Object.entries(entries ?? {})) {
      const skillDir = path.join(dir, name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), frontmatter, "utf8");
    }
  }
  process.env.SLIDRA_HOME = slidraHome;
  // slidra serve now spawns the Rust binary for every read/write.
  process.env.SLIDRA_BIN = slidraBin;

  await cp(deckDir, deckStagingDir, { recursive: true });
  await mkdir(path.join(deckStagingDir, "fonts"), { recursive: true });
  await cp(presentationFontDir, path.join(deckStagingDir, "fonts"), { recursive: true });

  const registry: CommandRegistry = createDefaultRegistry();
  const slidraPath = path.join(slidraDir, "deck.slidra");
  await packDirectory(deckStagingDir, slidraPath);
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
      ...agentEnv,
    },
  };

  const server = await startServe({ presentationId,
    port: 0,
    agent,
    skillDirs: { bundled: bundledSkillsDir, user: userSkillsDir },
  });

  return {
    server,
    registry,
    presentationId,
    slidraPath,
    cleanup: async () => {
      await server.close();
      delete process.env.SLIDRA_HOME;
      delete process.env.SLIDRA_BIN;
      await rm(slidraHome, { recursive: true, force: true });
      await rm(slidraDir, { recursive: true, force: true });
      await rm(deckStagingDir, { recursive: true, force: true });
      await rm(bundledSkillsDir, { recursive: true, force: true });
      await rm(userSkillsDir, { recursive: true, force: true });
    },
  };
}

async function openApp(server: RunningServer, options: { waitForAgent?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  openPages.push(page);
  await page.goto(server.url);
  const slideText = page.frameLocator("iframe.slide-frame").locator("svg text").first();
  await expect.poll(() => slideText.textContent().catch(() => null), { timeout: 30_000 }).not.toBeNull();
  if (options.waitForAgent) {
    await waitForAgentConnected(page);
  }
  return page;
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator('.chat-input button[type="submit"]:not([disabled])').waitFor({ timeout: 30_000 });
  await page.locator(".chat-input textarea").fill(text);
  await page.locator('.chat-input button[type="submit"]').click();
}

async function listComments(
  registry: CommandRegistry,
  id: string,
  slidePath?: string,
): Promise<{ id: string; slidePath: string; target: string; text: string }[]> {
  const result = await registry.dispatch<{ comments: { id: string; slidePath: string; target: string; text: string }[] }>(
    "comment list",
    { id, slidePath },
  );
  if (!result.ok) throw new Error(result.message);
  return result.data!.comments;
}

/** The context bar is ghost (`pointer-events: none`) until the pointer hovers it long enough to solidify — a click before this never reaches a button, it always resolves to the iframe underneath instead. */
async function hoverContextBar(page: Page): Promise<void> {
  const box = (await page.locator(".context-bar").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.locator(".context-bar.is-solid").count()).toBeGreaterThan(0);
}

it("commenting on an element: select a single element, Comment to AI, a comment pin appears next to the selection box after submitting", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible(), { timeout: 5000 }).toBe(true);
    await hoverContextBar(page);
    await bar.getByRole("button", { name: "Comment to AI" }).click();

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("Make this title shorter");

    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);

    const pin = page.locator(".comment-pin");
    await expect.poll(() => pin.textContent(), { timeout: 5000 }).toBe("1");

    const comments = await listComments(registry, presentationId, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "el-title", text: "Make this title shorter" })]);
  } finally {
    await cleanup();
  }
});

it("Cmd+Enter saves a comment (06-KEYBOARD_AND_GESTURES.md): pressing Cmd+Enter in the comment box is equivalent to clicking Add comment", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();

    const bar = page.locator(".context-bar");
    await expect.poll(() => bar.isVisible(), { timeout: 5000 }).toBe(true);
    await hoverContextBar(page);
    await bar.getByRole("button", { name: "Comment to AI" }).click();

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("Cmd+Enter save comment test");
    await composer.locator("textarea").press("Meta+Enter");

    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);
    const pin = page.locator(".comment-pin");
    await expect.poll(() => pin.textContent(), { timeout: 5000 }).toBe("1");

    const comments = await listComments(registry, presentationId, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "el-title", text: "Cmd+Enter save comment test" })]);
  } finally {
    await cleanup();
  }
});

it("Cmd+Enter sends a chat message (06-KEYBOARD_AND_GESTURES.md): pressing Cmd+Enter in the chat input is equivalent to clicking Send", async () => {
  const { server, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { waitForAgent: true });
    await page.locator('.chat-input button[type="submit"]:not([disabled])').waitFor({ timeout: 30_000 });
    const input = page.locator(".chat-input textarea");
    await input.fill("Cmd+Enter send test");
    await input.press("Meta+Enter");

    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("Cmd+Enter send test");
    expect(await input.inputValue()).toBe(""); // the input clears after sending
  } finally {
    await cleanup();
  }
});

it("commenting on a whole page: the thumbnail's comment button opens a page-level comment box, and the thumbnail stays highlighted red after submitting", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBeGreaterThan(0);

    const commentButton = page.locator('.overview-item[data-index="0"] .overview-comment-button');
    await commentButton.dispatchEvent("click"); // only shows on hover (opacity 0); dispatching click directly avoids a real hover.

    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await composer.locator("textarea").fill("Rewrite the whole page into three points");
    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);

    await expect.poll(() => commentButton.evaluate((el) => el.classList.contains("has-comments")), { timeout: 5000 }).toBe(true);

    const comments = await listComments(registry, presentationId, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "page", text: "Rewrite the whole page into three points" })]);
  } finally {
    await cleanup();
  }
});

it("jump-to and edit: clicking a Pinned context row, or a comment pin, opens edit mode (original text prefilled, Save changes)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "Element comment" });
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/002.svg", target: "page", text: "Page comment" });

    const page = await openApp(server);
    const pinnedItems = page.locator(".chat-pinned-item");
    await expect.poll(() => pinnedItems.count(), { timeout: 5000 }).toBe(2);

    // First row (earlier page order): clicking jumps to that page, selects that element, opens edit mode.
    await pinnedItems.nth(0).locator(".chat-pinned-item-text").click();
    const composer = page.locator(".comment-composer");
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => composer.locator("textarea").inputValue(), { timeout: 5000 }).toBe("Element comment");
    expect(await composer.getByRole("button", { name: "Save changes" }).isVisible()).toBe(true);
    await composer.getByRole("button", { name: "Cancel" }).click();

    // comment pin: the same comment as above, clicking it also opens edit mode.
    const pin = page.locator(".comment-pin");
    await expect.poll(() => pin.isVisible(), { timeout: 5000 }).toBe(true);
    await pin.click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => composer.locator("textarea").inputValue(), { timeout: 5000 }).toBe("Element comment");
    await composer.getByRole("button", { name: "Cancel" }).click();

    // Second row (page-level comment): jumps page, clears selection, opens edit mode.
    await pinnedItems.nth(1).locator(".chat-pinned-item-text").click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(true);
    await expect.poll(() => composer.locator("textarea").inputValue(), { timeout: 5000 }).toBe("Page comment");
  } finally {
    await cleanup();
  }
});

it("submitting: pinned comments are sent to the agent together with the message (the context prefix really arrives)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "Shorten the title" });
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/002.svg", target: "page", text: "Rewrite the whole page" });

    const page = await openApp(server, { waitForAgent: true });
    const pinned = page.locator(".chat-pinned");
    await expect.poll(() => pinned.isVisible(), { timeout: 5000 }).toBe(true);
    expect(await page.locator(".chat-input-pinned").textContent()).toBe("2 pinned");

    await sendChatMessage(page, "Please handle it per the comments");
    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("Please handle it per the comments");
    const replyText = (await reply.textContent()) ?? "";
    expect(replyText).toContain("slides/001.svg el-title");
    expect(replyText).toContain("Shorten the title");
    expect(replyText).toContain("slides/002.svg page");
    expect(replyText).toContain("Rewrite the whole page");
  } finally {
    await cleanup();
  }
});

it("submitting: with pinned comments present, an empty input can still be sent (the comment itself is the request)", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    await registry.dispatch("comment add", { id: presentationId, slidePath: "slides/001.svg", target: "el-title", text: "Shorten the title" });

    const page = await openApp(server, { waitForAgent: true });
    await page.locator('.chat-input button[type="submit"]:not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('.chat-input button[type="submit"]').click(); // not a single character typed

    // The conversation shows a placeholder string, not an empty bubble.
    const authored = page.locator(".chat-message-author").last();
    await expect.poll(() => authored.textContent(), { timeout: 5000 }).toBe("(No message entered — sending 1 pinned comment(s) only)");

    // The prompt echoed back by the fake agent: both the comment and the "no message entered" note are present, with no empty [The author's message] section.
    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("Shorten the title");
    const replyText = (await reply.textContent()) ?? "";
    expect(replyText).toContain("The author typed no message and only sent the pinned comments above");
    expect(replyText).not.toContain("[The author's message]");
  } finally {
    await cleanup();
  }
});

it("agent editing (holding the lock): a frozen badge appears in the titlebar", async () => {
  const FREEZE_HOLD_MS = 1500;
  const { server, cleanup } = await startServerFor({ E2E_FREEZE_HOLD_MS: String(FREEZE_HOLD_MS) });
  try {
    const page = await openApp(server, { waitForAgent: true });
    await sendChatMessage(page, "hold the lock");

    const badge = page.locator(".titlebar-frozen-badge");
    await expect.poll(() => badge.isVisible(), { timeout: 30_000 }).toBe(true);
  } finally {
    await cleanup();
  }
});

it("after sending, the Send button becomes a stop button; clicking it ends the turn as cancelled and shows \"stopped\"", async () => {
  // The lock-holding branch holds for E2E_FREEZE_HOLD_MS before running its
  // command — the observable window in which Stop has something to stop.
  const { server, registry, presentationId, cleanup } = await startServerFor({ E2E_FREEZE_HOLD_MS: "8000" });
  try {
    const page = await openApp(server, { waitForAgent: true });
    const before = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
    await sendChatMessage(page, "hold the lock");

    const stop = page.locator(".chat-input .chat-stop");
    await expect.poll(() => stop.isVisible(), { timeout: 10_000 }).toBe(true);
    // Stop only has a turn to cancel once one is actually in flight. The
    // button appears the moment the message is sent — while the server may
    // still be shaking hands with the adapter, where Stop takes the
    // "stopped while being established" path instead and no turn ever ends
    // with `cancelled`. The frozen badge is the observable proof that the
    // agent already holds the editing lock, i.e. it is inside the hold with
    // the command not yet run — exactly the window this test is about.
    await expect.poll(() => page.locator(".titlebar-frozen-badge").isVisible(), { timeout: 30_000 }).toBe(true);
    await stop.click();

    const stopped = page.locator(".chat-system", { hasText: "Stopped" });
    await expect.poll(() => stopped.count(), { timeout: 10_000 }).toBe(1);
    // Send is back, the turn is over, and the held command never ran.
    await expect.poll(() => page.locator(".chat-input button[type=submit]").isVisible(), { timeout: 5000 }).toBe(true);
    const after = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "slides/001.svg" });
    expect(after.data!.content).toBe(before.data!.content);
  } finally {
    await cleanup();
  }
});

/**
 * `From outline…` now goes outline → `/slidra-plan` → `plan set` (fake agent)
 * → the plan gate (`.plan-gate`, a blocking modal) → confirm and build →
 * `/slidra-build [plan-confirmed]` → `slide add` (fake agent).
 */
async function openOutlineAndSubmit(page: Page, outline: string): Promise<void> {
  await page.locator(".rail-actions").getByRole("button", { name: "New" }).click();
  const menu = page.locator('[data-menu="new"]');
  await menu.getByRole("menuitem", { name: "From outline…" }).click();
  await page.locator(".outline-modal-textarea").fill(outline);
  await page.locator(".outline-modal-submit").click();
}

it("planning from an outline: through the real UI entry point, the plan gate pops up with a recommended option preselected, and after confirming the agent really builds the new page", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { waitForAgent: true });
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBe(2);

    await openOutlineAndSubmit(page, "Step one\nStep two");

    // What's sent is /slidra-plan plus a fixed positional line, not the old slide add prefix.
    const authored = page.locator(".chat-message-author").last();
    await expect.poll(() => authored.textContent(), { timeout: 5000 }).toContain("/slidra-plan [plan-from-outline] There are 2 pages so far; new pages will be appended at the end.");

    // The fake agent's `plan set` lands → live reload → the gate opens; no page refresh needed.
    const gate = page.locator(".plan-gate");
    await expect.poll(() => gate.isVisible(), { timeout: 30_000 }).toBe(true);
    // Both the plan table and the questions come from the file; the agent's recommendation is the default value.
    expect(await gate.locator(".plan-gate-table tbody tr").count()).toBe(1);
    // Columns: Page | Relationship | Type | Rhythm | Claim.
    const cells = gate.locator(".plan-gate-table tbody td");
    expect(await cells.nth(1).textContent()).toBe("Membership");
    expect(await cells.nth(2).textContent()).toBe("Cover");
    const recommended = gate.locator('.plan-gate-question[data-question-id="mode"] input[value="pyramid"]');
    expect(await recommended.isChecked()).toBe(true);
    expect(await gate.locator(".plan-gate-recommended").count()).toBe(1);

    // Blocking modal: Esc does not close it.
    await page.keyboard.press("Escape");
    expect(await gate.isVisible()).toBe(true);

    // Switch to a different option, fill in extra notes, confirm and build → the sent message has one line per question.
    await gate.locator('.plan-gate-question[data-question-id="mode"] input[value="narrative"]').check();
    await gate.locator(".plan-gate-free-text input").fill("use a story arc");
    await gate.locator(".plan-gate-overall textarea").fill("tighten it overall");
    await gate.locator(".plan-gate-confirm").click();
    await expect.poll(() => gate.count(), { timeout: 5000 }).toBe(0);
    const confirmMessage = page.locator(".chat-message-author").last();
    await expect.poll(() => confirmMessage.textContent(), { timeout: 5000 }).toContain("/slidra-build [plan-confirmed]");
    expect(await confirmMessage.textContent()).toContain("mode=narrative");
    expect(await confirmMessage.textContent()).toContain("mode.note=use a story arc");
    expect(await confirmMessage.textContent()).toContain("Supplement: tighten it overall");

    // The new page is really added, not just a UI event — the thumbnail row is +1 and project.json gains one more path.
    await expect.poll(() => page.locator(".overview-item").count(), { timeout: 30_000 }).toBe(3);
    const project = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "project.json" });
    const slides = JSON.parse(project.data!.content).slides as string[];
    expect(slides).toHaveLength(3);
    // The same draft doesn't pop the gate again on a later presentation-changed event (the agent hasn't marked it confirmed yet).
    expect(await gate.count()).toBe(0);
  } finally {
    await cleanup();
  }
});

it("planning from an outline: the gate's \"discard\" deletes plan/ directly, the gate disappears, and the agent never gets involved", async () => {
  const { server, registry, presentationId, cleanup } = await startServerFor();
  try {
    const page = await openApp(server, { waitForAgent: true });
    await openOutlineAndSubmit(page, "Just one line");
    const gate = page.locator(".plan-gate");
    await expect.poll(() => gate.isVisible(), { timeout: 30_000 }).toBe(true);

    await gate.locator(".plan-gate-discard").click();
    await expect.poll(() => gate.count(), { timeout: 10_000 }).toBe(0);

    const outlineFile = await registry.dispatch<{ content: string }>("cat", { id: presentationId, path: "plan/outline.md" });
    expect(outlineFile.ok).toBe(false);
    // No chat message was ever sent: the last author message is still the original /slidra-plan.
    const authored = page.locator(".chat-message-author").last();
    expect(await authored.textContent()).toContain("/slidra-plan");
    expect(await page.locator(".overview-item").count()).toBe(2);
  } finally {
    await cleanup();
  }
});

it("a comment survives a Save/Open round-trip", async () => {
  const { server, registry, slidraPath, cleanup } = await startServerFor();
  try {
    const page = await openApp(server);
    await page.frameLocator("iframe.slide-frame").locator("#el-title").click();
    await hoverContextBar(page);
    await page.locator(".context-bar").getByRole("button", { name: "Comment to AI" }).click();
    const composer = page.locator(".comment-composer");
    await composer.locator("textarea").fill("should still be here after saving");
    await composer.getByRole("button", { name: "Add comment" }).click();
    await expect.poll(() => composer.isVisible(), { timeout: 5000 }).toBe(false);

    await page.locator('.titlebar-button[title="Save (⌘S)"]').click();
    await expect.poll(() => page.locator(".titlebar-saved-status").textContent(), { timeout: 30_000 }).toBe("Saved");
    // A short settle after the "Saved" status text appears — observed
    // flaky without it (re-open sometimes raced the save's own disk write
    // finishing), matching the same "DOM update precedes full settle"
    // reasoning helpers/screenshot.ts's settleForScreenshot documents.
    await page.waitForTimeout(500);

    const reopened = await registry.dispatch<{ id: string }>("open", { path: slidraPath });
    const comments = await listComments(registry, reopened.data!.id, "slides/001.svg");
    expect(comments).toEqual([expect.objectContaining({ target: "el-title", text: "should still be here after saving" })]);
  } finally {
    await cleanup();
  }
});

it("after the agent writes via the comment command, without a refresh the GUI's Pinned context automatically gets one more row", async () => {
  const AGENT_COMMENT = "comment written by the agent via a command";
  const { server, cleanup } = await startServerFor({ E2E_AGENT_COMMENT: AGENT_COMMENT });
  try {
    const page = await openApp(server, { waitForAgent: true });
    expect(await page.locator(".chat-pinned").count()).toBe(0);

    await sendChatMessage(page, "write a comment");

    const pinnedItems = page.locator(".chat-pinned-item");
    await expect.poll(() => pinnedItems.count(), { timeout: 30_000 }).toBe(1);
    expect(await pinnedItems.first().textContent()).toContain(AGENT_COMMENT);
  } finally {
    await cleanup();
  }
});

// The `/` slash-command menu. This suite already starts a real
// server+browser with a fake agent that can echo prompts verbatim, exactly
// what these two scenarios need.

it("slash commands: list, up/down arrow selection, Enter to complete, Esc to close, live-updates on report changes", async () => {
  const { server, cleanup } = await startServerFor({
    E2E_AVAILABLE_COMMANDS: JSON.stringify([
      { name: "draft", description: "Draft a new slide" },
      { name: "publish", description: "Publish the current version" },
    ]),
    E2E_AVAILABLE_COMMANDS_UPDATE: JSON.stringify([
      { name: "draft", description: "Draft a new slide" },
      { name: "archive", description: "Archive the current presentation" },
    ]),
  });
  try {
    const page = await openApp(server, { waitForAgent: true });
    const input = page.locator(".chat-input textarea");
    const menu = page.locator(".slash-menu");
    const menuItem = page.locator(".slash-menu-item");

    // Before any message is sent, the agent hasn't reported anything yet
    // (session.ts: the ACP subprocess is spawned lazily on the first chat
    // message) — sending one first is what actually makes its
    // availableCommands report land.
    await sendChatMessage(page, "say hello");
    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toContain("say hello");

    // All list entries appear, with descriptions.
    await input.fill("/");
    await expect.poll(() => menuItem.count(), { timeout: 5000 }).toBe(2);
    expect(await menuItem.nth(0).textContent()).toContain("draft");
    expect(await menuItem.nth(0).textContent()).toContain("Draft a new slide");
    expect(await menuItem.nth(1).textContent()).toContain("publish");

    // Down/down from draft to publish, then wrap back to draft; Enter completes it to "/draft ".
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await expect.poll(() => menuItem.nth(0).getAttribute("aria-selected"), { timeout: 5000 }).toBe("true");
    await input.press("Enter");
    await expect.poll(() => input.inputValue(), { timeout: 5000 }).toBe("/draft ");
    await expect.poll(() => menu.count(), { timeout: 5000 }).toBe(0); // after completion, "draft" no longer matches the trigger condition, so the menu closes itself

    // Esc: reopening after closing, and typing further within the same trigger segment does not reopen it.
    await input.fill("/");
    await expect.poll(() => menuItem.count(), { timeout: 5000 }).toBe(2);
    await input.press("Escape");
    await expect.poll(() => menu.count(), { timeout: 5000 }).toBe(0);
    await input.press("d"); // still within the trigger condition ("/d"), but the Esc-closed state must persist
    await expect.poll(() => menu.count(), { timeout: 5000 }).toBe(0);
    await input.fill(""); // leaving the trigger condition resets the Esc-closed state
    await input.fill("/");
    await expect.poll(() => menuItem.count(), { timeout: 5000 }).toBe(2); // reopens

    // After the report updates, without a page refresh, the list changes live: publish disappears and archive appears.
    // (This message itself triggers no agent reply — the fake agent goes
    // straight to end_turn after sending the update — so this polls the menu
    // contents directly rather than waiting for a new message that never comes.)
    await input.fill("");
    await sendChatMessage(page, "update commands");
    await expect.poll(() => input.inputValue(), { timeout: 5000 }).toBe(""); // sendMessage() clears the draft before "/"" gets typed here
    await input.fill("/");
    await expect.poll(() => menuItem.allTextContents(), { timeout: 30_000 }).toEqual(
      expect.arrayContaining([expect.stringContaining("archive")]),
    );
    const namesAfterUpdate = (await menuItem.allTextContents()).join(" ");
    expect(namesAfterUpdate).toContain("draft");
    expect(namesAfterUpdate).toContain("archive");
    expect(namesAfterUpdate).not.toContain("publish");
  } finally {
    await cleanup();
  }
});

it("slash commands: sending /xxx with an argument, the prompt text the fake agent receives matches the input exactly", async () => {
  const { server, cleanup } = await startServerFor(
    {},
    { bundled: { "slidra-plan": "---\nname: slidra-plan\ndescription: Plan a slide from an outline\n---\n" } },
  );
  try {
    const page = await openApp(server, { waitForAgent: true });
    const input = page.locator(".chat-input textarea");

    // "slidra-plan" comes from the bundled skill directory, which is
    // populated before the server ever starts — no need to wait for the
    // agent's own report (which does not exist yet, see the test above) to
    // complete this one. A shipped skill's directory name carries the
    // `slidra-` namespace itself, so what the author types is exactly
    // what the agent has registered.
    await input.fill("/slidra-pl");
    await expect.poll(() => page.locator(".slash-menu-item").count(), { timeout: 5000 }).toBe(1);
    await input.press("Enter");
    const completed = await input.inputValue();
    expect(completed).toBe("/slidra-plan ");

    // Keep typing the argument — the completed text is left untouched, just followed by whatever the author types.
    await input.fill(`${completed}this is the argument`);
    await expect.poll(() => page.locator(".slash-menu").count(), { timeout: 5000 }).toBe(0); // contains a space, so the trigger condition no longer holds
    await page.locator('.chat-input button[type="submit"]:not([disabled])').click();

    const reply = page.locator(".chat-message-agent").last();
    await expect.poll(() => reply.textContent(), { timeout: 30_000 }).toBe("/slidra-plan this is the argument");
  } finally {
    await cleanup();
  }
});

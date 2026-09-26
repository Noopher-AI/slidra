import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { inSlide, openDeckFile, waitForSlide } from "./helpers.mjs";

// A slide that tries every way an SVG can run script. None of it may run.
const hostile = svg(
  [
    '<script>document.documentElement.setAttribute("data-pwned", "script")</script>',
    '<g id="el-img000000000"><image href="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10" onload="document.documentElement.setAttribute(\'data-pwned\', \'onload\')"/></g>',
    '<g id="el-link00000000"><a href="javascript:document.documentElement.setAttribute(\'data-pwned\', \'href\')"><rect id="hit" x="100" y="100" width="400" height="300" fill="#c00"/></a></g>',
    '<g id="el-click0000000" onclick="document.documentElement.setAttribute(\'data-pwned\', \'onclick\')"><rect x="600" y="100" width="400" height="300" fill="#0c0"/></g>',
    '<g id="el-title0000000"><text x="100" y="600" font-size="40">hostile slide</text></g>',
  ].join(""),
);

test("slide scripts, event handlers and javascript: URLs never run", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await openDeckFile(page, makeDeck({ slides: [hostile, svg('<g id="el-two00000000"><text x="100" y="100">two</text></g>')] }));
  await waitForSlide(page, 1, 2);

  const frame = page.locator("#slide-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const csp = await inSlide(page, () => document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"));
  expect(csp).toMatch(/script-src 'nonce-/);

  await frame.click({ position: { x: 200, y: 150 } });
  expect(await inSlide(page, () => document.documentElement.getAttribute("data-pwned"))).toBeNull();
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-pwned"))).toBeNull();
  expect(errors).toEqual([]);
});

test("a slide cannot reach the viewer page", async ({ page }) => {
  await openDeckFile(page, makeDeck({ slides: [svg('<g id="el-a00000000000"><text x="10" y="50">a</text></g>')] }));
  await waitForSlide(page, 1, 1);
  const reach = await inSlide(page, () => {
    try {
      return String(parent.document.title);
    } catch (error) {
      return error.name;
    }
  });
  expect(reach).toBe("SecurityError");
  expect(await inSlide(page, () => origin)).toBe("null");
});

test("a corrupt effect list shows the slide statically and says why", async ({ page }) => {
  const corrupt = svg('<g id="el-box000000000"><rect width="100" height="100" fill="#00c"/></g>', {
    metadata: `<slidra:effects xmlns:slidra="${NS}"><slidra:effect target="el-box000000000" family="enter" effect="fade" start="with-previous"/></slidra:effects>`,
  });
  await openDeckFile(page, makeDeck({ slides: [corrupt] }));
  await waitForSlide(page, 1, 1);
  await expect(page.locator(".toast")).toContainText("no earlier step to join");
  expect(Number(await inSlide(page, () => getComputedStyle(document.getElementById("el-box000000000")).opacity))).toBe(1);
});

test("hostile containers end in a message, not a broken page (format §17)", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  const deck = makeDeck({ slides: [svg('<g id="el-a00000000000"><text x="10" y="50">a</text></g>')] });
  const truncated = deck.subarray(0, 1500);
  // A ZIP whose only entry claims 16 bytes but inflates to 4 MB.
  const { deflateRawSync } = await import("node:zlib");
  const body = deflateRawSync(Buffer.alloc(4 * 1024 * 1024));
  const name = Buffer.from("project.json");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(16, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(16, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + body.length, 16);
  const bomb = Buffer.concat([local, name, body, central, name, end]);

  /** @type {[string, Uint8Array, RegExp][]} */
  const cases = [
    ["truncated", truncated, /cannot be read|not a \.slidra deck/],
    ["bomb", bomb, /inflates beyond its declared size/],
  ];
  for (const [label, bytes, message] of cases) {
    await page.goto("/");
    await expect(page.locator("#home")).toBeVisible();
    await page.locator("#file-input").setInputFiles({ name: `${label}.slidra`, mimeType: "application/vnd.slidra", buffer: Buffer.from(bytes) });
    await expect(page.locator(".toast").first()).toContainText(message);
    await expect(page.locator("#viewer")).toBeHidden();
  }
  expect(errors).toEqual([]);
});

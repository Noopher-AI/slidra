import { test, expect } from "@playwright/test";
import { makeDeck, svg } from "../test/fixtures/make-deck.mjs";
import { expectCounter, openDeckFile, waitForSlide } from "./helpers.mjs";

const box = (id, x, link, label) =>
  `<g id="${id}"${link === null ? "" : ` data-slidra-link="${link}"`}><rect x="${x}" y="200" width="200" height="120" fill="#246"/><text x="${x + 10}" y="270" fill="#fff" font-size="24">${label}</text></g>`;

const deck = makeDeck({
  slides: [
    svg(
      [
        box("el-toThird00000", 40, "#s-THIRDslide01", "third"),
        box("el-external0000", 280, "https://example.com/talk", "web"),
        box("el-evil00000000", 520, "javascript:parent.alert(1)", "evil"),
        box("el-last00000000", 760, "#last", "last"),
        box("el-dangling0000", 1000, "#s-NOSUCHSLIDE1", "dangling"),
      ].join(""),
      { attrs: ' data-slidra-slide-id="s-FIRSTslide01"' },
    ),
    svg(box("el-back00000000", 40, "#first", "back"), { attrs: ' data-slidra-slide-id="s-SECONDslide1"' }),
    svg(box("el-prev00000000", 40, "#previous", "prev"), { attrs: ' data-slidra-slide-id="s-THIRDslide01"' }),
    svg(box("el-plain0000000", 40, null, "plain")),
  ],
});

async function clickInSlide(page, x, y) {
  // Coordinates are in slide units (1280×720); the frame is scaled to the stage.
  const frame = page.locator("#slide-frame");
  const size = await frame.boundingBox();
  await frame.click({ position: { x: (x / 1280) * size.width, y: (y / 720) * size.height } });
}

test("a link to a slide id, #first, #previous and #last navigate", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 4);
  await clickInSlide(page, 140, 260);
  await waitForSlide(page, 3, 4);
  await clickInSlide(page, 140, 260);
  await waitForSlide(page, 2, 4);
  await clickInSlide(page, 140, 260);
  await waitForSlide(page, 1, 4);
  await clickInSlide(page, 860, 260);
  await waitForSlide(page, 4, 4);
});

test("an external link opens a new tab with no way back to the viewer", async ({ page, context }) => {
  await context.route("https://example.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>talk</title>ok" }));
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 4);
  const popupPromise = page.waitForEvent("popup");
  await clickInSlide(page, 380, 260);
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://example.com/talk");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expectCounter(page, "1 / 4");
});

test("ignored links (javascript:, unknown slide ids) behave like plain elements and are reported", async ({ page }) => {
  const warnings = [];
  page.on("console", (message) => message.type() === "warning" && warnings.push(message.text()));
  let dialog = false;
  page.on("dialog", async (d) => {
    dialog = true;
    await d.dismiss();
  });
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 4);
  await expect.poll(() => warnings.join("\n")).toContain("javascript:parent.alert(1)");
  expect(warnings.join("\n")).toContain("no slide has that id");
  await clickInSlide(page, 620, 260);
  await waitForSlide(page, 2, 4);
  expect(dialog).toBe(false);
});

test("links are reachable with Tab and follow on Enter", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 4);
  await page.locator("#slide-frame").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitForSlide(page, 3, 4);
});

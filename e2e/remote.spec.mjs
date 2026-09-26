import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { expectCounter, openDeckFile, waitForSlide } from "./helpers.mjs";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const deck = makeDeck({
  slides: [
    svg(
      `<g id="el-AAAAAAAAAAAA"><text x="100" y="100">step target</text></g><g id="el-TRACKER00001"><image id="beacon" href="https://tracker.example.com/pixel.png?deck=1" width="100" height="100"/></g>`,
      {
        metadata: `<slidra:effects xmlns:slidra="${NS}"><slidra:effect target="el-AAAAAAAAAAAA" family="emphasis" effect="pulse" start="on-click"/><slidra:effect target="el-AAAAAAAAAAAA" family="emphasis" effect="grow" start="on-click"/></slidra:effects>`,
      },
    ),
    svg('<g id="el-BBBBBBBBBBBB"><text x="100" y="100">nothing remote here</text></g>'),
  ],
});

test("a deck's network resources wait for the viewer's consent (format §13)", async ({ page, context }) => {
  const requests = [];
  await context.route("https://tracker.example.com/**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: PIXEL });
  });
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 2);
  const notice = page.locator("#remote-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("1 item from the internet (tracker.example.com)");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);

  await page.locator("#remote-allow").click();
  await expect(notice).toBeHidden();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toBe("https://tracker.example.com/pixel.png?deck=1");
  await expect(page.locator("#step-dots i.on")).toHaveCount(1);
  await expectCounter(page, "1 / 2");

  // Allowed for the rest of the deck; a slide without network resources shows no notice.
  await page.keyboard.press("End");
  await waitForSlide(page, 2, 2);
  await expect(notice).toBeHidden();
});

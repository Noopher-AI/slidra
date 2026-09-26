import { test, expect } from "@playwright/test";
import { makeDeck, svg, NS } from "../test/fixtures/make-deck.mjs";
import { inSlide, openDeckFile, opacityOf, waitForSlide } from "./helpers.mjs";

const photo = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>').toString("base64");

const deck = makeDeck({
  project: { lang: "en" },
  slides: [
    svg(
      `<title>Team update</title><g id="el-photo0000000"><title>The team on a beach</title><image href="${photo}" x="100" y="100" width="300" height="200"/></g><g id="el-glow00000000" data-slidra-decorative="true"><rect width="1280" height="20" fill="#eee"/></g><g id="el-head00000000"><text x="100" y="500" font-size="60">Hello</text></g>`,
      { metadata: `<slidra:effects xmlns:slidra="${NS}"><slidra:effect target="el-photo0000000" family="enter" effect="fade" start="on-click" duration="0.2"/></slidra:effects>` },
    ),
    svg('<g id="el-zh00000000000"><text x="100" y="300">你好</text></g>', { attrs: ' xml:lang="zh-Hant-TW"' }),
  ],
});

test("slides carry their language, title and accessible names, with no <title> tooltips", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 2);
  await expect(page.locator("#slide-frame")).toHaveAttribute("title", "Slide 1: Team update");
  const semantics = await inSlide(page, () => ({
    lang: document.documentElement.lang,
    titles: document.querySelectorAll("title").length,
    rootLabel: document.querySelector("svg").getAttribute("aria-label"),
    photo: [document.getElementById("el-photo0000000").getAttribute("role"), document.getElementById("el-photo0000000").getAttribute("aria-label")],
    decorative: document.getElementById("el-glow00000000").getAttribute("aria-hidden"),
  }));
  expect(semantics).toEqual({ lang: "en", titles: 0, rootLabel: "Team update", photo: ["img", "The team on a beach"], decorative: "true" });

  // Effects still find their targets after the rewrite.
  expect(await opacityOf(page, "el-photo0000000")).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => opacityOf(page, "el-photo0000000")).toBe(1);

  await page.keyboard.press("ArrowRight");
  await waitForSlide(page, 2, 2);
  expect(await inSlide(page, () => document.documentElement.lang)).toBe("zh-Hant-TW");
});

test("the overview names slides by their titles", async ({ page }) => {
  await openDeckFile(page, deck);
  await waitForSlide(page, 1, 2);
  await page.keyboard.press("g");
  await expect(page.locator(".overview-item").first().locator("button")).toHaveAttribute("aria-label", "Slide 1: Team update");
  await expect(page.locator(".overview-item").first().locator(".overview-label")).toContainText("Team update");
});

import { test, expect } from "@playwright/test";

const DECK = "/decks/0/showcase.slidra";

test("/embed plays a served deck with a small control bar", async ({ page }) => {
  await page.goto(`/embed?deck=${encodeURIComponent(DECK)}#2`);
  const counter = page.locator("slidra-player .counter");
  await expect(counter).toHaveText("2 / 7");
  for (let i = 0; i < 5; i++) await page.locator("slidra-player .next").click();
  await expect(counter).toHaveText("3 / 7");
  await page.locator("slidra-player").focus();
  await page.keyboard.press("Home");
  await expect(counter).toHaveText("1 / 7");
  await expect(page.locator("#e-open")).toHaveAttribute("href", new RegExp(`/\\?deck=${encodeURIComponent(DECK)}#1$`));
});

test("/embed may be framed by other sites; every other page only by this one", async ({ request }) => {
  const embed = await request.get(`/embed?deck=${encodeURIComponent(DECK)}`);
  expect(embed.headers()["content-security-policy"]).toBe("frame-ancestors *");
  expect(embed.headers()["x-frame-options"]).toBeUndefined();
  const home = await request.get("/");
  expect(home.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(home.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
});

test("another site can embed the player; the full viewer refuses to be framed", async ({ page, baseURL }) => {
  // 127.0.0.1 and localhost are different origins: the page below is "another site".
  const other = baseURL.replace("localhost", "127.0.0.1");
  await page.goto(`${other}/api/decks`);
  await page.evaluate((src) => {
    document.body.innerHTML = `<iframe id="player" src="${src}/embed?deck=%2Fdecks%2F0%2Fshowcase.slidra" width="960" height="584"></iframe><iframe id="viewer" src="${src}/" width="400" height="300"></iframe>`;
  }, baseURL);
  await expect(page.frameLocator("#player").locator("slidra-player .counter")).toHaveText("1 / 7");
  // X-Frame-Options/frame-ancestors blocks the viewer: Chromium shows its error page in that frame instead.
  const viewer = await (await page.locator("#viewer").elementHandle()).contentFrame();
  await expect.poll(() => viewer.url()).toMatch(/^chrome-error:/);
});

test("/embed only plays this server's decks", async ({ page }) => {
  await page.goto("/embed?deck=https://example.com/evil.slidra");
  await expect(page.locator("#e-status")).toContainText("names no deck on this server");
});

test("oEmbed describes a deck link as an embeddable iframe, and pages advertise it", async ({ request, baseURL }) => {
  const link = `${baseURL}/?deck=${encodeURIComponent(DECK)}`;
  const response = await request.get(`/api/oembed?url=${encodeURIComponent(link)}&maxwidth=640`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ version: "1.0", type: "rich", provider_name: "Slidra", title: "Slidra Showcase", width: 640, height: 404 });
  expect(body.html).toContain(`src="${baseURL}/embed?deck=${encodeURIComponent(DECK)}"`);
  expect(body.thumbnail_url).toBe(`${baseURL}/api/og?deck=${encodeURIComponent(DECK)}`);
  expect((await request.get(`/api/oembed?url=${encodeURIComponent("https://elsewhere.example/?deck=" + encodeURIComponent(DECK))}`)).status()).toBe(404);
  expect((await request.get(`/api/oembed?url=${encodeURIComponent(link)}&format=xml`)).status()).toBe(501);
  const html = await (await request.get(`/?deck=${encodeURIComponent(DECK)}`)).text();
  expect(html).toMatch(/<link rel="alternate" type="application\/json\+oembed" href="[^"]*\/api\/oembed\?url=/);
});

test("moving through /embed never reloads the slide it is on", async ({ page }) => {
  await page.goto(`/embed?deck=${encodeURIComponent(DECK)}`);
  const counter = page.locator("slidra-player .counter");
  await expect(counter).toHaveText("1 / 7");
  const loads = await page.evaluate(() => {
    const frame = document.querySelector("slidra-player").shadowRoot.querySelector("iframe.slide");
    window["__loads"] = 0;
    frame.addEventListener("load", () => (window["__loads"] += 1));
    return 0;
  });
  await page.locator("slidra-player .next").click();
  await page.locator("slidra-player .next").click();
  await expect(counter).toHaveText("2 / 7");
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window["__loads"])).toBe(loads + 1);
  await expect(page.locator("#e-open")).toHaveAttribute("href", /#2$/);
});

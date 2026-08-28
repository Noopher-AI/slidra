import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoMotionError } from "../src/errors.js";
import { createNewPresentation, openPresentation, listPresentationEntries, readPresentationFile } from "../src/workspace.js";
import { measurePresentationText } from "../src/fonts.js";

let coMotionHome: string;

beforeEach(async () => {
  coMotionHome = await mkdtemp(path.join(tmpdir(), "co-motion-home-"));
  process.env.CO_MOTION_HOME = coMotionHome;
});

afterEach(async () => {
  delete process.env.CO_MOTION_HOME;
  await rm(coMotionHome, { recursive: true, force: true });
});

async function createAndOpen(): Promise<{ id: string }> {
  const comotDir = await mkdtemp(path.join(tmpdir(), "co-motion-files-"));
  try {
    const comotPath = path.join(comotDir, "deck.comot");
    await createNewPresentation(comotPath, "測試簡報");
    return await openPresentation(comotPath);
  } finally {
    await rm(comotDir, { recursive: true, force: true });
  }
}

describe("a newly created presentation", () => {
  it("embeds the presentation font and its license inside fonts/ (A1, A6)", async () => {
    const { id } = await createAndOpen();

    const fontEntries = await listPresentationEntries(id, "fonts");
    expect(fontEntries).toContain("NotoSansTC-Presentation.ttf");
    expect(fontEntries).toContain("LICENSE-NotoSansTC.txt");

    const project = JSON.parse(await readPresentationFile(id, "project.json"));
    expect(project.fonts).toEqual([
      {
        file: "fonts/NotoSansTC-Presentation.ttf",
        family: "Noto Sans TC",
        license: "SIL Open Font License 1.1",
        licenseFile: "fonts/LICENSE-NotoSansTC.txt",
        source: "https://fonts.google.com/noto/specimen/Noto+Sans+TC",
      },
    ]);

    const license = await readPresentationFile(id, "fonts/LICENSE-NotoSansTC.txt");
    expect(license.length).toBeGreaterThan(0);
    expect(license).toMatch(/SIL OPEN FONT LICENSE/);
  });
});

describe("measurePresentationText", () => {
  it("measures text using the presentation's embedded font", async () => {
    const { id } = await createAndOpen();
    const width = await measurePresentationText(id, { family: "Noto Sans TC", text: "Hello", fontSizePx: 48 });
    expect(width).toBeGreaterThan(0);
  });

  it("returns 0 for empty text without needing a real font lookup", async () => {
    const { id } = await createAndOpen();
    const width = await measurePresentationText(id, { family: "Noto Sans TC", text: "", fontSizePx: 48 });
    expect(width).toBe(0);
  });

  it("throws, naming the family, when the family is not embedded in the presentation", async () => {
    const { id } = await createAndOpen();
    await expect(
      measurePresentationText(id, { family: "Comic Sans MS", text: "Hi", fontSizePx: 48 }),
    ).rejects.toThrow(/Comic Sans MS/);
  });

  it("throws CoMotionError, not a native error, for an unembedded family", async () => {
    const { id } = await createAndOpen();
    await expect(measurePresentationText(id, { family: "Nope", text: "Hi", fontSizePx: 48 })).rejects.toBeInstanceOf(
      CoMotionError,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPresentationInfo } from "../src/presentation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPresentationInfo", () => {
  it("returns the presentation's name and canvas size on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ formatVersion: 1, name: "驗收用簡報", canvas: { width: 1280, height: 720 }, slides: [] }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchPresentationInfo()).resolves.toEqual({
      name: "驗收用簡報",
      canvas: { width: 1280, height: 720 },
    });
  });

  it("throws on a non-2xx response, rather than returning a fabricated default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchPresentationInfo()).rejects.toThrow("載入失敗：/api/presentation");
  });

  it("throws when the canvas size is invalid, rather than falling back to a made-up size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ formatVersion: 1, name: "測試", canvas: { width: 0, height: 720 } }), {
          status: 200,
        }),
      ),
    );

    await expect(fetchPresentationInfo()).rejects.toThrow("canvas 尺寸無效");
  });
});

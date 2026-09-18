// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it, vi } from "vitest";
import { DeckAssetResolver } from "../src/deck-asset-resolver.js";

describe("DeckAssetResolver", () => {
  it("fetches deck-local SVG resources through the deck client and replaces them with owned Blob URLs", async () => {
    const fetch = vi.fn(async (path: string) => new Response(path, { headers: { "content-type": "image/png" } }));
    const createObjectURL = vi
      .fn<(blob: Blob) => string>()
      .mockReturnValueOnce("blob:photo")
      .mockReturnValueOnce("blob:clip")
      .mockReturnValueOnce("blob:poster")
      .mockReturnValueOnce("blob:texture");
    const revokeObjectURL = vi.fn();
    const resolver = new DeckAssetResolver({ fetch }, { createObjectURL, revokeObjectURL });

    const markup = await resolver.resolveSvg(
      `<svg xmlns="http://www.w3.org/2000/svg">
        <image href="../assets/photo.png"/>
        <foreignObject><video xmlns="http://www.w3.org/1999/xhtml" src="../assets/clip.webm" poster="../assets/poster.png"/></foreignObject>
        <rect style="fill:url('../assets/texture.png')"/>
        <use href="#symbol"/><a href="https://example.com/">external</a>
      </svg>`,
      "slides/001.svg",
    );

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/raw/assets/photo.png",
      "/api/raw/assets/clip.webm",
      "/api/raw/assets/poster.png",
      "/api/raw/assets/texture.png",
    ]);
    expect(markup).toContain('href="blob:photo"');
    expect(markup).toContain('src="blob:clip"');
    expect(markup).toContain('poster="blob:poster"');
    expect(markup).toContain("url(&quot;blob:texture&quot;)");
    expect(markup).toContain('href="#symbol"');
    expect(markup).toContain('href="https://example.com/"');

    resolver.dispose();
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual([
      "blob:photo",
      "blob:clip",
      "blob:poster",
      "blob:texture",
    ]);
  });

  it("deduplicates a resource within one resolver and revokes replaced generations", async () => {
    const fetch = vi.fn(async () => new Response("asset"));
    const createObjectURL = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.fn();
    const resolver = new DeckAssetResolver({ fetch }, { createObjectURL, revokeObjectURL });

    const first = await resolver.resolveSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="../assets/a.png"/><image href="../assets/a.png"/></svg>',
      "slides/001.svg",
    );
    expect(first.match(/blob:first/g)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolver.reset();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
    await resolver.resolveSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="../assets/a.png"/></svg>', "slides/002.svg");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the slide renderable without falling back to an unauthenticated subrequest when an asset is missing", async () => {
    const resolver = new DeckAssetResolver(
      { fetch: async () => new Response("missing", { status: 404 }) },
      { createObjectURL: () => "blob:never", revokeObjectURL: () => undefined },
    );

    const markup = await resolver.resolveSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="../assets/missing.png"/></svg>', "slides/001.svg");
    expect(markup).toContain('href="data:,"');
    expect(markup).not.toContain("missing.png");
  });
});

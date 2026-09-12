// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCanvas } from "../src/canvas.js";
import type { CanvasController } from "../src/canvas.js";

// AC: after a live-reload push, scroll position (and, if one ever exists,
// zoom) must survive without a refresh. reload() (apps/web/src/canvas.ts)
// reassigns the existing iframe's `srcdoc` — it does not replace the
// element or touch its parent — so the scrollable element (this container,
// the one App.tsx's `.canvas` div hands to mountCanvas) is never touched by
// a reload at all. This test proves that property holds structurally
// rather than building any save/restore mechanism for it.
//
// There is no zoom feature anywhere in this codebase yet, so only scroll
// position is checked here.

const project = { name: "Test Deck", slides: ["slides/001.svg"] };
const slideMarkup = '<svg data-testid="slide"><circle r="1"/></svg>';

let container: HTMLElement;
let controller: CanvasController | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/presentation")) {
        return new Response(JSON.stringify(project), { status: 200 });
      }
      if (url.endsWith("/api/files/slides/001.svg")) {
        return new Response(slideMarkup, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  controller?.destroy();
  controller = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe("scroll position across a live-reload update", () => {
  it("keeps the canvas container's scroll offset unchanged after reload()", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    container.scrollTop = 240;
    container.scrollLeft = 80;
    expect(container.scrollTop).toBe(240);
    expect(container.scrollLeft).toBe(80);

    await controller.reload();

    expect(container.scrollTop).toBe(240);
    expect(container.scrollLeft).toBe(80);
  });

  it("reuses the same iframe element across reload(), never replacing it", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    const iframeBefore = container.querySelector("iframe");

    await controller.reload();

    const iframeAfter = container.querySelector("iframe");
    expect(iframeAfter).toBe(iframeBefore);
  });
});

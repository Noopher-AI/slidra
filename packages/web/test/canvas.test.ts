import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCanvas } from "../src/canvas.js";
import type { CanvasController } from "../src/canvas.js";

// Finding P1: slide markup must render inside a sandboxed, opaque-origin
// iframe rather than being injected into this document with innerHTML.
// The invariant under test is the sandbox token list itself — assert it
// directly rather than trusting the implementation comment.

const project = { name: "測試簡報", slides: ["slides/001.svg"] };
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

describe("mountCanvas", () => {
  it("renders the slide inside a sandboxed iframe, never allow-same-origin", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();

    const sandbox = iframe!.getAttribute("sandbox");
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("still delivers the fetched slide markup to the canvas", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain(slideMarkup);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCanvas } from "../src/canvas.js";
import type { CanvasController } from "../src/canvas.js";
import { slidePaintKey } from "../src/slide-paint-key.js";

// #303: live reload fires on every agent command, and a build issues
// dozens whose only visible effect is `<metadata>` (effects, notes,
// comments, transitions). Repainting the stage iframe for those blanked
// it for nothing — the flicker authors saw during generation. The stage
// must repaint only when the picture itself changes.

const NOTES = '<metadata><slidra:notes xmlns:slidra="https://slidra.app/ns/2026">Speaker notes</slidra:notes></metadata>';
const deck = { name: "Test Deck", slides: ["slides/001.svg", "slides/002.svg"] };
let markup: Record<string, string>;
let container: HTMLElement;
let controller: CanvasController | undefined;

function srcdoc(): string {
  return (container.querySelector("iframe") as HTMLIFrameElement).srcdoc;
}

beforeEach(() => {
  markup = {
    "slides/001.svg": '<svg data-testid="s1"><circle r="1"/></svg>',
    "slides/002.svg": '<svg data-testid="s2"></svg>',
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/presentation")) return new Response(JSON.stringify(deck), { status: 200 });
      const match = /\/api\/files\/(.+)$/.exec(url);
      if (match && markup[match[1]]) return new Response(markup[match[1]], { status: 200 });
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

describe("slidePaintKey", () => {
  it("strips every <metadata> block and trailing whitespace, nothing else", () => {
    expect(slidePaintKey(`<svg>${NOTES}<g id="a"/></svg>\n`)).toBe('<svg><g id="a"/></svg>');
    expect(slidePaintKey('<svg><metadata xmlns:x="y">a</metadata><g/><metadata>b</metadata></svg>')).toBe("<svg><g/></svg>");
    expect(slidePaintKey('<svg><g id="a"/></svg>')).not.toBe(slidePaintKey('<svg><g id="b"/></svg>'));
  });
});

describe("mountCanvas only repaints when the picture actually changes", () => {
  it("does not reset srcdoc when only <metadata> changes; a content change or page navigation does reset it", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    const painted = srcdoc();
    expect(painted).toContain('data-testid="s1"');

    // A note / effect / comment landing: same picture, no repaint — the
    // iframe still holds the document painted before the metadata arrived.
    markup["slides/001.svg"] = `<svg data-testid="s1">${NOTES}<circle r="1"/></svg>`;
    await controller.reload();
    expect(srcdoc()).toBe(painted);
    expect(srcdoc()).not.toContain("slidra:notes");

    // A real content change repaints (and carries whatever metadata is there).
    markup["slides/001.svg"] = `<svg data-testid="s1">${NOTES}<circle r="2"/></svg>`;
    await controller.reload();
    expect(srcdoc()).not.toBe(painted);
    expect(srcdoc()).toContain('r="2"');

    // Navigating to another slide always paints that slide.
    await controller.next();
    expect(srcdoc()).toContain('data-testid="s2"');

    // …and coming back repaints s1 even though its markup is unchanged
    // since it was last painted: the frame holds s2 now.
    await controller.previous();
    expect(srcdoc()).toContain('data-testid="s1"');
  });

  it("always repaints once the first real slide appears after a zero-slide deck's blank transparent page", async () => {
    const empty = { name: "Empty", slides: [] as string[] };
    let project: { name: string; slides: string[] } = empty;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) return new Response(JSON.stringify(project), { status: 200 });
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && markup[match[1]]) return new Response(markup[match[1]], { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    controller = mountCanvas(container);
    await controller.reload();
    expect(srcdoc()).toContain("background:transparent");

    project = deck;
    await controller.reload();
    expect(srcdoc()).toContain('data-testid="s1"');
  });
});

describe("in play mode, live reload only resets srcdoc when the picture actually changes", () => {
  function effectsRoute(): Response {
    return new Response(
      JSON.stringify({
        effects: [],
        steps: [],
        transition: { enter: { effect: "none", duration: 0 }, exit: { effect: "none", duration: 0 } },
      }),
      { status: 200 },
    );
  }

  it("keeps the currently playing document when only <metadata> changes; resets only on a content change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) return new Response(JSON.stringify(deck), { status: 200 });
        if (url.includes("/api/effects/")) return effectsRoute();
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && markup[match[1]]) return new Response(markup[match[1]], { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();
    const playing = srcdoc();
    expect(playing).toContain('data-testid="s1"');

    // An effect/notes change while playing: the running document stays.
    markup["slides/001.svg"] = `<svg data-testid="s1">${NOTES}<circle r="1"/></svg>`;
    await controller.reload();
    expect(srcdoc()).toBe(playing);

    // A real content change while playing repaints.
    markup["slides/001.svg"] = `<svg data-testid="s1">${NOTES}<circle r="2"/></svg>`;
    await controller.reload();
    expect(srcdoc()).not.toBe(playing);
    expect(srcdoc()).toContain('r="2"');
  });
});

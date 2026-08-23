import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOverview } from "../src/overview.js";
import type { CanvasController, CanvasState } from "../src/canvas.js";

// A fake CanvasController: overview.ts only needs subscribe() and
// showSlide() from the real controller (see AGENTS instructions — the seam
// is mountOverview's public behaviour, not canvas.ts internals). Kept
// minimal and hand-wired rather than mocking the whole module.
function fakeCanvas(initial: CanvasState): {
  controller: CanvasController;
  setState: (state: CanvasState) => void;
  showSlideCalls: number[];
} {
  const listeners = new Set<(state: CanvasState) => void>();
  let state = initial;
  const showSlideCalls: number[] = [];
  const controller: CanvasController = {
    reload: vi.fn(async () => {}),
    showSlide: vi.fn(async (index: number) => {
      showSlideCalls.push(index);
    }),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    destroy: vi.fn(),
  };
  return {
    controller,
    setState: (next) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
    showSlideCalls,
  };
}

// jsdom does not implement IntersectionObserver. This fake records every
// instance created so tests can trigger intersection manually, and mirrors
// the real API surface overview.ts uses: observe/unobserve/disconnect plus
// a callback invoked with entries.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed = new Set<Element>();
  constructor(public callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  triggerIntersect(el: Element): void {
    this.callback(
      [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      throw new Error(`unexpected fetch in this test: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe("mountOverview", () => {
  it("renders one overview-item per slide, in slides order, with a sandboxed thumbnail iframe", () => {
    const { controller } = fakeCanvas({ slides: ["slides/001.svg", "slides/002.svg"], currentIndex: 0 });

    mountOverview(container, controller);

    const list = container.querySelector("ol.overview-list");
    expect(list).not.toBeNull();

    const items = container.querySelectorAll("li.overview-item");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-index")).toBe("0");
    expect(items[1].getAttribute("data-index")).toBe("1");

    const firstButton = items[0].querySelector("button.overview-thumb");
    expect(firstButton).not.toBeNull();
    expect(firstButton!.getAttribute("aria-label")).toBe("第 1 頁");

    const firstFrame = items[0].querySelector("iframe.overview-frame");
    expect(firstFrame).not.toBeNull();
    expect(firstFrame!.getAttribute("sandbox")).toBe("");
  });

  it("marks only the current slide's <li> and <button>, and moves the mark when the index changes", () => {
    const { controller, setState } = fakeCanvas({
      slides: ["slides/001.svg", "slides/002.svg"],
      currentIndex: 0,
    });

    mountOverview(container, controller);

    const items = () => container.querySelectorAll("li.overview-item");
    expect(items()[0].classList.contains("overview-item-current")).toBe(true);
    expect(items()[0].querySelector("button")!.getAttribute("aria-current")).toBe("page");
    expect(items()[1].classList.contains("overview-item-current")).toBe(false);
    expect(items()[1].querySelector("button")!.hasAttribute("aria-current")).toBe(false);

    setState({ slides: ["slides/001.svg", "slides/002.svg"], currentIndex: 1 });

    expect(items()[0].classList.contains("overview-item-current")).toBe(false);
    expect(items()[1].classList.contains("overview-item-current")).toBe(true);
    expect(items()[1].querySelector("button")!.getAttribute("aria-current")).toBe("page");
  });

  it("clicking a thumbnail's button jumps the canvas to that slide", () => {
    const { controller, showSlideCalls } = fakeCanvas({
      slides: ["slides/001.svg", "slides/002.svg"],
      currentIndex: 0,
    });

    mountOverview(container, controller);

    const buttons = container.querySelectorAll("button.overview-thumb");
    (buttons[1] as HTMLButtonElement).click();

    expect(showSlideCalls).toEqual([1]);
  });

  it("only fetches and fills a thumbnail once its <li> is observed to intersect", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        fetchCalls.push(url);
        if (url === "/api/files/slides/001.svg") {
          return new Response('<svg data-testid="s1"></svg>', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { controller } = fakeCanvas({
      slides: ["slides/001.svg", "slides/002.svg"],
      currentIndex: 0,
    });

    mountOverview(container, controller);

    // Nothing fetched yet: no <li> has been reported as intersecting.
    expect(fetchCalls).toEqual([]);
    const items = container.querySelectorAll("li.overview-item");
    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toBe("");

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    observer.triggerIntersect(items[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCalls).toEqual(["/api/files/slides/001.svg"]);
    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="s1"');
    // The second slide was never observed intersecting, so it stays empty.
    expect((items[1].querySelector("iframe") as HTMLIFrameElement).srcdoc).toBe("");
  });

  it("shows an explicit Traditional Chinese message in the thumbnail when the slide fails to fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    mountOverview(container, controller);

    const item = container.querySelector("li.overview-item")!;
    const observer = FakeIntersectionObserver.instances.at(-1)!;
    observer.triggerIntersect(item);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = item.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("縮圖載入失敗");
  });

  it("does not refetch or reset an already-loaded thumbnail when only currentIndex changes", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        fetchCalls.push(String(input));
        return new Response('<svg data-testid="s1"></svg>', { status: 200 });
      }),
    );

    const { controller, setState } = fakeCanvas({
      slides: ["slides/001.svg", "slides/002.svg"],
      currentIndex: 0,
    });
    mountOverview(container, controller);

    const items = container.querySelectorAll("li.overview-item");
    const observer = FakeIntersectionObserver.instances.at(-1)!;
    observer.triggerIntersect(items[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCalls).toHaveLength(1);

    setState({ slides: ["slides/001.svg", "slides/002.svg"], currentIndex: 1 });

    expect(fetchCalls).toHaveLength(1);
    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="s1"');
  });

  it("destroy() removes the list from the container and stops responding to further canvas updates", () => {
    const { controller, setState } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);

    expect(container.querySelector("ol.overview-list")).not.toBeNull();

    overview.destroy();

    expect(container.querySelector("ol.overview-list")).toBeNull();
    expect(() => setState({ slides: ["slides/001.svg", "slides/002.svg"], currentIndex: 1 })).not.toThrow();
  });
});

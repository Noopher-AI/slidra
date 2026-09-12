import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountOverview } from "../src/overview.js";
import { invalidateSlideEffectPlans } from "../src/effects.js";
import type { CanvasController, CanvasState } from "../src/canvas.js";

// A fake CanvasController: overview.ts only needs subscribe() and
// showSlide() from the real controller (see AGENTS instructions — the seam
// is mountOverview's public behaviour, not canvas.ts internals). Kept
// minimal and hand-wired rather than mocking the whole module.
function fakeCanvas(
  initial: CanvasState,
  options: { runCommandResult?: { ok: boolean; message: string } } = {},
): {
  controller: CanvasController;
  setState: (state: CanvasState) => void;
  showSlideCalls: number[];
  runCommandCalls: Array<{ name: string; input: Record<string, unknown> }>;
} {
  const listeners = new Set<(state: CanvasState) => void>();
  let state = initial;
  const showSlideCalls: number[] = [];
  const runCommandCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const runCommandResult = options.runCommandResult ?? { ok: true, message: "ok" };
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
    // [E2.T3]: overview.ts's drag/drop reordering calls this directly
    // (T3 plan §7 決定 7 — no separate hook needed, the controller it
    // already holds is enough). The rest of `CanvasController`'s surface
    // (play/exitPlay/focusPlayer/stepPlayer/beginTextEdit/importAsset/
    // reportError) stays unimplemented here, matching this file's existing
    // convention — packages/web/tsconfig.json excludes `test/` from
    // type-checking, and nothing above this ticket ever needed them either.
    runCommand: vi.fn(async (name: string, input: Record<string, unknown>) => {
      runCommandCalls.push({ name, input });
      return runCommandResult;
    }),
  } as CanvasController;
  return {
    controller,
    setState: (next) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
    showSlideCalls,
    runCommandCalls,
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

// mountOverview now always asks /api/presentation for the canvas size
// (thumbnail aspect ratio); every stub answers it so that fetch never
// rejects unhandled in tests that are about something else.
function presentationResponse(): Response {
  return new Response(
    JSON.stringify({ formatVersion: 1, name: "測試", canvas: { width: 1280, height: 720 }, slides: [] }),
    { status: 200 },
  );
}

// [E5.T11]: a `GET /api/effects/<slidePath>` response (effects.ts's
// `fetchFresh` wire shape) carrying `effectCount` items — content beyond
// the count is irrelevant to overview.ts, which only ever reads
// `plan.effects.length`.
function effectsResponse(effectCount: number): Response {
  const effects = Array.from({ length: effectCount }, (_, i) => ({
    target: `el-${i}`,
    family: "enter",
    effect: "appear",
    start: "on-click",
    duration: 0.6,
    delay: 0,
    index: i + 1,
  }));
  return new Response(
    JSON.stringify({
      effects,
      steps: [],
      transition: { enter: { effect: "none", duration: 0 }, exit: { effect: "none", duration: 0 } },
    }),
    { status: 200 },
  );
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  FakeIntersectionObserver.instances = [];
  // effects.ts's fetch cache is a module-level singleton, shared across
  // every test in this file (and whatever ran before it) — without this,
  // a test earlier in the file order could leave a resolved promise
  // cached under a slide path a later test reuses (e.g. "slides/001.svg"),
  // and that later test would silently observe the earlier test's cached
  // count instead of ever calling its own fetch stub.
  invalidateSlideEffectPlans();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === "/api/presentation") return presentationResponse();
      if (url.startsWith("/api/effects/")) return effectsResponse(0);
      throw new Error(`unexpected fetch in this test: ${url}`);
    }),
  );
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe("mountOverview", () => {
  it("reads the presentation's canvas size and drives the thumbnail box's aspect ratio from it (not a hardcoded 16:9)", async () => {
    // A 4:3 presentation — the shape style.css's old hardcoded 16:9 got
    // wrong. Expected value comes from project.json's own canvas numbers.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") {
          return new Response(
            JSON.stringify({ formatVersion: 1, name: "測試", canvas: { width: 1024, height: 768 }, slides: [] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    mountOverview(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const list = container.querySelector("ol.overview-list") as HTMLElement;
    expect(list.style.getPropertyValue("--overview-aspect-ratio")).toBe("1024 / 768");
  });

  it("refresh() re-reads the canvas size, so an external edit to project.json's canvas re-shapes the thumbnails", async () => {
    // The live-reload path: an external edit can change canvas.width/height
    // without touching the slides list. refresh() is the hook live reload
    // already calls, so it must re-apply the ratio too — not leave the one
    // read at mount frozen until a full page reload.
    let canvasSize = { width: 1280, height: 720 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") {
          return new Response(
            JSON.stringify({ formatVersion: 1, name: "測試", canvas: canvasSize, slides: [] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const list = container.querySelector("ol.overview-list") as HTMLElement;
    expect(list.style.getPropertyValue("--overview-aspect-ratio")).toBe("1280 / 720");

    // The external edit flips the presentation to portrait; live reload
    // fires refresh().
    canvasSize = { width: 720, height: 1280 };
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(list.style.getPropertyValue("--overview-aspect-ratio")).toBe("720 / 1280");
  });

  it("renders one overview-item per slide, in slides order, with a placeholder button and no iframe yet", () => {
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
    expect(firstButton!.getAttribute("aria-label")).toBe("Slide 1");

    // No iframe until the <li> intersects — the acceptance criterion is
    // that far-away thumbnails are not materialised at all, and a browsing
    // context per slide at mount would defeat that even with empty srcdoc.
    // (The sandbox="" posture at creation time is asserted in the
    // materialisation test below.)
    expect(items[0].querySelector("iframe")).toBeNull();
    expect(items[1].querySelector("iframe")).toBeNull();
  });

  it("renders a page number in every <li> before any thumbnail is materialised (page numbers are cheap, thumbnails are not — #52 vs #27)", () => {
    const { controller } = fakeCanvas({
      slides: ["slides/001.svg", "slides/002.svg", "slides/003.svg"],
      currentIndex: 0,
    });

    mountOverview(container, controller);

    const numbers = container.querySelectorAll(".overview-number");
    expect(numbers).toHaveLength(3);
    expect(Array.from(numbers).map((el) => el.textContent)).toEqual(["1", "2", "3"]);

    // The acceptance point this test exists for: numbers must not be a
    // side effect of materialising thumbnails. No <li> has intersected
    // yet (no observer callback has fired), so no iframe exists at all —
    // if page numbers were ever added by eagerly building every thumbnail,
    // this count would be 3 instead of 0.
    expect(container.querySelectorAll("iframe.overview-frame")).toHaveLength(0);
  });

  it("renders ✦ n effect-count badges per slide, independent of thumbnail lazy-loading (03-UI_RATIONALE.md §B)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url === "/api/effects/slides/001.svg") return effectsResponse(0);
        if (url === "/api/effects/slides/003.svg") return effectsResponse(3);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { controller } = fakeCanvas({
      slides: ["slides/001.svg", "slides/003.svg"],
      currentIndex: 0,
    });
    mountOverview(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const items = container.querySelectorAll("li.overview-item");
    expect(items[0].querySelector(".overview-effect-badge")!.textContent).toBe("");
    expect(items[1].querySelector(".overview-effect-badge")!.textContent).toBe("✦ 3");

    // Neither <li> was ever observed intersecting — the badge must not
    // depend on thumbnail materialisation the way the iframe does.
    expect(items[0].querySelector("iframe")).toBeNull();
    expect(items[1].querySelector("iframe")).toBeNull();
  });

  it("refresh() re-reads each slide's effect count once the plan cache has been invalidated (the same sequencing canvas.ts's reload() already guarantees before App.tsx calls refresh())", async () => {
    let slide1EffectCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url === "/api/effects/slides/001.svg") return effectsResponse(slide1EffectCount);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const badge = container.querySelector(".overview-effect-badge")!;
    expect(badge.textContent).toBe("");

    // An agent's `effect add` lands on disk; canvas.ts's reload() (fired by
    // the same presentation-changed event, before it calls this module's
    // refresh()) already invalidates effects.ts's cache, so the next
    // fetchSlideEffectPlan() call here is never served the stale plan.
    slide1EffectCount = 1;
    invalidateSlideEffectPlans();
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(badge.textContent).toBe("✦ 1");
  });

  it("a newer refresh()'s effect count always wins over an older one still in flight, regardless of resolve order", async () => {
    let resolveOlderRefreshFetch!: (response: Response) => void;
    const olderRefreshFetchPromise = new Promise<Response>((resolve) => {
      resolveOlderRefreshFetch = resolve;
    });
    let refreshFetchCount = 0;
    let holdRefreshFetches = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url !== "/api/effects/slides/001.svg") throw new Error(`unexpected fetch: ${url}`);
        if (!holdRefreshFetches) return effectsResponse(0);
        refreshFetchCount += 1;
        return refreshFetchCount === 1 ? olderRefreshFetchPromise : effectsResponse(2);
      }),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const badge = container.querySelector(".overview-effect-badge")!;
    expect(badge.textContent).toBe("");

    // Each refresh() below is preceded by its own cache invalidation — the
    // same thing canvas.ts's reload() does before every live-reload
    // refresh() in production — so each one starts its own independent
    // fetch instead of sharing (or blocking on) the other's cached promise.
    holdRefreshFetches = true;
    invalidateSlideEffectPlans();
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    invalidateSlideEffectPlans();
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(badge.textContent).toBe("✦ 2");

    // Only now does the older, slower refresh's fetch resolve. Its result
    // must be discarded — it must not overwrite what the newer refresh
    // already painted.
    resolveOlderRefreshFetch(effectsResponse(9));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(badge.textContent).toBe("✦ 2");
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

  it("only materialises a thumbnail's iframe (and fetches its slide) once its <li> is observed to intersect", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url.startsWith("/api/effects/")) return effectsResponse(0);
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

    // Nothing fetched yet, and — the actual acceptance criterion (#27) — no
    // iframe exists yet either: an already-created iframe with an empty
    // srcdoc still costs a browsing context per slide, which is exactly
    // what lazy loading is supposed to avoid.
    expect(fetchCalls).toEqual([]);
    const items = container.querySelectorAll("li.overview-item");
    expect(items[0].querySelector("iframe")).toBeNull();
    expect(items[1].querySelector("iframe")).toBeNull();

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    observer.triggerIntersect(items[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchCalls).toEqual(["/api/files/slides/001.svg"]);
    const frame = items[0].querySelector("iframe.overview-frame") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    // The zero-token sandbox posture applies from the moment the iframe
    // exists, not as a later touch-up.
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.srcdoc).toContain('data-testid="s1"');
    // The second slide was never observed intersecting: still no iframe.
    expect(items[1].querySelector("iframe")).toBeNull();
  });

  it("shows an explicit Traditional Chinese message in the thumbnail when the slide fails to fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input) === "/api/presentation") return presentationResponse();
        return new Response("not found", { status: 404 });
      }),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    mountOverview(container, controller);

    const item = container.querySelector("li.overview-item")!;
    const observer = FakeIntersectionObserver.instances.at(-1)!;
    observer.triggerIntersect(item);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = item.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.srcdoc).toContain("Thumbnail failed to load");
  });

  it("does not refetch or reset an already-loaded thumbnail when only currentIndex changes", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url.startsWith("/api/effects/")) return effectsResponse(0);
        fetchCalls.push(url);
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

  it("refresh() refetches already-loaded thumbnails but leaves unloaded ones empty", async () => {
    let slide1Markup = '<svg data-testid="s1-old"></svg>';
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        fetchCalls.push(url);
        if (url === "/api/files/slides/001.svg") {
          return new Response(slide1Markup, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    // Slides array is unchanged across the refresh — this is the live-reload
    // case an external edit to a slide's SVG produces: project.json's
    // `slides` list never moves, only the markup a slide path serves does.
    const { controller } = fakeCanvas({
      slides: ["slides/001.svg", "slides/002.svg"],
      currentIndex: 0,
    });

    const overview = mountOverview(container, controller);
    const items = container.querySelectorAll("li.overview-item");
    const observer = FakeIntersectionObserver.instances.at(-1)!;

    // Only slide 1's thumbnail is materialised; slide 2's is not.
    observer.triggerIntersect(items[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="s1-old"');
    expect(items[1].querySelector("iframe")).toBeNull();

    // The external editor changes slide 1's markup without touching
    // project.json's slides list.
    slide1Markup = '<svg data-testid="s1-new"></svg>';
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="s1-new"');
    // Slide 2 was never materialised, so refresh() must neither fetch it
    // nor conjure its iframe — that would defeat lazy loading.
    expect(items[1].querySelector("iframe")).toBeNull();
    expect(fetchCalls.filter((url) => url === "/api/files/slides/002.svg")).toEqual([]);
  });

  it("a newer refresh()'s result always wins over an older one still in flight, regardless of resolve order", async () => {
    // Two overlapping refresh() calls on the same index (back-to-back live
    // reload events, e.g. an agent editing twice in quick succession). The
    // older refresh's fetch is held open with its own dedicated promise
    // (never reused — a settled promise can't go back to pending) and only
    // resolves after the newer refresh's fetch has already settled.
    let resolveOlderRefreshFetch!: (response: Response) => void;
    const olderRefreshFetchPromise = new Promise<Response>((resolve) => {
      resolveOlderRefreshFetch = resolve;
    });
    let refreshFetchCount = 0;
    let holdRefreshFetches = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url !== "/api/files/slides/001.svg") throw new Error(`unexpected fetch: ${url}`);
        if (!holdRefreshFetches) {
          // The initial materialisation fetch, before the race under test
          // even starts — resolves immediately, no part of the race.
          return new Response('<svg data-testid="initial"></svg>', { status: 200 });
        }
        refreshFetchCount += 1;
        // The first refresh() call below is the older one; hold its fetch
        // open. The second refresh() call's fetch resolves immediately,
        // so it settles and paints first.
        return refreshFetchCount === 1
          ? olderRefreshFetchPromise
          : new Response('<svg data-testid="newer"></svg>', { status: 200 });
      }),
    );

    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);
    const items = container.querySelectorAll("li.overview-item");
    const observer = FakeIntersectionObserver.instances.at(-1)!;

    // Materialise the thumbnail first so refresh() has something to refetch.
    observer.triggerIntersect(items[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="initial"');

    // Now start the race: the older refresh() call's fetch is held open by
    // olderRefreshFetchPromise above; the newer one resolves immediately.
    holdRefreshFetches = true;
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="newer"');

    // Only now does the older, slower refresh's fetch resolve. Its result
    // must be discarded — it must not overwrite what the newer refresh
    // already painted.
    resolveOlderRefreshFetch(new Response('<svg data-testid="older"></svg>', { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).toContain('data-testid="newer"');
    expect((items[0].querySelector("iframe") as HTMLIFrameElement).srcdoc).not.toContain('data-testid="older"');
  });

  it("destroy() removes the list from the container and stops responding to further canvas updates", () => {
    const { controller, setState } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);

    expect(container.querySelector("ol.overview-list")).not.toBeNull();

    overview.destroy();

    expect(container.querySelector("ol.overview-list")).toBeNull();
    expect(() => setState({ slides: ["slides/001.svg", "slides/002.svg"], currentIndex: 1 })).not.toThrow();
  });

  // [E2.T3] 拖曳排序。jsdom 沒有 DragEvent／DataTransfer 建構子
  // （已驗證：`new window.DragEvent(...)` 會丟「not a constructor」），所以
  // 這裡用一般 `Event` 手動掛上 `dataTransfer`／`clientX`／`clientY` 屬性
  // 後 dispatch——overview.ts 的監聽器只讀這幾個屬性，不會注意到事件的真
  // 實建構子是什麼。真的原生 HTML5 拖放（含視覺的插入線顏色）在
  // `e2e/page-management.test.ts` 用真 Chromium 驗證。
  describe("拖曳排序", () => {
    function fakeDataTransfer(): { setData: (type: string, value: string) => void; getData: (type: string) => string } {
      const store: Record<string, string> = {};
      return {
        setData: (type, value) => {
          store[type] = value;
        },
        getData: (type) => store[type] ?? "",
      };
    }

    function fireDrag(
      el: Element,
      type: string,
      options: { dataTransfer: unknown; clientY?: number },
    ): void {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        dataTransfer?: unknown;
        clientX?: number;
        clientY?: number;
      };
      event.dataTransfer = options.dataTransfer;
      event.clientX = 0;
      event.clientY = options.clientY ?? 0;
      el.dispatchEvent(event);
    }

    function stubRect(el: Element, top: number, height: number): void {
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        top,
        bottom: top + height,
        left: 0,
        right: 100,
        width: 100,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      });
    }

    async function tick(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const FOUR_SLIDES = ["slides/001.svg", "slides/002.svg", "slides/003.svg", "slides/004.svg"];

    it("drop 在目標項上緣：送 slide move 且 newIndex 正確；成功後 reload()+showSlide(newIndex)（T3 plan §3.8/§7 決定 6）", async () => {
      const { controller, runCommandCalls, showSlideCalls } = fakeCanvas({ slides: FOUR_SLIDES, currentIndex: 0 });
      mountOverview(container, controller);
      await tick();

      const items = container.querySelectorAll<HTMLLIElement>(".overview-item");
      stubRect(items[2], 200, 80); // top half: [200, 240)

      const dt = fakeDataTransfer();
      fireDrag(items[0], "dragstart", { dataTransfer: dt });
      fireDrag(items[2], "dragover", { dataTransfer: dt, clientY: 205 }); // top half -> to=2
      fireDrag(items[2], "drop", { dataTransfer: dt, clientY: 205 });
      fireDrag(items[0], "dragend", { dataTransfer: dt });
      await tick();

      // from=0, to=2 -> newIndex = to>from ? to-1 : to = 1.
      expect(runCommandCalls).toEqual([{ name: "slide move", input: { slidePath: "slides/001.svg", newIndex: 1 } }]);
      expect(showSlideCalls).toEqual([1]);
    });

    it("拖到目標項下緣：插在它後面，newIndex 也正確（T3 plan §5-B 的期望結果 [2,3,1,4]）", async () => {
      const { controller, runCommandCalls, showSlideCalls } = fakeCanvas({ slides: FOUR_SLIDES, currentIndex: 0 });
      mountOverview(container, controller);
      await tick();

      const items = container.querySelectorAll<HTMLLIElement>(".overview-item");
      stubRect(items[2], 200, 80); // bottom half: [240, 280)

      const dt = fakeDataTransfer();
      fireDrag(items[0], "dragstart", { dataTransfer: dt });
      fireDrag(items[2], "dragover", { dataTransfer: dt, clientY: 275 }); // bottom half -> to=3
      fireDrag(items[2], "drop", { dataTransfer: dt, clientY: 275 });
      fireDrag(items[0], "dragend", { dataTransfer: dt });
      await tick();

      // from=0, to=3 -> newIndex = to-1 = 2.
      expect(runCommandCalls).toEqual([{ name: "slide move", input: { slidePath: "slides/001.svg", newIndex: 2 } }]);
      expect(showSlideCalls).toEqual([2]);
    });

    it("no-op：拖到自己身上，不畫插入線、不送命令", async () => {
      const { controller, runCommandCalls } = fakeCanvas({ slides: FOUR_SLIDES, currentIndex: 0 });
      mountOverview(container, controller);
      await tick();

      const items = container.querySelectorAll<HTMLLIElement>(".overview-item");
      stubRect(items[0], 0, 80);

      const dt = fakeDataTransfer();
      fireDrag(items[0], "dragstart", { dataTransfer: dt });
      fireDrag(items[0], "dragover", { dataTransfer: dt, clientY: 5 }); // to=0=from
      expect(container.querySelector(".overview-drop-line")).toBeNull();
      fireDrag(items[0], "drop", { dataTransfer: dt, clientY: 5 });
      fireDrag(items[0], "dragend", { dataTransfer: dt });
      await tick();

      expect(runCommandCalls).toEqual([]);
    });

    it("no-op：拖到自己的正下一個位置，不畫插入線、不送命令", async () => {
      const { controller, runCommandCalls } = fakeCanvas({ slides: FOUR_SLIDES, currentIndex: 0 });
      mountOverview(container, controller);
      await tick();

      const items = container.querySelectorAll<HTMLLIElement>(".overview-item");
      stubRect(items[1], 80, 80);

      const dt = fakeDataTransfer();
      fireDrag(items[0], "dragstart", { dataTransfer: dt });
      fireDrag(items[1], "dragover", { dataTransfer: dt, clientY: 85 }); // top half of item1 -> to=1=from+1
      expect(container.querySelector(".overview-drop-line")).toBeNull();
      fireDrag(items[1], "drop", { dataTransfer: dt, clientY: 85 });
      fireDrag(items[0], "dragend", { dataTransfer: dt });
      await tick();

      expect(runCommandCalls).toEqual([]);
    });

    it("格式錯誤：drop 時 dataTransfer 讀不到來源索引，放棄這次 drop，不猜一個索引（T3 plan §4.2）", async () => {
      const { controller, runCommandCalls } = fakeCanvas({ slides: FOUR_SLIDES, currentIndex: 0 });
      mountOverview(container, controller);
      await tick();

      const items = container.querySelectorAll<HTMLLIElement>(".overview-item");
      stubRect(items[2], 200, 80);

      const dt = fakeDataTransfer();
      fireDrag(items[0], "dragstart", { dataTransfer: dt }); // sets store["text/plain"] = "0"
      fireDrag(items[2], "dragover", { dataTransfer: dt, clientY: 205 });
      // Corrupt the transfer between dragover and drop — a real-world stand-in
      // for "the browser genuinely has no parseable payload at drop time".
      (dt as { getData: () => string }).getData = () => "";
      fireDrag(items[2], "drop", { dataTransfer: dt, clientY: 205 });
      fireDrag(items[0], "dragend", { dataTransfer: dt });
      await tick();

      expect(runCommandCalls).toEqual([]);
    });
  });
});


describe("縮圖只在畫面真的變了才重畫 (#303)", () => {
  it("refresh() 遇到只有 <metadata> 變動的投影片不重設 srcdoc；內容變了才重設", async () => {
    const NOTES = '<metadata><comot:notes xmlns:comot="https://co-motion.dev/ns">講稿</comot:notes></metadata>';
    let s1 = '<svg data-testid="s1"><circle r="1"/></svg>';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "/api/presentation") return presentationResponse();
        if (url.startsWith("/api/effects/")) return effectsResponse(0);
        if (url === "/api/files/slides/001.svg") return new Response(s1, { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { controller } = fakeCanvas({ slides: ["slides/001.svg"], currentIndex: 0 });
    const overview = mountOverview(container, controller);
    const item = container.querySelector("li.overview-item")!;
    FakeIntersectionObserver.instances.at(-1)!.triggerIntersect(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = item.querySelector("iframe.overview-frame") as HTMLIFrameElement;
    const painted = frame.srcdoc;
    expect(painted).toContain('data-testid="s1"');

    // A note landing (an agent's `slide notes set`): same picture, no repaint.
    s1 = `<svg data-testid="s1">${NOTES}<circle r="1"/></svg>`;
    invalidateSlideEffectPlans();
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.srcdoc).toBe(painted);
    expect(frame.srcdoc).not.toContain("comot:notes");

    // A real content change repaints.
    s1 = `<svg data-testid="s1">${NOTES}<circle r="2"/></svg>`;
    invalidateSlideEffectPlans();
    overview.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame.srcdoc).not.toBe(painted);
    expect(frame.srcdoc).toContain('r="2"');
    overview.destroy();
  });
});

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

  // Finding P2: destroy() must remove the iframe it created, not just flip
  // a flag. React StrictMode runs every effect as setup -> cleanup ->
  // setup, so a destroy() that leaves the iframe behind produces two
  // iframes stacked in the container, with the empty first one on top —
  // the canvas looks blank even though the real frame loaded underneath.

  it("leaves no iframe in the container after destroy", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    controller.destroy();

    expect(container.querySelector("iframe")).toBeNull();
  });

  it("holds exactly one iframe after the StrictMode mount -> destroy -> mount sequence", async () => {
    const first = mountCanvas(container);
    await first.reload();
    first.destroy();

    controller = mountCanvas(container);
    await controller.reload();

    const iframes = container.querySelectorAll("iframe");
    expect(iframes).toHaveLength(1);

    const sandbox = iframes[0].getAttribute("sandbox");
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("does not resurrect a frame or throw when reload() is called after destroy()", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    controller.destroy();

    await expect(controller.reload()).resolves.toBeUndefined();
    expect(container.querySelector("iframe")).toBeNull();
  });

  // Ticket #11: a `srcdoc` document resolves relative URLs against the
  // *parent* document's URL, not the slide's own virtual location, which is
  // why `href="../assets/photo.png"` inside `slides/001.svg` would
  // otherwise resolve to the wrong place. Injecting a `<base>` pointing at
  // the slide's own directory inside the byte-preserving `/api/raw/` path
  // space makes the browser's own resolution do the right thing, without
  // touching the (untrusted, ADR-0003) slide bytes themselves.
  it("injects a <base> pointing at the slide's own directory inside /api/raw/", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    const parsed = new DOMParser().parseFromString(iframe.srcdoc, "text/html");
    const base = parsed.querySelector("base");

    expect(base).not.toBeNull();
    expect(base!.getAttribute("href")).toBe("/api/raw/slides/");
  });

  // Fix 2 (ticket #5, final round): mountCanvas fires a reload() on mount,
  // and live reload fires another on the stream's `open` — those two
  // overlap immediately, and nothing orders them. A slower earlier request
  // resolving after a faster later one must not be allowed to paint stale
  // content over what the later, authoritative request already applied.
  it("discards an earlier, slower reload's result once a later reload has already applied its own", async () => {
    const staleMarkup = '<svg data-testid="stale"></svg>';
    const freshMarkup = '<svg data-testid="fresh"></svg>';
    let slideFetchCount = 0;
    // Left unresolved until the test explicitly settles it, after the
    // later (faster) reload below has already completed and painted —
    // this is what lets the earlier call still be genuinely in flight at
    // that point, rather than having already bailed out at an earlier
    // await for unrelated reasons.
    let resolveStaleFetch!: (response: Response) => void;
    const staleFetchPromise = new Promise<Response>((resolve) => {
      resolveStaleFetch = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          slideFetchCount += 1;
          // mountCanvas's own `void reload()` on mount is the earlier
          // call, so it is always the first to reach this fetch.
          return slideFetchCount === 1 ? staleFetchPromise : new Response(freshMarkup, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    // The earlier call: let it run far enough that it has already issued
    // its (now pending) slide fetch before the later call starts.
    controller = mountCanvas(container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slideFetchCount).toBe(1);

    // The later call: its own fetches resolve immediately, so it finishes
    // and paints while the earlier call above is still awaiting
    // staleFetchPromise — exactly mount's reload() racing live reload's
    // `open`-triggered reload().
    await controller.reload();
    expect(slideFetchCount).toBe(2);

    // Only now does the earlier, slower call's fetch resolve. Its result
    // must be discarded, not painted over what the later call already
    // applied.
    resolveStaleFetch(new Response(staleMarkup, { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain(freshMarkup);
    expect(iframe.srcdoc).not.toContain(staleMarkup);
  });

  it("leaves the wrapper document unchanged (no <base>) when the presentation has zero slides", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify({ name: "空簡報", slides: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();

    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.srcdoc).not.toContain("<base");
    expect(iframe.srcdoc).toContain("此簡報沒有投影片");
  });
});

// Ticket #25: the canvas owns the selected-slide index, not React
// (ADR-0001/ADR-0002). These tests drive a three-slide presentation.

const deck = {
  name: "三頁簡報",
  slides: ["slides/001.svg", "slides/002.svg", "slides/003.svg"],
};
const deckMarkup: Record<string, string> = {
  "slides/001.svg": '<svg data-testid="s1"></svg>',
  "slides/002.svg": '<svg data-testid="s2"></svg>',
  "slides/003.svg": '<svg data-testid="s3"></svg>',
};

function stubDeck(project: { name: string; slides: string[] } = deck): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/presentation")) {
        return new Response(JSON.stringify(project), { status: 200 });
      }
      const match = /\/api\/files\/(.+)$/.exec(url);
      if (match && deckMarkup[match[1]]) {
        return new Response(deckMarkup[match[1]], { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function srcdoc(): string {
  return (container.querySelector("iframe") as HTMLIFrameElement).srcdoc;
}

describe("mountCanvas 的多頁換頁", () => {
  it("一開始顯示第一頁，狀態的索引是 0", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    expect(srcdoc()).toContain('data-testid="s1"');

    let state = { slides: [] as string[], currentIndex: -2 };
    const unsubscribe = controller.subscribe((next) => {
      state = next;
    });
    unsubscribe();

    expect(state.slides).toEqual(deck.slides);
    expect(state.currentIndex).toBe(0);
  });

  it("next() 往後翻，previous() 往前翻", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    await controller.next();
    expect(srcdoc()).toContain('data-testid="s2"');

    await controller.next();
    expect(srcdoc()).toContain('data-testid="s3"');

    await controller.previous();
    expect(srcdoc()).toContain('data-testid="s2"');
  });

  it("在最後一頁 next() 不動、在第一頁 previous() 不動，都不拋錯", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    await expect(controller.previous()).resolves.toBeUndefined();
    expect(srcdoc()).toContain('data-testid="s1"');

    await controller.showSlide(2);
    await expect(controller.next()).resolves.toBeUndefined();
    expect(srcdoc()).toContain('data-testid="s3"');
  });

  it("showSlide() 索引越界時拋錯", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    await expect(controller.showSlide(3)).rejects.toThrow();
    await expect(controller.showSlide(-1)).rejects.toThrow();
  });

  it("每一頁都注入指向自己目錄的 <base>", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.next();

    const parsed = new DOMParser().parseFromString(srcdoc(), "text/html");
    expect(parsed.querySelector("base")!.getAttribute("href")).toBe("/api/raw/slides/");
  });

  it("reload() 保留目前選頁，不跳回第一頁", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.showSlide(2);

    await controller.reload();
    expect(srcdoc()).toContain('data-testid="s3"');
  });

  it("reload() 後投影片變少時，選頁被夾到最後一頁", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.showSlide(2);

    stubDeck({ name: "變短的簡報", slides: ["slides/001.svg", "slides/002.svg"] });
    await controller.reload();
    expect(srcdoc()).toContain('data-testid="s2"');
  });

  it("subscribe() 當下立即以現值呼叫一次，unsubscribe 後不再收到通知", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    const seen: number[] = [];
    const unsubscribe = controller.subscribe((state) => seen.push(state.currentIndex));
    expect(seen).toEqual([0]);

    await controller.next();
    expect(seen).toEqual([0, 1]);

    unsubscribe();
    await controller.next();
    expect(seen).toEqual([0, 1]);
  });

  it("沒有投影片時，狀態的索引是 -1，且翻頁不拋錯", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify({ name: "空簡報", slides: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();

    let index = -2;
    controller.subscribe((state) => {
      index = state.currentIndex;
    })();
    expect(index).toBe(-1);

    await expect(controller.next()).resolves.toBeUndefined();
    await expect(controller.previous()).resolves.toBeUndefined();
    expect(srcdoc()).toContain("此簡報沒有投影片");
  });

  // Same generation guard as reload(): rapid arrow presses issue
  // overlapping slide fetches, and a slower earlier one must never paint
  // over the newer page the author actually asked for.
  it("快速連續翻頁時，較慢的舊請求不得覆蓋較新的結果", async () => {
    let resolveSlowSecond!: (response: Response) => void;
    const slowSecond = new Promise<Response>((resolve) => {
      resolveSlowSecond = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(deck), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/002.svg")) return slowSecond;
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && deckMarkup[match[1]]) {
          return new Response(deckMarkup[match[1]], { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();

    const pendingSecond = controller.next();
    await controller.next();
    expect(srcdoc()).toContain('data-testid="s3"');

    resolveSlowSecond(new Response(deckMarkup["slides/002.svg"], { status: 200 }));
    await pendingSecond;

    expect(srcdoc()).toContain('data-testid="s3"');
    expect(srcdoc()).not.toContain('data-testid="s2"');
  });
});

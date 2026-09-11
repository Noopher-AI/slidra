import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCanvas } from "../src/canvas.js";
import type { CanvasController, CanvasState, OverlayState } from "../src/canvas.js";

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

  // ADR-0011 / #56: view mode now carries allow-scripts (for the selection
  // runtime's hit reporting) but must never carry allow-same-origin — the
  // pair together would let the iframe's own script escape its sandbox.
  it("view-mode iframe 的 sandbox 是 allow-scripts，且不含 allow-same-origin", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    const iframe = container.querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
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

    // #200: render() now notifies a second time once it has parsed the new
    // slide's model (CanvasState.pageStyle depends on it, and — unlike
    // every other field — has no selection change to piggyback a notify()
    // on). One `next()` therefore reports the new index twice: once
    // eagerly (index/selection reset, same as before this ticket) and once
    // more once the slide model is ready. Both carry `currentIndex: 1`, so
    // this array is an honest count of *notifications*, not evidence of a
    // second navigation.
    await controller.next();
    expect(seen).toEqual([0, 1, 1]);

    unsubscribe();
    await controller.next();
    expect(seen).toEqual([0, 1, 1]);
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

// Ticket #28: play mode (C2/C3/C4 in the design doc). The runtime itself
// only really runs in a real browser (jsdom does not execute `srcdoc`
// scripts), so these tests stay at the seam this module owns: what goes
// into the play iframe's sandbox and srcdoc, and how canvas.ts reacts to
// postMessage events the runtime would send.

const NS = 'xmlns:comot="https://co-motion.dev/ns"';
const playDeck = { name: "播放測試簡報", slides: ["slides/001.svg", "slides/002.svg"] };
const playDeckMarkup: Record<string, string> = {
  "slides/001.svg": `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="el-a" family="enter" effect="fade" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="el-a"/>
  <rect id="el-bg"/>
</svg>`,
  "slides/002.svg": '<svg data-testid="s2"><rect id="el-b"/></svg>',
};

// [E4.T7]: `render()`/`renderPlay()` both now fetch a slide's effect plan
// from `GET /api/effects/<path>` (`fetchSlideEffectPlan`) instead of
// deriving it locally from the already-fetched markup — every fetch mock
// in this file that exercises play mode or the animate panel must answer
// that route too, or `computePlayerPlan`'s fetch rejects and the test
// falls into the same "effect list failed to parse" fallback path a
// genuinely broken deck would (see the "效果清單無法解析時" test below,
// which relies on exactly that fallback — deliberately, via its own
// `/api/effects/` mock returning a non-2xx response).
interface EffectRouteFixture {
  target: string;
  family: string;
  effect: string;
  start: string;
  duration?: number;
  delay?: number;
}
const DEFAULT_TRANSITION_FIXTURE = {
  enter: { effect: "none", duration: 0.6 },
  exit: { effect: "none", duration: 0.5 },
};
/** Builds a `GET /api/effects/` response `Response`, 1-based `index` and grouped into steps like the real route. `transition` defaults to "this slide never had one" — only the [E2.T11] 頁面進出場轉場 describe block below needs to vary it per slide (F8, NOOP-289 決定 E1: `canvas.ts` now reads a slide's transition off THIS route too, not by parsing the fetched markup itself). */
function effectsRouteResponse(effects: EffectRouteFixture[], transition = DEFAULT_TRANSITION_FIXTURE): Response {
  const wireEffects = effects.map((effect, i) => ({ duration: 0.6, delay: 0, ...effect, index: i + 1 }));
  const steps: Array<{ effects: typeof wireEffects }> = [];
  for (const effect of wireEffects) {
    if (effect.start === "on-click") {
      steps.push({ effects: [effect] });
    } else {
      steps[steps.length - 1]!.effects.push(effect);
    }
  }
  return new Response(JSON.stringify({ effects: wireEffects, steps, transition }), {
    status: 200,
  });
}

const playDeckEffects: Record<string, EffectRouteFixture[]> = {
  "slides/001.svg": [{ target: "el-a", family: "enter", effect: "fade", start: "on-click" }],
  "slides/002.svg": [],
};

function stubPlayDeck(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/presentation")) {
        return new Response(JSON.stringify(playDeck), { status: 200 });
      }
      const filesMatch = /\/api\/files\/(.+)$/.exec(url);
      if (filesMatch && playDeckMarkup[filesMatch[1]]) {
        return new Response(playDeckMarkup[filesMatch[1]], { status: 200 });
      }
      const effectsMatch = /\/api\/effects\/(.+)$/.exec(url);
      if (effectsMatch && playDeckEffects[effectsMatch[1]]) {
        return effectsRouteResponse(playDeckEffects[effectsMatch[1]]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe("mountCanvas 的播放模式", () => {
  it("play() 重建 iframe，加上 allow-scripts，不含 allow-same-origin", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    await controller.play();

    const iframe = container.querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("play() 的 srcdoc 帶著隱藏樣式、plan 與 runtime", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    await controller.play();

    const doc = srcdoc();
    expect(doc).toContain("#el-a{opacity:0 !important}");
    expect(doc).toContain("window.__COMOT_PLAN__ = JSON.parse(");
    // The plan is injected as a JSON *string* literal now (renderPlanScript,
    // ticket #30 prototype-pollution follow-up), not a bare object literal,
    // so the target id shows up JSON-escaped inside that outer string.
    expect(doc).toContain('\\"target\\":\\"el-a\\"');
    // The runtime's own listeners prove it was actually inlined, not just referenced.
    expect(doc).toContain('addEventListener("keydown"');
  });

  // ADR-0011/#56: exitPlay() no longer returns to a zero-token sandbox —
  // view mode itself now carries allow-scripts, for the selection runtime
  // — but must still shed the play runtime's own plan/window global.
  it("exitPlay() 回到 view 模式的 allow-scripts sandbox，不再帶播放 plan/runtime", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    await controller.exitPlay();

    const iframe = container.querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(srcdoc()).not.toContain("window.__COMOT_PLAN__");
    expect(srcdoc()).not.toContain("__COMOT_PLAN__");
  });

  it("play() 後 frameElement 回傳的是重建後的新元素，不是舊的參照", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    const viewFrame = controller.frameElement;

    await controller.play();

    expect(controller.frameElement).not.toBe(viewFrame);
    expect(controller.frameElement).toBe(container.querySelector("iframe"));
  });

  it("效果清單無法解析時，state.error 被設定，畫面仍顯示投影片但不含 runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify({ name: "壞掉的簡報", slides: ["slides/001.svg"] }), {
            status: 200,
          });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(
            `<svg xmlns="http://www.w3.org/2000/svg">
              <metadata><comot:effects ${NS}><comot:effect target="el-a" family="build" effect="fade" start="on-click"/></comot:effects></metadata>
              <rect id="el-a"/>
            </svg>`,
            { status: 200 },
          );
        }
        if (url.endsWith("/api/effects/slides/001.svg")) {
          return new Response(
            JSON.stringify({ error: "第 1 項（target 為 el-a） 的 family 值「build」尚未實作。" }),
            { status: 500 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.play();

    expect(state?.error).toMatch(/family.*build/);
    expect(srcdoc()).not.toContain("window.__COMOT_PLAN__");
    expect(srcdoc()).toContain('id="el-a"');
  });

  it("收到 runtime 的 focus 事件時更新 playerHasFocus", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "focus", hasFocus: true },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );

    expect(state?.playerHasFocus).toBe(true);
  });

  it("收到 runtime 的 advance-past-end 時換到下一頁；已在最後一頁時不動也不拋錯", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "advance-past-end" },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(srcdoc()).toContain('data-testid="s2"');

    // Already on the last slide now: another advance-past-end does nothing.
    const secondFrameWindow = controller.frameElement.contentWindow as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "advance-past-end" },
        source: secondFrameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(srcdoc()).toContain('data-testid="s2"');
  });

  // [E2.T11] §4.5: fullscreen owns Esc first. The runtime's own keydown
  // forwards Escape as "exit-play" regardless of fullscreen state, so
  // canvas.ts must re-check document.fullscreenElement itself before
  // honoring it — otherwise a single Esc would drop the author out of
  // both fullscreen and play mode at once.
  it("全螢幕時收到 runtime 的 exit-play 不會離開播放；離開全螢幕後再收到同一則訊息才真的退出播放", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement");
    try {
      Object.defineProperty(document, "fullscreenElement", {
        value: document.createElement("div"),
        configurable: true,
      });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "comot-player", event: "exit-play" },
          source: controller.frameElement.contentWindow as unknown as Window,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Still in play mode: srcdoc keeps the play-only plan global.
      expect(srcdoc()).toContain("window.__COMOT_PLAN__");

      Object.defineProperty(document, "fullscreenElement", {
        value: null,
        configurable: true,
      });

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "comot-player", event: "exit-play" },
          source: controller.frameElement.contentWindow as unknown as Window,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(srcdoc()).not.toContain("__COMOT_PLAN__");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(document, "fullscreenElement", originalDescriptor);
      } else {
        delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      }
    }
  });

  // #46: the runtime's own reverse-navigation route. currentIndex 0 -> 1
  // via advance-past-end, then retreat-past-start goes back to slide 1 and
  // must land on its *last* step (decision 五: "last", computed here since
  // only the parent knows the step count — never a sentinel over the wire).
  it("收到 runtime 的 retreat-past-start 時換回上一頁，並帶著該頁最後一步的 startStep", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "advance-past-end" },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(srcdoc()).toContain('data-testid="s2"');

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "retreat-past-start" },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // slides/001.svg has exactly one on-click effect: one step, last index 0.
    expect(srcdoc()).toContain('\\"target\\":\\"el-a\\"');
    expect(srcdoc()).toContain('\\"startStep\\":0');
  });

  // #46 decision 三: a previous slide with no effect list has
  // steps.length - 1 === -1, its static look — same code path, no special
  // case.
  it("退回沒有效果的上一頁時，startStep 是 -1", async () => {
    const noEffectDeck = { name: "無效果上一頁", slides: ["slides/001.svg", "slides/002.svg"] };
    const noEffectMarkup: Record<string, string> = {
      "slides/001.svg": '<svg data-testid="s1"><rect id="el-a"/></svg>',
      "slides/002.svg": `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="el-b" family="enter" effect="fade" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="el-b"/>
</svg>`,
    };
    const noEffectEffects: Record<string, EffectRouteFixture[]> = {
      "slides/001.svg": [],
      "slides/002.svg": [{ target: "el-b", family: "enter", effect: "fade", start: "on-click" }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(noEffectDeck), { status: 200 });
        }
        const filesMatch = /\/api\/files\/(.+)$/.exec(url);
        if (filesMatch && noEffectMarkup[filesMatch[1]]) {
          return new Response(noEffectMarkup[filesMatch[1]], { status: 200 });
        }
        const effectsMatch = /\/api\/effects\/(.+)$/.exec(url);
        if (effectsMatch && noEffectEffects[effectsMatch[1]]) {
          return effectsRouteResponse(noEffectEffects[effectsMatch[1]]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();
    await controller.showSlide(1);
    expect(srcdoc()).toContain('\\"target\\":\\"el-b\\"');

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "retreat-past-start" },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(srcdoc()).toContain('data-testid="s1"');
    expect(srcdoc()).toContain('\\"startStep\\":-1');
  });

  // Same race shape as "連續收到兩則 advance-past-end 時..." above, in
  // reverse: a superseded retreat's slower render must not paint over what
  // a later, faster navigation already applied.
  it("較慢的舊 retreat-past-start 換頁不會蓋過較新的那一頁", async () => {
    const raceDeck = { name: "三頁倒退測試", slides: ["slides/001.svg", "slides/002.svg", "slides/003.svg"] };
    let resolveSlide2!: () => void;
    const slide2Gate = new Promise<void>((resolve) => {
      resolveSlide2 = resolve;
    });
    const raceMarkup: Record<string, string> = {
      "slides/001.svg": '<svg data-testid="s1"><rect id="el-a"/></svg>',
      "slides/002.svg": '<svg data-testid="s2"><rect id="el-b"/></svg>',
      "slides/003.svg": '<svg data-testid="s3"><rect id="el-c"/></svg>',
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(raceDeck), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/002.svg")) {
          // Slide 2's retreat fetch is the slow, superseded one: it only
          // resolves after slide 1 (below) has already painted.
          await slide2Gate;
          return new Response(raceMarkup["slides/002.svg"], { status: 200 });
        }
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && raceMarkup[match[1]]) {
          return new Response(raceMarkup[match[1]], { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();
    await controller.showSlide(2);
    await controller.play();

    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    // First ArrowLeft-equivalent: currentIndex 2 -> 1, renderPlay() starts
    // fetching slide 2 and gets stuck on slide2Gate.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "retreat-past-start" },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Second ArrowLeft-equivalent, fired before the first has painted
    // anything: currentIndex 1 -> 0, renderPlay() fetches slide 1, which
    // resolves immediately and paints.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "retreat-past-start" },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(srcdoc()).toContain('data-testid="s1"');

    // Only now does the slow, superseded slide-2 fetch resolve. It must be
    // discarded, not painted over the already-current slide 1.
    resolveSlide2();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(srcdoc()).toContain('data-testid="s1"');
    expect(srcdoc()).not.toContain('data-testid="s2"');
  });

  it("已在第一頁時收到 retreat-past-start 不動也不拋錯", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "retreat-past-start" },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(srcdoc()).toContain('\\"target\\":\\"el-a\\"');
    expect(srcdoc()).toContain('\\"startStep\\":-1');
  });

  it("收到 runtime 的 error 事件時設定 state.error", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "error", message: "找不到步驟中要顯示的元素：el-x" },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );

    expect(state?.error).toBe("找不到步驟中要顯示的元素：el-x");
  });

  it("忽略不是來自目前 iframe 的訊息（即使 source 欄位宣稱是 comot-player）", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    // Not from `controller.frameElement.contentWindow` — an impostor.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "focus", hasFocus: true },
      }),
    );

    expect(state?.playerHasFocus).toBe(false);
  });

  it("重建 iframe 時，較慢的舊 render() 不會寫進剛建好的新 iframe（generation 也隨模式切換遞增）", async () => {
    let resolveSlowView!: () => void;
    const slowView = new Promise<void>((resolve) => {
      resolveSlowView = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(playDeck), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          // Each call gets its own Response instance (a Body can only be
          // read once) but they all wait on the same gate, so the mount's
          // own in-flight reload() genuinely races play()'s render below.
          await slowView;
          return new Response(playDeckMarkup["slides/001.svg"], { status: 200 });
        }
        const filesMatch = /\/api\/files\/(.+)$/.exec(url);
        if (filesMatch && playDeckMarkup[filesMatch[1]]) {
          return new Response(playDeckMarkup[filesMatch[1]], { status: 200 });
        }
        const effectsMatch = /\/api\/effects\/(.+)$/.exec(url);
        if (effectsMatch && playDeckEffects[effectsMatch[1]]) {
          return effectsRouteResponse(playDeckEffects[effectsMatch[1]]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    // mountCanvas's own reload() is now in flight, stuck awaiting slowView.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // play() bumps generation and rebuilds the iframe before the slow
    // view-mode fetch above ever resolves.
    const playPromise = controller.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const playFrame = controller.frameElement;

    resolveSlowView();
    await playPromise;

    // The stale view-mode render must not have painted into the play
    // iframe: it is still the play document (has the plan), not the bare
    // view-mode wrapper for slides/001.svg.
    expect(controller.frameElement).toBe(playFrame);
    expect(playFrame.srcdoc).toContain("window.__COMOT_PLAN__");
  });

  // Gate review round 2, P1: pressing forward fast enough sends a second
  // advance-past-end before the first page change's renderPlay() has
  // finished fetching. Without its own generation guard, both renderPlay()
  // calls shared the same (never-bumped) generation, so whichever fetch
  // happened to resolve last would win regardless of which slide the
  // author is actually supposed to be on — the earlier call's slow slide 2
  // could paint over the later call's already-current slide 3.
  it("連續收到兩則 advance-past-end 時，較慢的舊換頁不會蓋過較新的那一頁", async () => {
    const raceDeck = { name: "三頁播放測試", slides: ["slides/001.svg", "slides/002.svg", "slides/003.svg"] };
    let resolveSlide2!: () => void;
    const slide2Gate = new Promise<void>((resolve) => {
      resolveSlide2 = resolve;
    });
    const raceMarkup: Record<string, string> = {
      "slides/001.svg": playDeckMarkup["slides/001.svg"],
      "slides/002.svg": '<svg data-testid="s2"><rect id="el-b"/></svg>',
      "slides/003.svg": '<svg data-testid="s3"><rect id="el-c"/></svg>',
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(raceDeck), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/002.svg")) {
          // Slide 2's fetch is the slow, superseded one: it only resolves
          // after slide 3 (below) has already been requested and painted.
          await slide2Gate;
          return new Response(raceMarkup["slides/002.svg"], { status: 200 });
        }
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && raceMarkup[match[1]]) {
          return new Response(raceMarkup[match[1]], { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    // First ArrowRight-equivalent: currentIndex 0 -> 1, renderPlay() starts
    // fetching slide 2 and gets stuck on slide2Gate.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "advance-past-end" },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Second ArrowRight-equivalent, fired before the first has painted
    // anything: currentIndex 1 -> 2, renderPlay() fetches slide 3, which
    // resolves immediately and paints.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "advance-past-end" },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(srcdoc()).toContain('data-testid="s3"');

    // Only now does the slow, superseded slide-2 fetch resolve. It must be
    // discarded, not painted over the already-current slide 3.
    resolveSlide2();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(srcdoc()).toContain('data-testid="s3"');
    expect(srcdoc()).not.toContain('data-testid="s2"');
  });

  // Gate review round 2, P2: a broken slide's error must actually clear
  // once the author moves to a slide that plays fine — `error = null`
  // being assigned is not enough if nothing tells React about it.
  it("換到效果清單正常的投影片時，先前的 error 會被清掉並通知訂閱者", async () => {
    const brokenThenFineDeck = { name: "先壞後好", slides: ["slides/001.svg", "slides/002.svg"] };
    const brokenMarkup = `<svg xmlns="http://www.w3.org/2000/svg">
      <metadata><comot:effects ${NS}><comot:effect target="el-a" family="build" effect="fade" start="on-click"/></comot:effects></metadata>
      <rect id="el-a"/>
    </svg>`;
    const fineMarkup = '<svg data-testid="fine"><rect id="el-b"/></svg>';

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(brokenThenFineDeck), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) return new Response(brokenMarkup, { status: 200 });
        if (url.endsWith("/api/files/slides/002.svg")) return new Response(fineMarkup, { status: 200 });
        if (url.endsWith("/api/effects/slides/001.svg")) {
          return new Response(
            JSON.stringify({ error: "第 1 項（target 為 el-a） 的 family 值「build」尚未實作。" }),
            { status: 500 },
          );
        }
        if (url.endsWith("/api/effects/slides/002.svg")) return effectsRouteResponse([]);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const seenErrors: (string | null)[] = [];
    controller.subscribe((state) => seenErrors.push(state.error));
    expect(seenErrors.at(-1)).toMatch(/family.*build/);

    await controller.showSlide(1);

    expect(seenErrors.at(-1)).toBeNull();
    expect(srcdoc()).toContain('data-testid="fine"');
  });
});

// [E2.T7]: OverlayState.hasAnimation/badges (D9) and Preview (D8) — driven
// through the public controller/postMessage surface, same posture as the
// selection tests above.
describe("mountCanvas 的動畫（[E2.T7]）", () => {
  function sendSelectionMessage(data: Record<string, unknown>): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", ...data },
        source: controller!.frameElement.contentWindow as unknown as Window,
      }),
    );
  }

  /** `select` alone never repaints the overlay (production always follows it with the runtime's own `bounds` report) — this mirrors that real sequence rather than reaching into internals. */
  function selectAndReportBounds(id: string | null): void {
    if (id === null) {
      sendSelectionMessage({ event: "clear" });
    } else {
      sendSelectionMessage({ event: "select", id, name: null, additive: false });
    }
    sendSelectionMessage({
      event: "bounds",
      items: id === null ? [] : [{ id, rect: { x: 0, y: 0, width: 1, height: 1 }, ancestors: [] }],
      union: id === null ? null : { x: 0, y: 0, width: 1, height: 1 },
    });
  }

  it("選取有動畫的元素時 hasAnimation 為 true，選取沒有動畫的元素時為 false", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    let overlay: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      overlay = state;
    });

    selectAndReportBounds("el-a");
    expect(overlay?.hasAnimation).toBe(true);

    selectAndReportBounds("el-bg");
    expect(overlay?.hasAnimation).toBe(false);
  });

  it("runtime 回報 measured 之後，badges 帶著每個有效果的元素與其編號、換算過的 rect", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    let overlay: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      overlay = state;
    });

    // Real sequence: the runtime announces itself, canvas.ts asks it to
    // measure every badge target, the runtime replies.
    sendSelectionMessage({ event: "runtime-ready" });
    sendSelectionMessage({
      event: "measured",
      items: [{ id: "el-a", rect: { x: 1, y: 2, width: 3, height: 4 } }],
    });

    expect(overlay?.badges).toHaveLength(1);
    expect(overlay?.badges[0]).toMatchObject({ target: "el-a", n: 1 });
  });

  it("previewEffects() 進入 preview 模式並把 preview 欄位嵌進 plan；preview-done 訊息回到 view 模式並還原選取", async () => {
    // selectOnceLoaded (canvas.ts) only re-resolves an id through
    // currentSlideModel's own <g>-container elements (ADR-0012) — unlike
    // the other tests in this block, this one needs that resolution to
    // succeed, so it uses a compliant fixture rather than playDeckMarkup's
    // bare <rect>s.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify({ name: "preview 測試", slides: ["slides/001.svg"] }), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
              <metadata><comot:effects ${NS}><comot:effect target="el-a" family="enter" effect="fade" start="on-click"/></comot:effects></metadata>
              <g id="el-a"><rect width="10" height="10"/></g>
            </svg>`,
            { status: 200 },
          );
        }
        if (url.endsWith("/api/effects/slides/001.svg")) {
          return effectsRouteResponse([{ target: "el-a", family: "enter", effect: "fade", start: "on-click" }]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    controller = mountCanvas(container);
    await controller.reload();

    selectAndReportBounds("el-a");

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.previewEffects([0]);

    expect(state?.mode).toBe("preview");
    expect(srcdoc()).toContain('\\"preview\\":{\\"effectIndices\\":[0]}');

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-player", event: "preview-done" },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    // exitPreview() kicks off render() without awaiting it (the message
    // handler that calls exitPreview() is itself synchronous) — give its
    // internal fetchText() a real tick to resolve before the iframe's own
    // "load" is dispatched by hand (jsdom's srcdoc never fires it on its
    // own; see the paste-feedback describe block above for the same,
    // already-established workaround).
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.frameElement.dispatchEvent(new Event("load"));
    await Promise.resolve();

    expect(state?.mode).toBe("view");
    expect(state?.selection.ids).toEqual(["el-a"]);
  });

  it("previewEffects(null) 把 effectIndices 嵌成 null（整頁播放）", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    await controller.previewEffects(null);

    expect(srcdoc()).toContain('\\"preview\\":{\\"effectIndices\\":null}');
  });

  it("exitPreview() 立即回到 view 模式，不需等 preview-done", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.previewEffects(null);
    expect(state?.mode).toBe("preview");

    controller.exitPreview();

    expect(state?.mode).toBe("view");
  });
});

// T6: the presentation-level slide transition. renderPlay() is the only
// reader of project.transition — these tests drive it through the public
// controller (play()/next()/previous()/showSlide()) and assert on the
// <iframe> element's own inline style, never on the internal renderPlay()
// function itself.
describe("mountCanvas 的頁面進出場轉場 ([E2.T11])", () => {
  function frame(): HTMLIFrameElement {
    return container.querySelector("iframe") as HTMLIFrameElement;
  }

  /** Each entry is one slide's raw markup (with or without its own `<comot:transition>`) — transition now lives per-slide, not on `project.json` (T6's now-removed field). */
  /** Extracts the same `enter`/`enter-duration`/`exit`/`exit-duration` attributes `slideWithTransition()` writes into a slide's `<comot:transition>` — mirrors what the real `GET /api/effects/` route derives server-side (F8, NOOP-289 決定 E1: `canvas.ts` no longer parses this out of the fetched markup itself, so the mock route below has to, the same way the real one does). No `<comot:transition>` at all → the route's own "never had one" default. */
  function transitionFromMarkup(markup: string): typeof DEFAULT_TRANSITION_FIXTURE {
    const tagMatch = /<comot:transition\b[^>]*>/.exec(markup);
    if (!tagMatch) return DEFAULT_TRANSITION_FIXTURE;
    const attrs = tagMatch[0];
    const attr = (name: string, fallback: string): string => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? fallback;
    return {
      enter: { effect: attr("enter", "none"), duration: Number(attr("enter-duration", "0.6")) },
      exit: { effect: attr("exit", "none"), duration: Number(attr("exit-duration", "0.5")) },
    };
  }

  function stubTransitionDeck(markup: Record<string, string>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(deck), { status: 200 });
        }
        const filesMatch = /\/api\/files\/(.+)$/.exec(url);
        if (filesMatch && markup[filesMatch[1]]) {
          return new Response(markup[filesMatch[1]], { status: 200 });
        }
        // None of this describe block's fixtures carry a `<comot:effects>`
        // list (only `<comot:transition>`) — every slide legitimately has
        // no effects, matching the route's own "never had one" plan (D3).
        const effectsMatch = /\/api\/effects\/(.+)$/.exec(url);
        if (effectsMatch) return effectsRouteResponse([], transitionFromMarkup(markup[effectsMatch[1]] ?? ""));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  function slideWithTransition(testId: string, transitionAttrs?: string): string {
    const metadata = transitionAttrs ? `<metadata><comot:transition ${NS} ${transitionAttrs}/></metadata>` : "";
    return `<svg data-testid="${testId}">${metadata}</svg>`;
  }

  it.each([
    ["沒有 <metadata>", slideWithTransition("s1")],
    ["有 <metadata> 但沒有 <comot:transition>", '<svg data-testid="s1"><metadata></metadata></svg>'],
    ["enter/exit 都明寫 none", slideWithTransition("s1", 'enter="none" enter-duration="0.6" exit="none" exit-duration="0.5"')],
  ] as const)("讀取端：%s → 前進換頁瞬切，不拋錯", async (_label, firstSlideMarkup) => {
    stubTransitionDeck({ ...deckMarkup, "slides/001.svg": firstSlideMarkup, "slides/002.svg": slideWithTransition("s2") });
    controller = mountCanvas(container);
    await expect(controller.reload()).resolves.toBeUndefined();
    await controller.play();

    await controller.next();

    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
    expect(frame().style.transform).toBe("");
  });

  it("[A9] enter=\"fade\" 時抵達該頁：inline style 先是 opacity:0，下一個 animation frame 變成 opacity:1 且 transition 字串含該頁的 enter 時長", async () => {
    stubTransitionDeck({
      ...deckMarkup,
      "slides/001.svg": slideWithTransition("s1"),
      "slides/002.svg": slideWithTransition("s2", 'enter="fade" enter-duration="0.8" exit="none" exit-duration="0.5"'),
    });
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    await controller.next();

    expect(frame().style.opacity).toBe("0");
    expect(frame().style.transition).toBe("none");

    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(frame().style.opacity).toBe("1");
    expect(frame().style.transition).toBe("opacity 800ms var(--ease-out), transform 800ms var(--ease-out)");
  });

  it("[A10] exit=\"fade\" 時前進換頁：離開頁先同步淡出（opacity:0，transition 字串含 exit 時長），時長跑完才真的換成下一頁的 srcdoc", async () => {
    vi.useFakeTimers();
    try {
      stubTransitionDeck({
        ...deckMarkup,
        "slides/001.svg": slideWithTransition("s1", 'enter="none" enter-duration="0.6" exit="fade" exit-duration="1"'),
        "slides/002.svg": slideWithTransition("s2"),
      });
      controller = mountCanvas(container);
      await controller.reload();
      await controller.play();

      const advancePromise = controller.next();
      await vi.advanceTimersByTimeAsync(0);

      // (a) 同步設定的確定性斷言：opacity 立刻變 0，transition 字串含 1000ms。
      expect(frame().style.opacity).toBe("0");
      expect(frame().style.transition).toContain("1000ms");
      // (b) 此時仍是第一頁的內容，尚未換頁。
      expect(frame().srcdoc).toContain('data-testid="s1"');

      await vi.advanceTimersByTimeAsync(1000);
      await advancePromise;

      // (c) exit 播完才換成第二頁，且 opacity 回到非 0（enter 為預設 none，瞬切到 1 = removeProperty）。
      expect(frame().srcdoc).toContain('data-testid="s2"');
      expect(frame().style.opacity).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("[A11] 倒退換頁不播離開頁的 exit（瞬切離開）", async () => {
    stubTransitionDeck({
      ...deckMarkup,
      "slides/001.svg": slideWithTransition("s1"),
      "slides/002.svg": slideWithTransition("s2", 'enter="none" enter-duration="0.6" exit="fade" exit-duration="1"'),
    });
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();
    await controller.next();

    await controller.previous();

    // 沒有任何 exit 動畫發生過：回到第一頁（enter="none"）之後，inline style 全清空。
    expect(frame().srcdoc).toContain('data-testid="s1"');
    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
  });

  it("play() 進入播放會播該頁的 enter（行為變更：T6 時代這裡是瞬切）", async () => {
    stubTransitionDeck({
      ...deckMarkup,
      "slides/001.svg": slideWithTransition("s1", 'enter="fade" enter-duration="0.6" exit="none" exit-duration="0.5"'),
    });
    controller = mountCanvas(container);
    await controller.reload();

    await controller.play();

    expect(frame().style.opacity).toBe("0");
    expect(frame().style.transition).toBe("none");

    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(frame().style.opacity).toBe("1");
  });

  it("上一次 enter 淡入殘留的 inline style 不會污染下一次的瞬切換頁", async () => {
    stubTransitionDeck({
      ...deckMarkup,
      "slides/001.svg": slideWithTransition("s1"),
      "slides/002.svg": slideWithTransition("s2", 'enter="fade" enter-duration="0.6" exit="none" exit-duration="0.5"'),
    });
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();
    await controller.next();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(frame().style.opacity).toBe("1");

    await controller.previous();

    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
  });
});

// Gate review round 3, P2: target ids come straight from untrusted slide
// content (ADR-0010). A target containing "<!--<script>" (after XML entity
// decoding) sends the HTML tokenizer into "script data double escaped"
// state once embedded in the plan's <script> tag — the literal "</script>"
// text this module writes to close that tag no longer counts as a real
// closing tag there, so the parser keeps consuming through the runtime's
// own <script> too. The observable failure isn't data exfiltration, it's
// play mode never starting at all (the runtime never runs, so no "ready"
// ever arrives and the focus notice hangs forever) — still a real bug
// worth a real test.
describe("mountCanvas 的播放模式：嵌入 plan 時的跳脫", () => {
  it("target 含有 <!--<script> 時，plan 的 <script> 標籤不會吞掉後面的 runtime", async () => {
    const hostileId = "el-<!--<script>";
    const hostileDeck = { name: "跳脫測試簡報", slides: ["slides/001.svg"] };
    const hostileMarkup = `<svg xmlns="http://www.w3.org/2000/svg">
  <metadata>
    <comot:effects ${NS}>
      <comot:effect target="el-&lt;!--&lt;script&gt;" family="enter" effect="fade" start="on-click"/>
    </comot:effects>
  </metadata>
  <rect id="el-&lt;!--&lt;script&gt;"/>
</svg>`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(hostileDeck), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(hostileMarkup, { status: 200 });
        }
        if (url.endsWith("/api/effects/slides/001.svg")) {
          return effectsRouteResponse([{ target: hostileId, family: "enter", effect: "fade", start: "on-click" }]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const doc = srcdoc();
    // The plan's JSON must have carried the hostile target through as
    // data, never as literal "<" that the HTML tokenizer can act on.
    expect(doc).toContain(hostileId.replace(/</g, "\\u003C"));
    expect(doc).not.toContain("<!--<script>");
    // The clearest sign the tokenizer was fooled: the runtime's own
    // trailing code (its final `post({ event: "ready" })` call) never
    // shows up as a real, separately-parsed <script> element's content —
    // it would still be textually present in the raw srcdoc string either
    // way, so this must check *rendering*, not just string containment.
    // The reliable direct signal is that the runtime's script tag is not
    // itself broken: the whole runtime source must appear intact and
    // un-swallowed inside the srcdoc string, immediately after a genuine
    // closing "</script>" for the plan tag.
    const planScriptClose = doc.indexOf("<\/script><script>");
    expect(planScriptClose).toBeGreaterThan(-1);
    expect(doc.slice(planScriptClose)).toContain('post({ event: "ready" })');
  });
});

// ADR-0011/#56: element selection. The runtime itself only really runs in a
// real browser (same reasoning as the play-mode block above) — these tests
// stay at the seam this module owns: the CanvasState.selection field and
// how canvas.ts reacts to postMessage events selection-runtime.js would
// send.
describe("mountCanvas 的選取 (ADR-0011/#56)", () => {
  it("view 模式的 srcdoc 帶著注入的重點色/handle 色與 selection-runtime 本體", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    const doc = srcdoc();
    expect(doc).toContain("window.__COMOT_SELECTION_COLORS__");
    // The runtime's own distinctive call proves it was actually inlined,
    // not just referenced.
    expect(doc).toContain('source: "comot-selection"');
  });

  it("一開始 (mountCanvas 剛 reload 完) CanvasState.selection 沒有任何選取", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  it("收到 runtime 的 select 訊息會反映到 CanvasState.selection", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: "標題", additive: false },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );

    expect(state?.selection).toEqual({ ids: ["el-a"], names: ["標題"], groupPath: [], elements: [null] });
  });

  it("select 訊息沒有 data-comot-name 時，selection.name 是 null", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-b", name: null, additive: false },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );

    expect(state?.selection).toEqual({ ids: ["el-b"], names: [null], groupPath: [], elements: [null] });
  });

  it("收到 runtime 的 clear 訊息會把 CanvasState.selection 清回 null", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: null, additive: false },
        source: frameWindow,
      }),
    );
    expect(state?.selection.ids.length).toBeGreaterThan(0);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "clear" },
        source: frameWindow,
      }),
    );
    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  // Same authentication rule as isPlayerMessage's own tests: identity, never
  // event.origin (ADR-0010) — an impostor `source` must be ignored outright.
  it("不是來自目前 iframe 的 selection 訊息會被忽略", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: null, additive: false },
        source: {} as unknown as Window,
      }),
    );

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  it("換頁 (showSlide) 會清空選取", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: null, additive: false },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    expect(state?.selection.ids.length).toBeGreaterThan(0);

    await controller.showSlide(1);

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  it("reload() 會清空選取", async () => {
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: null, additive: false },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    expect(state?.selection.ids.length).toBeGreaterThan(0);

    await controller.reload();

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  it("play() 會清空選取", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: null, additive: false },
        source: controller.frameElement.contentWindow as unknown as Window,
      }),
    );
    expect(state?.selection.ids.length).toBeGreaterThan(0);

    await controller.play();

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  it("exitPlay() 回到 view 模式時選取是空的", async () => {
    stubPlayDeck();
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.exitPlay();

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });
});

// NOOP-275/#156: `element paste`'s `data.elementIds` (plural — unlike
// `textbox add`/`element insert`'s singular `data.elementId`) must become
// the selection once the write's own reload lands, same NOOP-227 mechanism
// extended to a list.
describe("mountCanvas 的選取：element paste 後的回饋 (NOOP-275/#156)", () => {
  const slideWithTwoElements =
    '<svg viewBox="0 0 1280 720">' +
    '<g id="el-src" data-comot-name="來源"><rect width="10" height="10"/></g>' +
    "</svg>";
  const slideAfterPaste =
    '<svg viewBox="0 0 1280 720">' +
    '<g id="el-src" data-comot-name="來源"><rect width="10" height="10"/></g>' +
    '<g id="el-new1" data-comot-name="複本一"><rect width="10" height="10"/></g>' +
    '<g id="el-new2" data-comot-name="複本二"><rect width="10" height="10"/></g>' +
    "</svg>";

  function stubPasteCommand(elementIds: string[]): void {
    let pasted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(pasted ? slideAfterPaste : slideWithTwoElements, { status: 200 });
        }
        if (url.endsWith("/api/command")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
          if (body.name === "element paste") {
            pasted = true;
            return new Response(JSON.stringify({ ok: true, message: "", data: { elementIds } }), { status: 200 });
          }
          throw new Error(`unexpected command: ${body.name}`);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  // selectOnceLoaded (canvas.ts) waits for the iframe's own "load" event
  // before trusting elementIndex() — real browsers fire it once srcdoc
  // finishes parsing, but jsdom's srcdoc implementation never dispatches it
  // (verified: a bare srcdoc assignment + addEventListener("load", ...)
  // never fires here, with or without jsdom's pretendToBeVisual/resources
  // options). render() has already parsed the fetched markup into
  // currentSlideModel by the time reload() resolves, so dispatching "load"
  // by hand here only unblocks the consumer — it does not skip anything
  // this module itself would otherwise have waited on.
  function dispatchFrameLoad(): void {
    controller!.frameElement.dispatchEvent(new Event("load"));
  }

  it("貼上多個元素後全部被選取，不只第一個 (A2)", async () => {
    stubPasteCommand(["el-new1", "el-new2"]);
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.runCommand("element paste", { slidePath: "slides/001.svg", dx: 20, dy: 20 });
    await controller.reload();
    dispatchFrameLoad();

    expect(state?.selection.ids).toEqual(["el-new1", "el-new2"]);
    expect(state?.selection.names).toEqual(["複本一", "複本二"]);
  });

  it("貼上失敗（ok:false）不改變選取，也不留下待選取的 id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(slideWithTwoElements, { status: 200 });
        }
        if (url.endsWith("/api/command")) {
          return new Response(JSON.stringify({ ok: false, error: "剪貼簿是空的" }), { status: 400 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.runCommand("element paste", { slidePath: "slides/001.svg", dx: 0, dy: 0 });
    await controller.reload();

    expect(state?.selection).toEqual({ ids: [], names: [], groupPath: [], elements: [] });
  });

  it("回傳的 elementIds 裡有找不到的元素時，只選取找得到的那些", async () => {
    stubPasteCommand(["el-new1", "el-missing"]);
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.runCommand("element paste", { slidePath: "slides/001.svg", dx: 20, dy: 20 });
    await controller.reload();
    dispatchFrameLoad();

    expect(state?.selection.ids).toEqual(["el-new1"]);
  });

  it("textbox add / element insert 的單一 elementId 選取行為不因本次改動而回歸", async () => {
    let inserted = false;
    const slideAfterInsert =
      '<svg viewBox="0 0 1280 720"><g id="el-shape" data-comot-name="矩形"><rect width="10" height="10"/></g></svg>';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(inserted ? slideAfterInsert : slideMarkup, { status: 200 });
        }
        if (url.endsWith("/api/command")) {
          inserted = true;
          return new Response(
            JSON.stringify({ ok: true, message: "", data: { elementId: "el-shape" } }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    controller = mountCanvas(container);
    await controller.reload();

    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    await controller.runCommand("element insert", { slidePath: "slides/001.svg", shape: "rect" });
    await controller.reload();
    dispatchFrameLoad();

    expect(state?.selection.ids).toEqual(["el-shape"]);
  });
});

// NOOP-328 [Fix.5]: reproduces, at the postMessage-protocol boundary (never
// against beginMoveGesture/toUserPoint directly — those are not a public
// boundary), the race behind the e2e "Alt 拖到同一位置" test's intermittent
// 180px-off failure. Root cause (see NOOP-329's plan comment for the full
// arithmetic): selection-runtime.js only calls reportViewport() on the
// iframe's own `load`/`resize` events, so a "gesture-start" that reaches
// canvas.ts before the first "viewport" message used to hit
// toUserPoint's `!viewport` branch, which silently returns { x: 0, y: 0 } —
// beginMoveGesture then records that origin as the drag's startUser with no
// guard at all (unlike updateMoveGesture, which already declines to act
// while viewport is null). Every subsequent delta is then measured from the
// wrong origin.
describe("mountCanvas 的拖曳手勢：gesture-start 早於 viewport (NOOP-328)", () => {
  it("gesture-start 抵達時 viewport 尚為 null，不會把手勢起點記成 (0,0)", async () => {
    const slideMarkupWithEl =
      '<svg viewBox="0 0 1280 720"><g id="el-a" transform="translate(100 100)"><rect width="160" height="100"/></g></svg>';
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(slideMarkupWithEl, { status: 200 });
        }
        if (url.endsWith("/api/command")) {
          commandCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ ok: true, message: "" }), { status: 200 });
        }
        // /api/editing/begin, /api/editing/end: fire-and-forget, swallowed
        // by beginEditingLease/endEditingLease's own .catch — any rejection
        // here is harmless.
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();

    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) =>
      window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    // Select el-a, then start a "move" gesture at client (180,150) — BEFORE
    // any "viewport" message has ever arrived (the exact race window: the
    // runtime's `load` listener has not fired yet).
    send({ source: "comot-selection", event: "select", id: "el-a", name: null, additive: false });
    send({ source: "comot-selection", event: "gesture-start", kind: "move", handle: null, point: { x: 180, y: 150 } });

    // The runtime's viewport report now lands (1:1 client-px <-> user-unit
    // mapping, to keep the arithmetic simple: svgRect and viewBox both
    // 1280x720 at the origin).
    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });

    // Drag to client (775,400) with Alt held (no snapping), then release.
    send({
      source: "comot-selection",
      event: "gesture-move",
      point: { x: 775, y: 400 },
      modifiers: { shift: false, alt: true },
    });
    send({ source: "comot-selection", event: "gesture-end", point: { x: 775, y: 400 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Buggy behavior (pre-fix): startUser was silently (0,0), so dx became
    // 775 - 0 = 775 instead of the correct 775 - 180 = 595 (and dy 400
    // instead of 250) — el-a would land at x=875, 180px off el-b's expected
    // 695 landing spot in the e2e test this reproduces. beginMoveGesture now
    // declines to start a gesture at all while viewport is still null (the
    // same posture updateMoveGesture already takes on every later point in
    // the drag), so this race drops the one affected drag instead of
    // teleporting the element: no "element move" command is posted, and
    // nothing lands at the wrong (0,0)-derived offset.
    const moveCalls = commandCalls.filter((call) => call.name === "element move");
    expect(moveCalls).toEqual([]);
  });
});

// NOOP-334: beginMoveGesture's !viewport guard (above) had no equivalent in
// beginScaleGesture/beginRotateGesture/beginTextboxWidthGesture — they share
// the same toUserPoint(point) call that silently returns {x:0,y:0} while
// viewport is still null. reportViewport() now firing synchronously before
// every "gesture-start" (selection-runtime.js) makes the race far less
// likely to hit in practice, but these three functions had no guard of
// their own if it ever did. Reproduced the same way as the move case: at
// the postMessage-protocol boundary, never against the gesture functions
// directly.
describe("mountCanvas 的縮放／旋轉／文字框寬度手勢：gesture-start 早於 viewport (NOOP-334)", () => {
  const slideMarkupWithEl =
    '<svg viewBox="0 0 1280 720"><g id="el-a" transform="translate(100 100)"><rect width="160" height="100"/></g></svg>';
  const slideMarkupWithTextbox =
    '<svg viewBox="0 0 1280 720"><g id="el-a" data-comot-text-width="200" transform="translate(100 100)">' +
    '<text font-family="Noto Sans TC" font-size="16">hello</text></g></svg>';

  function stubFetch(slideMarkup: string, commandCalls: { name: string; input: Record<string, unknown> }[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(slideMarkup, { status: 200 });
        }
        if (url.endsWith("/api/command")) {
          commandCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ ok: true, message: "" }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("gesture-start (scale) 抵達時 viewport 尚為 null，不會送出 element scale 指令", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(slideMarkupWithEl, commandCalls);

    controller = mountCanvas(container);
    await controller.reload();
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    send({ source: "comot-selection", event: "select", id: "el-a", name: null, additive: false });
    // el-a's origin (post-decompose) is (100,100). Without the guard,
    // toUserPoint(point) here silently returns {x:0,y:0}, so startUser is
    // corrupted to (0,0) instead of being dropped — the gesture does NOT
    // abort, it completes with a wrong factor. (50,50) is picked so that
    // ray "origin(100,100) -> corrupted startUser(0,0)" and ray
    // "origin -> (50,50)" point the same direction, giving a valid
    // positive factor (0.5) that DOES get posted as "element scale" in the
    // buggy case — a coordinate that instead yields a negative/invalid
    // factor either way would pass this test even without the guard.
    send({ source: "comot-selection", event: "gesture-start", kind: "scale", handle: "se", point: { x: 180, y: 150 } });
    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 50, y: 50 } });
    send({ source: "comot-selection", event: "gesture-end", point: { x: 50, y: 50 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const scaleCalls = commandCalls.filter((call) => call.name === "element scale");
    expect(scaleCalls).toEqual([]);
  });

  it("gesture-start (rotate) 抵達時 viewport 尚為 null，不會送出 element rotate 指令", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(slideMarkupWithEl, commandCalls);

    controller = mountCanvas(container);
    await controller.reload();
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    send({ source: "comot-selection", event: "select", id: "el-a", name: null, additive: false });
    send({ source: "comot-selection", event: "gesture-start", kind: "rotate", handle: null, point: { x: 180, y: 150 } });
    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 150, y: 250 } });
    send({ source: "comot-selection", event: "gesture-end", point: { x: 150, y: 250 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rotateCalls = commandCalls.filter((call) => call.name === "element rotate");
    expect(rotateCalls).toEqual([]);
  });

  it("gesture-start (textbox-width) 抵達時 viewport 尚為 null，不會嘗試載入字型（state.error 不會被設定）", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(slideMarkupWithTextbox, commandCalls);

    controller = mountCanvas(container);
    await controller.reload();
    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    send({ source: "comot-selection", event: "select", id: "el-a", name: null, additive: false });
    // Without the !viewport guard, beginTextboxWidthGesture would set
    // activeGesture synchronously and kick off resolveBrowserFont(), whose
    // fetch("/api/default-font") is not stubbed above and rejects — that
    // rejection's .catch() (canvas.ts) sets state.error, but only while
    // `activeGesture` still === this gesture object. Checking right after
    // gesture-start (before any gesture-end, which unconditionally nulls
    // activeGesture first thing) is what keeps that window open long
    // enough for the assertion below to actually observe the rejection.
    send({ source: "comot-selection", event: "gesture-start", kind: "textbox-width", handle: "left", point: { x: 180, y: 150 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state?.error).toBeNull();

    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 150, y: 150 } });
    send({ source: "comot-selection", event: "gesture-end", point: { x: 150, y: 150 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const textboxCalls = commandCalls.filter((call) => call.name === "textbox width");
    expect(textboxCalls).toEqual([]);
  });

  // NOOP-65 §7-I: a four-corner handle on a text box must redirect into
  // the SAME `textbox-width` gesture the left/right edge handles already
  // use, not the generic scale/resize path — core's `element scale`
  // semantics are untouched (§2 第 8 條), this is purely a front-end handle
  // remapping. F8 (NOOP-289 決定 (b)) removed the font fetch this test used
  // to prove the redirect with (`resolveBrowserFont()` only ever ran from
  // the textbox-width path) — the positive proof is now that a
  // `"textbox width"` command lands, since only that gesture kind ever
  // sends one; the negative side (never `element scale`/`resize`) is
  // unchanged.
  it("gesture-start (scale, corner=se) 在文字框上會走 textbox-width 路徑而非 element scale／resize", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(slideMarkupWithTextbox, commandCalls);

    controller = mountCanvas(container);
    await controller.reload();
    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    send({ source: "comot-selection", event: "select", id: "el-a", name: null, additive: false });
    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });
    send({ source: "comot-selection", event: "gesture-start", kind: "scale", handle: "se", point: { x: 180, y: 150 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state?.error).toBeNull();

    send({ source: "comot-selection", event: "gesture-move", point: { x: 220, y: 150 } });
    send({ source: "comot-selection", event: "gesture-end", point: { x: 220, y: 150 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commandCalls.filter((call) => call.name === "textbox width")).toHaveLength(1);
    expect(commandCalls.filter((call) => call.name === "element scale")).toEqual([]);
    expect(commandCalls.filter((call) => call.name === "element resize")).toEqual([]);
  });
});

// NOOP-349 round 3: endMarqueeGesture's hit test (canvas.ts) only ever reads
// elementBoundsById, filled exclusively by the "element-bounds" postMessage
// event — this is the host side of the round's fix (selection-runtime.js
// now sends "element-bounds" synchronously before "gesture-start" for a
// marquee, [Fix.2]). canvas.ts itself is deliberately unchanged; this test
// pins the existing degrade-to-empty-selection behavior it already had
// (`computeBounds` returning null) so nobody "fixes" it into a fallback
// hit-test path later — the postMessage-protocol boundary is the one and
// only source of truth (round-3 plan §4.B).
describe("mountCanvas 的框選命中：只認 element-bounds，沒收到就是空選取 (NOOP-349 round 3)", () => {
  const slideMarkupWithEl =
    '<svg viewBox="0 0 1280 720"><g id="el-a" transform="translate(100 100)"><rect width="160" height="100"/></g></svg>';

  function stubFetch(slideMarkup: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) return new Response(JSON.stringify(project), { status: 200 });
        if (url.endsWith("/api/files/slides/001.svg")) return new Response(slideMarkup, { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  async function runMarquee(
    send: (data: unknown) => void,
    sendElementBounds: boolean,
  ): Promise<void> {
    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });
    if (sendElementBounds) {
      send({
        source: "comot-selection",
        event: "element-bounds",
        items: [{ id: "el-a", rect: { x: 100, y: 100, width: 160, height: 100 }, local: { x: 0, y: 0, width: 160, height: 100 } }],
      });
    }
    // Marquee rect (50,50)-(300,250) fully covers el-a's (100,100,160,100).
    send({ source: "comot-selection", event: "gesture-start", kind: "marquee", handle: null, point: { x: 50, y: 50 } });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 300, y: 250 } });
    send({ source: "comot-selection", event: "gesture-end", point: { x: 300, y: 250 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("收到 element-bounds 後結束 marquee：涵蓋範圍內的元素被選取", async () => {
    stubFetch(slideMarkupWithEl);
    controller = mountCanvas(container);
    await controller.reload();
    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    await runMarquee(send, true);

    expect(state?.selection.ids).toEqual(["el-a"]);
  });

  it("從未收到 element-bounds 就結束 marquee：即使矩形涵蓋元素也選不到任何東西（不丟例外）", async () => {
    stubFetch(slideMarkupWithEl);
    controller = mountCanvas(container);
    await controller.reload();
    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    await runMarquee(send, false);

    expect(state?.selection.ids).toEqual([]);
  });
});

// F8 (NOOP-289 決定 (d)/C2): copy/cut go straight through the CLI's own
// `element copy`/`element cut` now — the browser no longer serializes a
// selection itself. `element cut` replaces the former "local serialize +
// element delete" pair.
describe("mountCanvas 的剪貼簿 copySelection／cutSelection（F8, NOOP-289 決定 (d)/C2）", () => {
  const slideMarkupWithEl = '<svg viewBox="0 0 1280 720"><g id="el-a"><rect width="10" height="10"/></g></svg>';

  function stubFetch(
    commandCalls: { name: string; input: Record<string, unknown> }[],
    commandResult: { ok: boolean; data?: unknown; message?: string },
  ): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) return new Response(JSON.stringify(project), { status: 200 });
        if (url.endsWith("/api/files/slides/001.svg")) return new Response(slideMarkupWithEl, { status: 200 });
        if (url.endsWith("/api/command")) {
          commandCalls.push(JSON.parse(String(init?.body ?? "{}")));
          const body = commandResult.ok
            ? { ok: true, message: commandResult.message ?? "", data: commandResult.data }
            : { ok: false, error: commandResult.message ?? "失敗" };
          return new Response(JSON.stringify(body), { status: commandResult.ok ? 200 : 500 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  async function selectElA(): Promise<void> {
    const frameWindow = controller!.frameElement.contentWindow as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "select", id: "el-a", name: null, additive: false },
        source: frameWindow,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("⌘C 送出 element copy，把 data.svg 回傳給呼叫者，不動選取", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(commandCalls, { ok: true, data: { svg: "<svg>copied</svg>" } });
    controller = mountCanvas(container);
    await controller.reload();
    await selectElA();

    const svg = await controller.copySelection();

    expect(svg).toBe("<svg>copied</svg>");
    expect(commandCalls).toEqual([{ name: "element copy", input: { slidePath: "slides/001.svg", elementIds: ["el-a"] } }]);
  });

  it("⌘X 送出 element cut（不是 element delete），回傳 data.svg，清空選取", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(commandCalls, { ok: true, data: { svg: "<svg>cut</svg>" } });
    controller = mountCanvas(container);
    await controller.reload();
    await selectElA();
    let state: CanvasState | undefined;
    controller.subscribe((next) => {
      state = next;
    });

    const svg = await controller.cutSelection();

    expect(svg).toBe("<svg>cut</svg>");
    expect(commandCalls).toEqual([{ name: "element cut", input: { slidePath: "slides/001.svg", elementIds: ["el-a"] } }]);
    expect(commandCalls.some((call) => call.name === "element delete")).toBe(false);
    expect(state?.selection.ids).toEqual([]);
  });

  it("命令失敗時，copySelection／cutSelection 都回傳 null（呼叫者才不會寫入系統剪貼簿）", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(commandCalls, { ok: false, message: "命令失敗" });
    controller = mountCanvas(container);
    await controller.reload();
    await selectElA();

    expect(await controller.copySelection()).toBeNull();
    await selectElA();
    expect(await controller.cutSelection()).toBeNull();
  });
});

// F8 (NOOP-289 決定 (b)): a textbox-width drag no longer re-wraps the
// `<text>` locally — this proves the host side of that: zero commands
// during the drag, exactly one `"textbox width"` on release.
describe("mountCanvas 的文字框寬度拖曳：拖曳中不送任何命令（F8, NOOP-289 決定 (b)）", () => {
  const slideMarkupWithTextbox =
    '<svg viewBox="0 0 1280 720"><g id="el-a" data-comot-text-width="200" transform="translate(100 100)">' +
    '<text font-family="Noto Sans TC" font-size="16">hello</text></g></svg>';

  function stubFetch(commandCalls: { name: string; input: Record<string, unknown> }[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) return new Response(JSON.stringify(project), { status: 200 });
        if (url.endsWith("/api/files/slides/001.svg")) return new Response(slideMarkupWithTextbox, { status: 200 });
        if (url.endsWith("/api/command")) {
          commandCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ ok: true, message: "" }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("拖曳中多次 gesture-move 都不送命令，放開才送恰好一條 textbox width", async () => {
    const commandCalls: { name: string; input: Record<string, unknown> }[] = [];
    stubFetch(commandCalls);
    controller = mountCanvas(container);
    await controller.reload();
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));

    send({ source: "comot-selection", event: "select", id: "el-a", name: null, additive: false });
    send({
      source: "comot-selection",
      event: "viewport",
      svgRect: { x: 0, y: 0, width: 1280, height: 720 },
      viewBox: { x: 0, y: 0, width: 1280, height: 720 },
    });
    send({ source: "comot-selection", event: "gesture-start", kind: "textbox-width", handle: "right", point: { x: 100, y: 150 } });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 120, y: 150 } });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 140, y: 150 } });
    send({ source: "comot-selection", event: "gesture-move", point: { x: 160, y: 150 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commandCalls).toEqual([]);

    send({ source: "comot-selection", event: "gesture-end", point: { x: 160, y: 150 }, cancelled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0].name).toBe("textbox width");
  });
});

// NOOP-91 round-2 FAIL #4: `computeOverlayLabel`/`notifyOverlay` (the data
// `SelectionOverlay.tsx`/`ContextBar.tsx` render) had zero test coverage —
// only the *rendering* of that data was ever exercised manually. These test
// black-box through `subscribeOverlay`, the same postMessage-protocol
// boundary every other canvas.ts test in this file uses, rather than
// reaching into module-private state.
describe("subscribeOverlay：label／union／boxes 的座標與祖先鏈計算（NOOP-91 round-2 FAIL #4）", () => {
  function send(controllerFrame: HTMLIFrameElement, data: unknown): void {
    const frameWindow = controllerFrame.contentWindow as unknown as Window;
    window.dispatchEvent(new MessageEvent("message", { data, source: frameWindow }));
  }

  it("單選一個元素：label 用顯示名稱、path 為空；boxes/union 來自 bounds 事件", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    let latest: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      latest = state;
    });

    send(controller.frameElement, { source: "comot-selection", event: "select", id: "el-a", name: "方塊 A", additive: false });
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    send(controller.frameElement, { source: "comot-selection", event: "bounds", items: [{ id: "el-a", rect, ancestors: [] }], union: rect });

    expect(latest?.label).toEqual({ text: "方塊 A", path: [] });
    expect(latest?.boxes).toEqual([rect]);
    expect(latest?.union).toEqual(rect);
  });

  it("refreshOverlay：frame 移動/縮放後（zoom/pan）用新的 frame 位置重算 union／boxes，不需要新的 bounds 事件", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    let latest: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      latest = state;
    });

    send(controller.frameElement, { source: "comot-selection", event: "select", id: "el-a", name: "方塊 A", additive: false });
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    send(controller.frameElement, { source: "comot-selection", event: "bounds", items: [{ id: "el-a", rect, ancestors: [] }], union: rect });
    // jsdom: frame rect is all zeros / offsetWidth 0 → identity conversion.
    expect(latest?.union).toEqual(rect);

    // The parent's `.stage` transform moved the frame to (100, 200) and
    // doubled it (rect.width 400 against layout offsetWidth 200).
    const frame = controller.frameElement;
    Object.defineProperty(frame, "offsetWidth", { value: 200, configurable: true });
    frame.getBoundingClientRect = () => ({ x: 100, y: 200, left: 100, top: 200, width: 400, height: 225, right: 500, bottom: 425, toJSON: () => ({}) });
    controller.refreshOverlay();

    expect(latest?.union).toEqual({ x: 120, y: 240, width: 60, height: 80 });
    expect(latest?.boxes).toEqual([{ x: 120, y: 240, width: 60, height: 80 }]);
  });

  it("鑽入群組後選取子元素：label.path 依 bounds 回報的祖先鏈由外到內排列", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    let latest: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      latest = state;
    });

    send(controller.frameElement, {
      source: "comot-selection",
      event: "select",
      id: "el-group-child",
      name: "群組子元素",
      additive: false,
      groupPath: ["el-group"],
    });
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    send(controller.frameElement, {
      source: "comot-selection",
      event: "bounds",
      items: [
        {
          id: "el-group-child",
          rect,
          ancestors: [
            { id: "el-group", name: "群組" },
            { id: "el-group-2", name: null },
          ],
        },
      ],
      union: rect,
    });

    // Outermost ancestor first; a nameless ancestor falls back to its id
    // (computeOverlayLabel's own doc comment).
    expect(latest?.label).toEqual({ text: "群組子元素", path: ["群組", "el-group-2"] });
  });

  it("多選：label 顯示『N elements』，不含 path（即使 bounds 回報了祖先鏈也忽略）", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    let latest: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      latest = state;
    });

    send(controller.frameElement, { source: "comot-selection", event: "select", id: "el-a", name: "方塊 A", additive: false });
    send(controller.frameElement, { source: "comot-selection", event: "select", id: "el-b", name: "方塊 B", additive: true });
    const rectA = { x: 0, y: 0, width: 10, height: 10 };
    const rectB = { x: 20, y: 20, width: 10, height: 10 };
    send(controller.frameElement, {
      source: "comot-selection",
      event: "bounds",
      items: [
        { id: "el-a", rect: rectA, ancestors: [{ id: "should-be-ignored", name: "多選時忽略祖先鏈" }] },
        { id: "el-b", rect: rectB, ancestors: [] },
      ],
      union: { x: 0, y: 0, width: 30, height: 30 },
    });

    expect(latest?.label).toEqual({ text: "2 elements", path: [] });
    expect(latest?.boxes).toEqual([rectA, rectB]);
  });

  it("清除選取後（runtime 隨即回報空 bounds，如真實 runtime 的 updateBoxes 一樣）：label/union/boxes 全部清空", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    let latest: OverlayState | undefined;
    controller.subscribeOverlay((state) => {
      latest = state;
    });

    send(controller.frameElement, { source: "comot-selection", event: "select", id: "el-a", name: "方塊 A", additive: false });
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    send(controller.frameElement, { source: "comot-selection", event: "bounds", items: [{ id: "el-a", rect, ancestors: [] }], union: rect });
    expect(latest?.label).not.toBeNull();

    // selection-runtime.js's updateBoxes() always calls reportBounds() right
    // after any selection change, including the empty-selection branch — a
    // "clear" is never sent without an immediate follow-up "bounds".
    send(controller.frameElement, { source: "comot-selection", event: "clear" });
    send(controller.frameElement, { source: "comot-selection", event: "bounds", items: [], union: null });

    expect(latest?.label).toBeNull();
    expect(latest?.union).toBeNull();
    expect(latest?.boxes).toEqual([]);
  });
});

describe("mountCanvas 的 stage-key 中繼：⌘Z/⇧⌘Z 轉交 setUndoRedoHandler 註冊的處理器（#198）", () => {
  function relayStageKey(key: string, shift: boolean): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "stage-key", key, meta: true, ctrl: false, shift, alt: false },
        source: controller!.frameElement.contentWindow as unknown as Window,
      }),
    );
  }

  it("⌘Z 呼叫處理器一次，參數是 undo", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    const handler = vi.fn();
    controller.setUndoRedoHandler(handler);

    relayStageKey("z", false);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("undo");
  });

  it("⇧⌘Z 呼叫處理器一次，參數是 redo", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    const handler = vi.fn();
    controller.setUndoRedoHandler(handler);

    relayStageKey("Z", true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("redo");
  });

  it("尚未註冊處理器時收到 ⌘Z 不拋錯，也不自己送出任何請求", async () => {
    controller = mountCanvas(container);
    await controller.reload();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const callsBefore = fetchMock.mock.calls.length;

    expect(() => relayStageKey("z", false)).not.toThrow();

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe("mountCanvas 的 stage-key 中繼：ArrowLeft/ArrowRight 換頁（F-02, NOOP-385/NOOP-351/#283）", () => {
  function relayArrow(key: "ArrowLeft" | "ArrowRight"): void {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "comot-selection", event: "stage-key", key, meta: false, ctrl: false, shift: false, alt: false },
        source: controller!.frameElement.contentWindow as unknown as Window,
      }),
    );
  }

  it("ArrowRight 中繼後往下一頁，ArrowLeft 往上一頁——選取了投影片元素、焦點落在 iframe 內時仍要能換頁", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();

    relayArrow("ArrowRight");
    await vi.waitFor(() => expect(srcdoc()).toContain('data-testid="s2"'));

    relayArrow("ArrowLeft");
    await vi.waitFor(() => expect(srcdoc()).toContain('data-testid="s1"'));
  });

  it("在最後一頁 ArrowRight、在第一頁 ArrowLeft：不拋錯，也不呼叫多餘的 fetch", async () => {
    stubDeck();
    controller = mountCanvas(container);
    await controller.reload();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    expect(() => relayArrow("ArrowLeft")).not.toThrow();
    await Promise.resolve();
    expect(srcdoc()).toContain('data-testid="s1"');

    await controller.showSlide(2);
    const callsAtLastSlide = fetchMock.mock.calls.length;
    expect(() => relayArrow("ArrowRight")).not.toThrow();
    await Promise.resolve();
    expect(srcdoc()).toContain('data-testid="s3"');
    expect(fetchMock.mock.calls.length).toBe(callsAtLastSlide);
  });
});

// E2.T14r2 §4.1: handleTableRangeKey/setTableRange/subscribeTableRange — the
// single decision function both the iframe relay and App.tsx's capture
// listener call, tested here at its own public boundary
// (`createCanvasController()`'s returned object, per plan §6.5), not
// against a private module variable.
describe("mountCanvas 的儲存格範圍鍵盤決策（E2.T14r2, plan §4.1）", () => {
  // 2×2 table: (0,0)/(1,0)/(1,1) start at font-weight 400, (0,1) starts
  // already bold (700) — lets the ⌘B toggle-both-ways tests below share one
  // fixture instead of two nearly-identical ones.
  const TABLE_SLIDE =
    '<svg viewBox="0 0 1280 720">' +
    '<g id="el-tbl" data-comot-type="table" data-comot-cols="100 100" data-comot-rows="40 40" data-comot-theme="dark" transform="translate(10 10)">' +
    '<g data-comot-cell="0,0"><rect x="0" y="0" width="100" height="40" fill="#111111"/><text x="4" y="20" font-weight="400" fill="#ffffff">A</text></g>' +
    '<g data-comot-cell="0,1"><rect x="0" y="0" width="100" height="40" fill="#111111"/><text x="4" y="20" font-weight="700" fill="#ffffff">B</text></g>' +
    '<g data-comot-cell="1,0"><rect x="0" y="0" width="100" height="40" fill="#111111"/><text x="4" y="20" font-weight="400" fill="#ffffff">C</text></g>' +
    '<g data-comot-cell="1,1"><rect x="0" y="0" width="100" height="40" fill="#111111"/><text x="4" y="20" font-weight="400" fill="#ffffff">D</text></g>' +
    "</g></svg>";

  function stubTableFetch(commandCalls: { name: string; input: Record<string, unknown> }[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(project), { status: 200 });
        }
        if (url.endsWith("/api/files/slides/001.svg")) {
          return new Response(TABLE_SLIDE, { status: 200 });
        }
        if (url.endsWith("/api/command")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { name: string; input: Record<string, unknown> };
          commandCalls.push(body);
          return new Response(JSON.stringify({ ok: true, message: "", data: {} }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  function sendSelection(frameWindow: Window, data: Record<string, unknown>): void {
    window.dispatchEvent(new MessageEvent("message", { data: { source: "comot-selection", ...data }, source: frameWindow }));
  }

  /** Tracks the latest `subscribeTableRange` value — a real state channel (plan §4.1), so the very first call already carries the value at subscribe time. */
  function watchTableRange(c: CanvasController): { current: { tableId: string; range: { r0: number; c0: number; r1: number; c1: number } } | null } {
    const box: { current: { tableId: string; range: { r0: number; c0: number; r1: number; c1: number } } | null } = { current: null };
    c.subscribeTableRange((value) => {
      box.current = value;
    });
    return box;
  }

  async function mountWithTable(commandCalls: { name: string; input: Record<string, unknown> }[]): Promise<{ controller: CanvasController; frameWindow: Window }> {
    stubTableFetch(commandCalls);
    controller = mountCanvas(container);
    await controller.reload();
    const frameWindow = controller.frameElement.contentWindow as unknown as Window;
    sendSelection(frameWindow, { event: "select", id: "el-tbl", name: null, additive: false });
    return { controller, frameWindow };
  }

  it("沒有作用中的範圍時，任何鍵都回傳 false、不送出任何命令", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c } = await mountWithTable(calls);

    expect(c.handleTableRangeKey("Tab", { meta: false, ctrl: false, shift: false })).toBe(false);
    expect(c.handleTableRangeKey("Delete", { meta: false, ctrl: false, shift: false })).toBe(false);
    expect(c.handleTableRangeKey("b", { meta: true, ctrl: false, shift: false })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("table-cell-click 建立單一儲存格範圍（非 additive）", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    const range = watchTableRange(c);

    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 1, additive: false });

    expect(range.current).toEqual({ tableId: "el-tbl", range: { r0: 0, c0: 1, r1: 0, c1: 1 } });
  });

  it("⇧點延伸範圍：normalizeRange(anchor, 該格)", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    const range = watchTableRange(c);

    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 1, col: 1, additive: true });

    expect(range.current).toEqual({ tableId: "el-tbl", range: { r0: 0, c0: 0, r1: 1, c1: 1 } });
  });

  it("Tab 移到下一格（row-major）；⇧Tab 反向", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    const range = watchTableRange(c);
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });

    expect(c.handleTableRangeKey("Tab", { meta: false, ctrl: false, shift: false })).toBe(true);
    expect(range.current).toEqual({ tableId: "el-tbl", range: { r0: 0, c0: 1, r1: 0, c1: 1 } });

    expect(c.handleTableRangeKey("Tab", { meta: false, ctrl: false, shift: true })).toBe(true);
    expect(range.current).toEqual({ tableId: "el-tbl", range: { r0: 0, c0: 0, r1: 0, c1: 0 } });
  });

  it("Escape 清除範圍，表格本身仍被選取", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    const range = watchTableRange(c);
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });

    let state: CanvasState | undefined;
    c.subscribe((next) => {
      state = next;
    });

    expect(c.handleTableRangeKey("Escape", { meta: false, ctrl: false, shift: false })).toBe(true);

    expect(range.current).toBeNull();
    expect(state?.selection.ids).toEqual(["el-tbl"]);
  });

  it("Delete 對範圍內每一格送 table cell set --text ''，不刪表格、範圍保留", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    const range = watchTableRange(c);
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 1, col: 1, additive: true });

    expect(c.handleTableRangeKey("Delete", { meta: false, ctrl: false, shift: false })).toBe(true);
    // Sequential now (not `Promise.all`, per the lost-update race this
    // round found against a real server) — wait for all 4 to land rather
    // than assuming one microtask flush covers however many round trips.
    await vi.waitFor(() => {
      if (calls.filter((call) => call.name === "table cell set").length < 4) throw new Error("still waiting");
    });

    const setCalls = calls.filter((call) => call.name === "table cell set");
    expect(setCalls.map((call) => `${call.input.row},${call.input.col}`).sort()).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    for (const call of setCalls) {
      expect(call.input).toMatchObject({ slidePath: "slides/001.svg", elementId: "el-tbl", text: "" });
    }
    expect(calls.some((call) => call.name === "element delete")).toBe(false);
    expect(range.current).toEqual({ tableId: "el-tbl", range: { r0: 0, c0: 0, r1: 1, c1: 1 } });
  });

  it("⌘B：字重 400 的格切到 700", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });

    expect(c.handleTableRangeKey("b", { meta: true, ctrl: false, shift: false })).toBe(true);
    await Promise.resolve();

    const styleCalls = calls.filter((call) => call.name === "table cell style set");
    expect(styleCalls).toEqual([
      { name: "table cell style set", input: { slidePath: "slides/001.svg", elementId: "el-tbl", row: 0, col: 0, rowEnd: 0, colEnd: 0, attr: "font-weight", value: "700" } },
    ]);
  });

  it("⌘B：字重已 ≥700 的格切回 400", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 1, additive: false });

    expect(c.handleTableRangeKey("b", { meta: false, ctrl: true, shift: false })).toBe(true);
    await Promise.resolve();

    const styleCalls = calls.filter((call) => call.name === "table cell style set");
    expect(styleCalls).toEqual([
      { name: "table cell style set", input: { slidePath: "slides/001.svg", elementId: "el-tbl", row: 0, col: 1, rowEnd: 0, colEnd: 1, attr: "font-weight", value: "400" } },
    ]);
  });

  it("選取的元素已不是那張表格：回傳 false 並清掉範圍", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c } = await mountWithTable(calls);
    const range = watchTableRange(c);
    // Direct call, bypassing the "select"/"table-cell-click" messages that
    // would normally keep this in sync — exercises handleTableRangeKey's
    // own defensive row of its behaviour table (§4.1) even though the
    // "select" branch already covers the realistic path (next test).
    c.setTableRange({ tableId: "el-other", range: { r0: 0, c0: 0, r1: 0, c1: 0 } });

    expect(c.handleTableRangeKey("Tab", { meta: false, ctrl: false, shift: false })).toBe(false);
    expect(range.current).toBeNull();
    expect(calls).toEqual([]);
  });

  it("選取換到別的元素、或清空選取：範圍自動變 null", async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const { controller: c, frameWindow } = await mountWithTable(calls);
    const range = watchTableRange(c);
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });
    expect(range.current).not.toBeNull();

    sendSelection(frameWindow, { event: "select", id: "el-other", name: null, additive: false });
    expect(range.current).toBeNull();

    sendSelection(frameWindow, { event: "select", id: "el-tbl", name: null, additive: false });
    sendSelection(frameWindow, { event: "table-cell-click", id: "el-tbl", row: 0, col: 0, additive: false });
    expect(range.current).not.toBeNull();

    sendSelection(frameWindow, { event: "clear" });
    expect(range.current).toBeNull();
  });
});

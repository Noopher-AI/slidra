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

function stubPlayDeck(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/presentation")) {
        return new Response(JSON.stringify(playDeck), { status: 200 });
      }
      const match = /\/api\/files\/(.+)$/.exec(url);
      if (match && playDeckMarkup[match[1]]) {
        return new Response(playDeckMarkup[match[1]], { status: 200 });
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
              <metadata><comot:effects ${NS}><comot:effect target="el-a" family="exit" effect="fade" start="on-click"/></comot:effects></metadata>
              <rect id="el-a"/>
            </svg>`,
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

    await controller.play();

    expect(state?.error).toMatch(/family.*exit/);
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(JSON.stringify(noEffectDeck), { status: 200 });
        }
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && noEffectMarkup[match[1]]) {
          return new Response(noEffectMarkup[match[1]], { status: 200 });
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
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && playDeckMarkup[match[1]]) {
          return new Response(playDeckMarkup[match[1]], { status: 200 });
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
      <metadata><comot:effects ${NS}><comot:effect target="el-a" family="exit" effect="fade" start="on-click"/></comot:effects></metadata>
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
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    const seenErrors: (string | null)[] = [];
    controller.subscribe((state) => seenErrors.push(state.error));
    expect(seenErrors.at(-1)).toMatch(/family.*exit/);

    await controller.showSlide(1);

    expect(seenErrors.at(-1)).toBeNull();
    expect(srcdoc()).toContain('data-testid="fine"');
  });
});

// T6: the presentation-level slide transition. renderPlay() is the only
// reader of project.transition — these tests drive it through the public
// controller (play()/next()/previous()/showSlide()) and assert on the
// <iframe> element's own inline style, never on the internal renderPlay()
// function itself.
describe("mountCanvas 的簡報層級轉場 (T6)", () => {
  function frame(): HTMLIFrameElement {
    return container.querySelector("iframe") as HTMLIFrameElement;
  }

  function stubTransitionDeck(transition?: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/presentation")) {
          return new Response(
            JSON.stringify({ ...deck, ...(transition === undefined ? {} : { transition }) }),
            { status: 200 },
          );
        }
        const match = /\/api\/files\/(.+)$/.exec(url);
        if (match && deckMarkup[match[1]]) {
          return new Response(deckMarkup[match[1]], { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it.each([
    ["缺少 transition 欄位", undefined],
    ["空字串", ""],
    ["未知的未來值", "wipe"],
  ] as const)("讀取端：%s 視為 none，前進換頁瞬切，不拋錯", async (_label, value) => {
    stubTransitionDeck(value);
    controller = mountCanvas(container);
    await expect(controller.reload()).resolves.toBeUndefined();
    await controller.play();

    await controller.next();

    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
  });

  it("transition: \"none\" 時前進換頁瞬切", async () => {
    stubTransitionDeck("none");
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    await controller.next();

    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
  });

  it("transition: \"fade\" 時前進換頁先設 opacity:0，再於下一個 animation frame 淡入到 1", async () => {
    stubTransitionDeck("fade");
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();

    await controller.next();

    expect(frame().style.opacity).toBe("0");
    expect(frame().style.transition).toBe("none");

    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(frame().style.opacity).toBe("1");
    expect(frame().style.transition).toBe(`opacity 400ms`);
  });

  it("transition: \"fade\" 時倒退換頁一律瞬切（retreat is instant）", async () => {
    stubTransitionDeck("fade");
    controller = mountCanvas(container);
    await controller.reload();
    await controller.play();
    await controller.next();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    await controller.previous();

    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
  });

  it("transition: \"fade\" 時 play() 進入播放（非換頁）瞬切", async () => {
    stubTransitionDeck("fade");
    controller = mountCanvas(container);
    await controller.reload();

    await controller.play();

    expect(frame().style.opacity).toBe("");
    expect(frame().style.transition).toBe("");
  });

  it("transition: \"fade\" 時上一次淡入殘留的 inline style 不會污染下一次的瞬切換頁", async () => {
    stubTransitionDeck("fade");
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

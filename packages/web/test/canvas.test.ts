import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCanvas } from "../src/canvas.js";
import type { CanvasController, CanvasState } from "../src/canvas.js";

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

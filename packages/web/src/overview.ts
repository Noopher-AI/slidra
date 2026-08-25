/**
 * 總覽: a vanilla DOM module, same style and trust posture as canvas.ts
 * (ADR-0001, ADR-0010). React hands it the aside container once and never
 * renders into it again.
 *
 * `wrapSlideDocument`/`slideDirectory` below deliberately duplicate
 * canvas.ts's helpers of the same purpose rather than importing them.
 * Originally forced by concurrent units owning the two files; kept after
 * the `<base>`-vs-fragment-references review because the measurement
 * (e2e/base-fragment-spike.test.ts) required no behaviour change in either
 * copy — extracting a shared module for its own sake would only flatten
 * the one deliberate difference (the thumbnail-sizing `<style>` this
 * copy injects, see wrapSlideDocument below).
 */
import type { CanvasController } from "./canvas.js";

export interface OverviewController {
  destroy(): void;
  /**
   * A slide's markup may change without project.json's `slides` list
   * moving at all — the ordinary shape of an external edit, which is what
   * live reload reacts to. `canvas.subscribe()`'s state can't distinguish
   * that from "only currentIndex changed" (both look like the same slides
   * array), so the caller (App.tsx's live-reload handler) calls this
   * explicitly instead. Re-fetches every thumbnail that has already been
   * materialised; thumbnails that were never observed stay untouched, so a
   * refresh never pulls in the whole deck and defeats lazy loading.
   */
  refresh(): void;
}

export function mountOverview(container: HTMLElement, canvas: CanvasController): OverviewController {
  const list = document.createElement("ol");
  list.className = "overview-list";
  container.appendChild(list);

  // The thumbnail box's aspect ratio comes from the presentation's real
  // canvas (project.json's `canvas.width`/`canvas.height`), not a
  // hardcoded 16:9 — a 4:3 or portrait presentation must get 4:3 or
  // portrait boxes. Fetched here rather than read off CanvasState because
  // that contract deliberately carries only `slides` (#29/#30 build
  // against it). Until the response lands, style.css's `var()` fallback
  // keeps the boxes at 16:9 so the scrollbar is honest from the first
  // paint; a failed or malformed response throws instead of silently
  // keeping the fallback. Called again from refresh(): an external edit
  // can change the canvas size too, and live reload's refresh() is the
  // only signal this module gets about it.
  // Same generation-guard shape as fetchAndFillThumbnail below: two
  // overlapping refresh() calls must not let the older call's slower
  // response re-apply a stale ratio after the newer one already landed.
  let aspectGeneration = 0;
  async function applyAspectRatio(): Promise<void> {
    const thisGeneration = ++aspectGeneration;
    const project = await fetchJson<{ canvas: { width: number; height: number } }>("/api/presentation");
    if (aspectGeneration !== thisGeneration) return;
    const { width, height } = project.canvas ?? {};
    if (!(typeof width === "number" && width > 0 && typeof height === "number" && height > 0)) {
      throw new Error("project.json 的 canvas 尺寸無效，無法決定縮圖長寬比");
    }
    list.style.setProperty("--overview-aspect-ratio", `${width} / ${height}`);
  }
  void applyAspectRatio();

  let slides: string[] = [];
  const items: HTMLLIElement[] = [];
  // Sparse on purpose: a slot only gets an iframe once its <li> has been
  // observed to intersect (see loadThumbnail). Before that the slot is
  // undefined — an iframe created eagerly would cost a browsing context
  // per slide even with an empty srcdoc, which is exactly what #27's
  // "only thumbnails near the viewport are materialised" rules out.
  const frames: (HTMLIFrameElement | undefined)[] = [];
  // Guards against re-fetching a thumbnail that is already loaded or in
  // flight — the observer can report the same <li> intersecting more than
  // once before its unobserve() call has taken effect.
  const requested: boolean[] = [];
  // Same generation-guard shape as canvas.ts's own `generation` counter
  // (see its comment), but one counter per thumbnail rather than one for
  // the whole module: two overlapping refresh() calls on the *same* index
  // (e.g. an agent editing a slide twice in quick succession) must not let
  // the earlier fetch's slower response paint over the later one's result
  // once it lands, no matter which settles first. A per-index counter also
  // means a race on slide 3 never has to reason about slide 7's fetches.
  const generations: number[] = [];

  // A small view distance (a few slides' worth of scroll either side), the
  // same shape as reveal.js's own viewDistance: enough to keep scrolling
  // ahead of the reader without materialising the whole deck at once.
  const observer = new IntersectionObserver(handleIntersections, {
    root: container,
    rootMargin: "600px 0px",
  });

  function handleIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const li = entry.target as HTMLLIElement;
      observer.unobserve(li);
      const index = Number(li.dataset.index);
      loadThumbnail(index);
    }
  }

  function loadThumbnail(index: number): void {
    if (requested[index]) return;
    requested[index] = true;
    // The iframe is only born here, on first intersection — rebuildList()
    // deliberately leaves the <li> with just its placeholder button. The
    // zero-token sandbox is set before the element ever enters the DOM.
    const iframe = document.createElement("iframe");
    iframe.className = "overview-frame";
    iframe.setAttribute("sandbox", "");
    items[index].querySelector("button")!.appendChild(iframe);
    frames[index] = iframe;
    void fetchAndFillThumbnail(index);
  }

  /**
   * Always fetches and fills, regardless of the `requested` flag — the
   * part refresh() also uses. Claims this call's generation for `index`
   * before the first await, then checks it against the live counter after
   * every await: if a later call for the same index has started since,
   * this call's result — success or failure — is stale and must be
   * dropped instead of overwriting what the newer call already applied.
   */
  async function fetchAndFillThumbnail(index: number): Promise<void> {
    const thisGeneration = (generations[index] ?? 0) + 1;
    generations[index] = thisGeneration;

    const slidePath = slides[index];
    // Only ever called with a materialised slot: loadThumbnail() creates
    // the iframe before the first call, and refresh() only revisits
    // indexes whose `requested` flag is set.
    const frame = frames[index]!;
    try {
      const markup = await fetchText(`/api/files/${slidePath}`);
      if (generations[index] !== thisGeneration) return;
      frame.srcdoc = wrapSlideDocument(markup, `/api/raw/${slideDirectory(slidePath)}`);
    } catch {
      if (generations[index] !== thisGeneration) return;
      frame.srcdoc = wrapSlideDocument(`<p>縮圖載入失敗</p>`);
    }
  }

  function sameSlides(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((path, index) => path === b[index]);
  }

  function rebuildList(nextSlides: string[]): void {
    observer.disconnect();
    list.replaceChildren();
    items.length = 0;
    frames.length = 0;
    requested.length = 0;
    generations.length = 0;
    slides = nextSlides;

    slides.forEach((_slidePath, index) => {
      const li = document.createElement("li");
      li.className = "overview-item";
      li.dataset.index = String(index);

      // The button doubles as the placeholder: the <li>'s aspect-ratio box
      // (style.css) gives it its size, so the scrollbar is honest and the
      // current-page highlight works before any iframe exists. The iframe
      // itself is created lazily in loadThumbnail().
      // Page numbers (#52): generated together with the <li> itself, not by
      // a separate pass over the rendered list — they must exist for every
      // slide before any IntersectionObserver callback has fired, which
      // this element being cheap (plain text, no iframe) is what makes
      // possible without regressing #27's lazy thumbnail loading.
      const number = document.createElement("span");
      number.className = "overview-number";
      number.textContent = String(index + 1);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "overview-thumb";
      button.setAttribute("aria-label", `第 ${index + 1} 頁`);
      button.addEventListener("click", () => void canvas.showSlide(index));

      li.appendChild(number);
      li.appendChild(button);
      list.appendChild(li);

      items.push(li);
      frames.push(undefined);
      requested.push(false);
      observer.observe(li);
    });
  }

  function updateHighlight(currentIndex: number): void {
    items.forEach((li, index) => {
      const isCurrent = index === currentIndex;
      li.classList.toggle("overview-item-current", isCurrent);
      const button = li.querySelector("button")!;
      if (isCurrent) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });
  }

  const unsubscribe = canvas.subscribe((state) => {
    if (!sameSlides(slides, state.slides)) {
      rebuildList(state.slides);
    }
    updateHighlight(state.currentIndex);
  });

  return {
    refresh() {
      void applyAspectRatio();
      requested.forEach((isRequested, index) => {
        if (isRequested) void fetchAndFillThumbnail(index);
      });
    },
    destroy() {
      unsubscribe();
      observer.disconnect();
      list.remove();
    },
  };
}

/**
 * #55's grid view. Deliberately duplicates mountOverview's lazy-loading
 * shape above (same file-header reasoning as wrapSlideDocument/
 * slideDirectory: two consumers that materialise independently, kept apart
 * on purpose) rather than sharing state with it — a grid mount must never
 * eagerly load a thumbnail the rail hasn't, and vice versa. Markup mirrors
 * docs/design/base-shell.html's `.grid-view`/`.grid-cell`/`figcaption`
 * shape directly (flat: `container` itself is the grid, no extra `<ol>`
 * wrapper the rail's `<aside>` container needed), styled by
 * styles/grid.css.
 *
 * `onSelect` is called (with no arguments) after a cell's click has already
 * issued `canvas.showSlide(index)` — this module has no notion of the
 * shell's `view` state (App.tsx's `ShellView`), so switching back to
 * standard view is entirely the caller's business. See GridView.tsx for
 * why that switch cannot be a normal prop callback threaded through
 * App.tsx here.
 */
export function mountGridOverview(
  container: HTMLElement,
  canvas: CanvasController,
  onSelect: () => void,
): OverviewController {
  // Same reasoning as applyAspectRatio in mountOverview above, applied to
  // this consumer's own container instead of the rail's <ol>.
  let aspectGeneration = 0;
  async function applyAspectRatio(): Promise<void> {
    const thisGeneration = ++aspectGeneration;
    const project = await fetchJson<{ canvas: { width: number; height: number } }>("/api/presentation");
    if (aspectGeneration !== thisGeneration) return;
    const { width, height } = project.canvas ?? {};
    if (!(typeof width === "number" && width > 0 && typeof height === "number" && height > 0)) {
      throw new Error("project.json 的 canvas 尺寸無效，無法決定縮圖長寬比");
    }
    container.style.setProperty("--overview-aspect-ratio", `${width} / ${height}`);
  }
  void applyAspectRatio();

  let slides: string[] = [];
  const cells: HTMLElement[] = [];
  const frames: (HTMLIFrameElement | undefined)[] = [];
  const requested: boolean[] = [];
  const generations: number[] = [];

  const observer = new IntersectionObserver(handleIntersections, {
    root: container,
    rootMargin: "600px 0px",
  });

  function handleIntersections(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const cell = entry.target as HTMLElement;
      observer.unobserve(cell);
      const index = Number(cell.dataset.index);
      loadThumbnail(index);
    }
  }

  function loadThumbnail(index: number): void {
    if (requested[index]) return;
    requested[index] = true;
    const iframe = document.createElement("iframe");
    iframe.className = "grid-frame";
    iframe.setAttribute("sandbox", "");
    cells[index].querySelector("button")!.appendChild(iframe);
    frames[index] = iframe;
    void fetchAndFillThumbnail(index);
  }

  /** Same generation-guard shape as mountOverview's own fetchAndFillThumbnail. */
  async function fetchAndFillThumbnail(index: number): Promise<void> {
    const thisGeneration = (generations[index] ?? 0) + 1;
    generations[index] = thisGeneration;

    const slidePath = slides[index];
    const frame = frames[index]!;
    try {
      const markup = await fetchText(`/api/files/${slidePath}`);
      if (generations[index] !== thisGeneration) return;
      frame.srcdoc = wrapSlideDocument(markup, `/api/raw/${slideDirectory(slidePath)}`);
    } catch {
      if (generations[index] !== thisGeneration) return;
      frame.srcdoc = wrapSlideDocument(`<p>縮圖載入失敗</p>`);
    }
  }

  function sameSlides(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((path, index) => path === b[index]);
  }

  function rebuildList(nextSlides: string[]): void {
    observer.disconnect();
    container.replaceChildren();
    cells.length = 0;
    frames.length = 0;
    requested.length = 0;
    generations.length = 0;
    slides = nextSlides;

    slides.forEach((_slidePath, index) => {
      const cell = document.createElement("figure");
      cell.className = "grid-cell";
      cell.dataset.index = String(index);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "grid-thumb";
      button.setAttribute("aria-label", `第 ${index + 1} 頁`);
      button.addEventListener("click", () => {
        void canvas.showSlide(index);
        onSelect();
      });

      const caption = document.createElement("figcaption");
      caption.className = "grid-number";
      caption.textContent = `第 ${index + 1} 頁`;

      cell.appendChild(button);
      cell.appendChild(caption);
      container.appendChild(cell);

      cells.push(cell);
      frames.push(undefined);
      requested.push(false);
      observer.observe(cell);
    });
  }

  function updateHighlight(currentIndex: number): void {
    cells.forEach((cell, index) => {
      cell.setAttribute("aria-current", String(index === currentIndex));
    });
  }

  const unsubscribe = canvas.subscribe((state) => {
    if (!sameSlides(slides, state.slides)) {
      rebuildList(state.slides);
    }
    updateHighlight(state.currentIndex);
  });

  return {
    refresh() {
      void applyAspectRatio();
      requested.forEach((isRequested, index) => {
        if (isRequested) void fetchAndFillThumbnail(index);
      });
    },
    destroy() {
      unsubscribe();
      observer.disconnect();
      container.replaceChildren();
    },
  };
}

/**
 * Mirrors canvas.ts's own wrapSlideDocument (module-private there; see file
 * header), plus one addition specific to thumbnails: the slide SVG has no
 * width/height of its own (only a viewBox), so left alone it renders at the
 * UA default intrinsic size rather than filling the thumbnail box. The
 * injected style forces it to fill the iframe's viewport while keeping
 * `preserveAspectRatio`'s default `xMidYMid meet`, which is what keeps the
 * aspect ratio correct and the whole slide visible instead of cropped.
 *
 * Exported for e2e/base-fragment-spike.test.ts, which measures (on all
 * three engines) that the injected `<base>` leaves same-document fragment
 * references intact in this wrapper too.
 */
export function wrapSlideDocument(bodyMarkup: string, baseHref?: string): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}<style>html,body{margin:0;height:100%}svg{display:block;width:100%;height:100%}</style></head><body>${bodyMarkup}</body></html>`;
}

/** Mirrors canvas.ts's own slideDirectory (module-private there; see file header). */
function slideDirectory(slidePath: string): string {
  const lastSlash = slidePath.lastIndexOf("/");
  if (lastSlash === -1) return "";
  return slidePath
    .slice(0, lastSlash + 1)
    .split("/")
    .map((segment) => (segment === "" ? segment : encodeURIComponent(segment)))
    .join("/");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return response.text();
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return (await response.json()) as T;
}

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

/**
 * [E2.T3]: the two behaviours that need a React tree to render into
 * (the right-click menu, and — in a later ticket — the comment thread the
 * top-right button opens) get reported up through here rather than grown a
 * second DOM-manipulation path of their own. Drag/drop reordering does NOT
 * need a hook — `canvas` (the `CanvasController` this module already holds)
 * already has `runCommand`/`reload`/`showSlide`, everything a `slide move`
 * needs (T3 plan §7 決定 7).
 */
export interface OverviewHooks {
  /** A thumbnail was right-clicked. `x`/`y` are the event's clientX/clientY, for a fixed-position menu. */
  onContextMenu?: (index: number, x: number, y: number) => void;
}

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

export function mountOverview(container: HTMLElement, canvas: CanvasController, hooks: OverviewHooks = {}): OverviewController {
  const list = document.createElement("ol");
  list.className = "overview-list";
  container.appendChild(list);

  // [E2.T3] 拖曳排序狀態（本模組自己的 closure state，不進 React）。
  // `dragFromIndex` is the authoritative "from" — read out of
  // `dataTransfer` at drop time (T3 plan §4.2's "格式錯誤" row), not just
  // trusted from whatever dragstart happened to set, so a drop whose
  // dataTransfer genuinely carries no parseable index is treated as a
  // format error and abandoned rather than guessed at.
  const dropLine = document.createElement("li");
  dropLine.className = "overview-drop-line";
  dropLine.setAttribute("aria-hidden", "true");
  let dragFromIndex: number | null = null;

  /** Prototype's own no-op rule (T3 plan §3.8): dropping on yourself, or on your own very next slot, changes nothing. */
  function isDropNoop(from: number, to: number): boolean {
    return from < 0 || from === to || from + 1 === to;
  }

  function clearDragState(): void {
    dragFromIndex = null;
    dropLine.remove();
  }

  /** `to` = insertion index in the array WITH the dragged item still present — the prototype's own `to` (T3 plan §3.8), also this module's insertBefore target: `items[to]` (or `null`/append when `to === items.length`). */
  function showDropLineIfMeaningful(to: number): void {
    if (dragFromIndex === null || isDropNoop(dragFromIndex, to)) {
      dropLine.remove();
      return;
    }
    list.insertBefore(dropLine, items[to] ?? null);
  }

  // This shell has no trailing "+" placeholder card (unlike the prototype)
  // for "drop past the last thumbnail" — the empty space below the last
  // `<li>`, inside the list's own bottom padding, is `list` itself as
  // `event.target`. Attached once (not per rebuild): the list element's
  // identity never changes across rebuildList() calls.
  list.addEventListener("dragover", (event) => {
    if (dragFromIndex === null || event.target !== list) return;
    event.preventDefault();
    showDropLineIfMeaningful(items.length);
  });
  list.addEventListener("drop", (event) => {
    if (event.target !== list) return;
    event.preventDefault();
    const from = dropSourceIndex(event);
    clearDragState();
    if (from === null) return;
    void commitMove(from, items.length);
  });
  // Leaving the rail entirely while dragging (T3 plan §4.2's "拖曳中途離開
  // rail" row) clears the line — `relatedTarget` is null when the pointer
  // leaves the browser window outright, which `!contains(null)` already
  // treats as "outside".
  container.addEventListener("dragleave", (event) => {
    const related = (event as DragEvent).relatedTarget as Node | null;
    if (!container.contains(related)) dropLine.remove();
  });

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
      frame.srcdoc = wrapSlideDocument(`<p>Thumbnail failed to load</p>`);
    }
  }

  function sameSlides(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((path, index) => path === b[index]);
  }

  /** Reads dragstart's own payload back out, rather than trusting the closure's `dragFromIndex` alone (T3 plan §4.2's "格式錯誤" row — a `dataTransfer` that carries no parseable index is a format error, not a guess). */
  function dropSourceIndex(event: DragEvent): number | null {
    const raw = event.dataTransfer?.getData("text/plain");
    if (!raw) return null;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < slides.length ? index : null;
  }

  /** Cursor position within `li` decides "insert before this slide" vs. "insert before the next one" — the latter is how dropping past the last thumbnail (no trailing placeholder card in this shell) reaches `to === slides.length`. */
  function dropTargetIndex(li: HTMLLIElement, clientY: number): number {
    const index = Number(li.dataset.index);
    const rect = li.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? index : index + 1;
  }

  async function commitMove(from: number, to: number): Promise<void> {
    if (isDropNoop(from, to)) return;
    const newIndex = to > from ? to - 1 : to; // T3 plan §3.8: exactly core's `moveSlide` newIndex, no further adjustment.
    const slidePath = slides[from];
    const result = await canvas.runCommand("slide move", { slidePath, newIndex });
    if (result.ok) {
      // T3 plan §7 決定 6: an order-changing command always follows with an
      // explicit reload()+showSlide() — plain reload() only clamps
      // currentIndex into range, it never targets a specific page, and
      // waiting for the write's own /api/events-triggered reload instead
      // would race against this call.
      await canvas.reload();
      await canvas.showSlide(newIndex);
    }
    // A failed move leaves order unchanged; CanvasState.error already
    // carries the message (canvas.ts's runCommand sets it before this
    // await resolves) — nothing further to do here either way.
  }

  function rebuildList(nextSlides: string[]): void {
    observer.disconnect();
    // An external edit landing mid-drag invalidates whatever the gesture
    // was pointed at (T3 plan §4.2's "拖曳中投影片被 /api/events 通知變更"
    // row) — the gesture is abandoned, not applied on top of a deck that
    // has already moved out from under it.
    clearDragState();
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
      li.draggable = true;

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
      button.setAttribute("aria-label", `Slide ${index + 1}`);
      button.addEventListener("click", () => void canvas.showSlide(index));

      // Comment entry point (T3 plan §2 邊界 2): the thread itself is
      // F13's — this ticket only renders a disabled, labelled door to it.
      const commentButton = document.createElement("button");
      commentButton.type = "button";
      commentButton.className = "overview-comment-button";
      commentButton.setAttribute("aria-label", "Comment to agent");
      commentButton.setAttribute("aria-disabled", "true");
      commentButton.disabled = true;
      commentButton.innerHTML =
        '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 4h14v9H9l-4 3v-3H3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

      li.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        hooks.onContextMenu?.(index, event.clientX, event.clientY);
      });

      li.addEventListener("dragstart", (event) => {
        dragFromIndex = index;
        event.dataTransfer?.setData("text/plain", String(index));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragover", (event) => {
        if (dragFromIndex === null) return;
        event.preventDefault();
        showDropLineIfMeaningful(dropTargetIndex(li, event.clientY));
      });
      li.addEventListener("drop", (event) => {
        event.preventDefault();
        const from = dropSourceIndex(event);
        const to = dropTargetIndex(li, event.clientY);
        clearDragState();
        if (from === null) return; // format error (T3 plan §4.2): abandon, never guess.
        void commitMove(from, to);
      });
      li.addEventListener("dragend", clearDragState);

      li.appendChild(number);
      li.appendChild(button);
      li.appendChild(commentButton);
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
 * Mirrors canvas.ts's own `PRESENTATION_FONT_FACE_STYLE` (ticket #71 /
 * ADR-0016): the container's embedded font is only guaranteed correct inside
 * a CoMotion wrapper document, and a thumbnail's `srcdoc` is one — without
 * this, a slide's `font-family="Noto Sans TC"` falls back to whatever the
 * host OS happens to have, so a thumbnail could show visibly different text
 * layout than the canvas it is a preview of. `url()` is an absolute
 * `/api/raw/` path for the same cross-origin-srcdoc reason canvas.ts's copy
 * documents.
 */
const PRESENTATION_FONT_FACE_STYLE =
  '<style>@font-face{font-family:"Noto Sans TC";src:url("/api/raw/fonts/NotoSansTC-Presentation.ttf") format("truetype");font-weight:400;font-style:normal;}</style>';

/**
 * Mirrors canvas.ts's own wrapSlideDocument (module-private there; see file
 * header), plus one addition specific to thumbnails: the slide SVG has no
 * width/height of its own (only a viewBox), so left alone it renders at the
 * UA default intrinsic size rather than filling the thumbnail box. The
 * injected style forces it to fill the iframe's viewport while keeping
 * `preserveAspectRatio`'s default `xMidYMid meet`, which is what keeps the
 * aspect ratio correct and the whole slide visible instead of cropped.
 *
 * `html,body{background:#fff}` (#120): a slide with no background rect of
 * its own (e.g. `co-motion new`'s blank title slide) otherwise leaves this
 * document fully transparent, so `.overview-thumb`'s `#000` loading
 * placeholder (rail.css) never gets painted over — the thumbnail reads as
 * solid black instead of an empty page. A presentation's mental model is a
 * sheet of paper; a blank one is white everywhere, not just where an author
 * happened to draw a rect.
 *
 * Exported for e2e/base-fragment-spike.test.ts, which measures (on all
 * three engines) that the injected `<base>` leaves same-document fragment
 * references intact in this wrapper too.
 */
export function wrapSlideDocument(bodyMarkup: string, baseHref?: string): string {
  const baseTag = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${baseTag}${PRESENTATION_FONT_FACE_STYLE}<style>html,body{margin:0;height:100%;background:#fff}svg{display:block;width:100%;height:100%}</style></head><body>${bodyMarkup}</body></html>`;
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

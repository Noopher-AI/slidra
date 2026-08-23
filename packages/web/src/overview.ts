/**
 * 總覽: a vanilla DOM module, same style and trust posture as canvas.ts
 * (ADR-0001, ADR-0010). React hands it the aside container once and never
 * renders into it again.
 *
 * `wrapSlideDocument`/`slideDirectory` below deliberately duplicate
 * canvas.ts's private helpers of the same purpose rather than importing
 * them — canvas.ts does not export them, and this ticket must not edit
 * canvas.ts (another unit is rewriting it concurrently). See the fleet's
 * gap ledger.
 */
import type { CanvasController } from "./canvas.js";

export interface OverviewController {
  destroy(): void;
}

export function mountOverview(container: HTMLElement, canvas: CanvasController): OverviewController {
  const list = document.createElement("ol");
  list.className = "overview-list";
  container.appendChild(list);

  let slides: string[] = [];
  const items: HTMLLIElement[] = [];
  const frames: HTMLIFrameElement[] = [];
  // Guards against re-fetching a thumbnail that is already loaded or in
  // flight — the observer can report the same <li> intersecting more than
  // once before its unobserve() call has taken effect.
  const requested: boolean[] = [];

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
      void loadThumbnail(index);
    }
  }

  async function loadThumbnail(index: number): Promise<void> {
    if (requested[index]) return;
    requested[index] = true;

    const slidePath = slides[index];
    const frame = frames[index];
    try {
      const markup = await fetchText(`/api/files/${slidePath}`);
      frame.srcdoc = wrapSlideDocument(markup, `/api/raw/${slideDirectory(slidePath)}`);
    } catch {
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
    slides = nextSlides;

    slides.forEach((_slidePath, index) => {
      const li = document.createElement("li");
      li.className = "overview-item";
      li.dataset.index = String(index);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "overview-thumb";
      button.setAttribute("aria-label", `第 ${index + 1} 頁`);
      button.addEventListener("click", () => void canvas.showSlide(index));

      const iframe = document.createElement("iframe");
      iframe.className = "overview-frame";
      iframe.setAttribute("sandbox", "");

      button.appendChild(iframe);
      li.appendChild(button);
      list.appendChild(li);

      items.push(li);
      frames.push(iframe);
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
    destroy() {
      unsubscribe();
      observer.disconnect();
      list.remove();
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
 */
function wrapSlideDocument(bodyMarkup: string, baseHref?: string): string {
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

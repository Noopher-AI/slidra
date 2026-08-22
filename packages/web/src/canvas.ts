/**
 * The canvas: a vanilla DOM module. React hands it a container element and
 * never touches what ends up inside it (ADR-0001) — the 投影片 is the
 * artifact loaded from the presentation file, not something React computes
 * from state.
 *
 * `reload()` is the seam future tickets hook into: #5's change-push handler
 * calls it directly when the watched file changes on disk, redrawing the
 * slide without React re-rendering anything.
 *
 * A `.comot` is meant to be opened by people other than its author (ADR-0003
 * — that's the point of it being a single shareable file). Slide markup is
 * therefore untrusted: a legal SVG can carry `onload`/`onerror` handlers or
 * an active `<foreignObject>`, and if it were injected with `innerHTML` into
 * this document it would run as first-party script, able to call
 * `/api/files/*` and exfiltrate the presentation. It is rendered inside a
 * sandboxed iframe instead, fed via `srcdoc`, which puts it in an opaque
 * origin — not a construct that is blocked from reaching the app, but one
 * that has nowhere to reach the app from. See the comment on the iframe's
 * `sandbox` attribute below before changing it.
 */
export interface CanvasController {
  reload: () => Promise<void>;
  destroy: () => void;
}

interface ProjectJson {
  name: string;
  slides: string[];
}

export function mountCanvas(container: HTMLElement): CanvasController {
  let destroyed = false;

  const iframe = document.createElement("iframe");
  iframe.className = "slide-frame";
  // `sandbox` with no tokens is the opaque-origin default: no scripts, no
  // forms, no top-level navigation, and — load-bearing — no
  // `allow-same-origin`. `allow-same-origin` is what lets the iframe keep
  // this document's origin instead of getting a fresh opaque one; add it
  // and the isolation this exists for is gone. Do not add it, including
  // later alongside `allow-scripts` for the animation runtime: an iframe
  // with both `allow-scripts` and `allow-same-origin` can script itself
  // free of its own sandbox (e.g. reach back into same-origin APIs via
  // `document.domain`), which is strictly worse than either flag alone.
  // `allow-scripts` by itself would be safe to add when something in a
  // slide actually needs to execute; the pair together is not.
  iframe.setAttribute("sandbox", "");
  container.appendChild(iframe);

  async function reload(): Promise<void> {
    // A no-op after destroy(): the iframe this closure owns is gone from
    // the DOM, so there is nothing left to redraw, and re-fetching would
    // just race the next mount for no benefit.
    if (destroyed) return;

    const project = await fetchJson<ProjectJson>("/api/presentation");
    if (destroyed) return;

    if (project.slides.length === 0) {
      iframe.srcdoc = wrapSlideDocument("<p>此簡報沒有投影片</p>");
      return;
    }

    // Tracer bullet scope: render the first 投影片 only. Multi-slide
    // navigation is out of scope for this ticket.
    const [firstSlidePath] = project.slides;
    const svgMarkup = await fetchText(`/api/files/${firstSlidePath}`);
    if (destroyed) return;

    iframe.srcdoc = wrapSlideDocument(svgMarkup);
  }

  void reload();

  return {
    reload,
    destroy: () => {
      destroyed = true;
      // Remove exactly the element this call created — never the
      // container's other children. The container belongs to React
      // (ADR-0001); this module has no business deciding what else lives
      // in it. `.remove()` is also a no-op if the iframe is already
      // detached, so double-destroy stays safe.
      iframe.remove();
    },
  };
}

function wrapSlideDocument(bodyMarkup: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${bodyMarkup}</body></html>`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`載入失敗：${path}`);
  }
  return response.text();
}

/**
 * The canvas: a vanilla DOM module. React hands it a container element and
 * never touches what ends up inside it (ADR-0001) — the 投影片 is the
 * artifact loaded from the presentation file, not something React computes
 * from state.
 *
 * `reload()` is the seam future tickets hook into: #5's change-push handler
 * calls it directly when the watched file changes on disk, redrawing the
 * slide without React re-rendering anything.
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

  async function reload(): Promise<void> {
    const project = await fetchJson<ProjectJson>("/api/presentation");
    if (destroyed) return;

    if (project.slides.length === 0) {
      container.textContent = "此簡報沒有投影片";
      return;
    }

    // Tracer bullet scope: render the first 投影片 only. Multi-slide
    // navigation is out of scope for this ticket.
    const [firstSlidePath] = project.slides;
    const svgMarkup = await fetchText(`/api/files/${firstSlidePath}`);
    if (destroyed) return;

    container.innerHTML = svgMarkup;
  }

  void reload();

  return {
    reload,
    destroy: () => {
      destroyed = true;
    },
  };
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

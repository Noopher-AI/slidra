/**
 * The titlebar's own read of `/api/presentation` (ticket #51). Deliberately
 * duplicates overview.ts's fetch of the same endpoint rather than sharing a
 * module — same reasoning overview.ts already gives for duplicating
 * canvas.ts's own document-wrapping helpers: the two callers have different
 * lifecycles (React state here, a self-refreshing vanilla module there), and
 * `mountOverview`'s signature staying free of an injected value is worth one
 * extra GET.
 */
export interface PresentationInfo {
  name: string;
  canvas: { width: number; height: number };
}

/** Non-2xx, or an invalid canvas size, throws — never a fabricated fallback. */
export async function fetchPresentationInfo(): Promise<PresentationInfo> {
  const response = await fetch("/api/presentation");
  if (!response.ok) {
    throw new Error("載入失敗：/api/presentation");
  }
  const data = (await response.json()) as { name?: unknown; canvas?: { width?: unknown; height?: unknown } };
  const { width, height } = data.canvas ?? {};
  if (!(typeof width === "number" && width > 0 && typeof height === "number" && height > 0)) {
    throw new Error("project.json 的 canvas 尺寸無效，無法決定簡報資訊");
  }
  if (typeof data.name !== "string") {
    throw new Error("project.json 的 name 無效，無法決定簡報資訊");
  }
  return { name: data.name, canvas: { width, height } };
}

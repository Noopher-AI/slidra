/**
 * The titlebar's own read of `/api/presentation` (ticket #51). Deliberately
 * duplicates overview.ts's fetch of the same endpoint rather than sharing a
 * module — same reasoning overview.ts already gives for duplicating
 * canvas.ts's own document-wrapping helpers: the two callers have different
 * lifecycles (React state here, a self-refreshing vanilla module there), and
 * `mountOverview`'s signature staying free of an injected value is worth one
 * extra GET.
 */
/** One `templates` entry, shape aligned with core's `TemplateEntry` (web doesn't import core's project-json, so it's restated here). */
export interface TemplateInfo {
  file: string;
  name: string;
}

export interface PresentationInfo {
  name: string;
  canvas: { width: number; height: number };
  /**
   * `project.json`'s `templates` (the "new slide" menu and the
   * template management dialog). Absent, or not an array, is treated as
   * "declared no templates" — a `[]`, not a format error: `project-json.ts`
   * already rejects a genuinely malformed `templates` field server-side, so
   * anything this loose check lets through here is honestly untyped, not
   * corrupt.
   *
   * `templates` entries may be either a legacy bare string or a
   * post-upgrade `{ file, name }` object (`project-json.ts`'s
   * `TemplateEntry`) — this restates `readTemplateEntries`'s normalization
   * (a bare string, or a missing/non-string `name`, becomes the file's
   * basename without `.svg`) so both shapes end up as `TemplateInfo`.
   */
  templates: TemplateInfo[];
}

/** Non-2xx, or an invalid canvas size, throws — never a fabricated fallback. */
export async function fetchPresentationInfo(): Promise<PresentationInfo> {
  const response = await fetch("/api/presentation");
  if (!response.ok) {
    throw new Error("載入失敗：/api/presentation");
  }
  const data = (await response.json()) as {
    name?: unknown;
    canvas?: { width?: unknown; height?: unknown };
    templates?: unknown;
  };
  const { width, height } = data.canvas ?? {};
  if (!(typeof width === "number" && width > 0 && typeof height === "number" && height > 0)) {
    throw new Error("project.json 的 canvas 尺寸無效，無法決定簡報資訊");
  }
  if (typeof data.name !== "string") {
    throw new Error("project.json 的 name 無效，無法決定簡報資訊");
  }
  const templates: TemplateInfo[] = Array.isArray(data.templates)
    ? data.templates.map(extractTemplateInfo).filter((info): info is TemplateInfo => info !== null)
    : [];
  return { name: data.name, canvas: { width, height }, templates };
}

/** Basename of a virtual path with its extension dropped, e.g. `templates/001.svg` → `001`. */
function basenameWithoutExtension(file: string): string {
  const basename = file.split("/").pop() ?? file;
  return basename.replace(/\.[^.]+$/, "");
}

/** Normalizes a `templates` entry regardless of shape — a bare string, or `{ file, name }` — into a `TemplateInfo`, mirroring `readTemplateEntries`'s fallback. Returns `null` for anything else (honestly-untyped, not corrupt — see `PresentationInfo.templates`). */
function extractTemplateInfo(entry: unknown): TemplateInfo | null {
  if (typeof entry === "string") return { file: entry, name: basenameWithoutExtension(entry) };
  if (typeof entry === "object" && entry !== null && typeof (entry as { file?: unknown }).file === "string") {
    const file = (entry as { file: string }).file;
    const name = (entry as { name?: unknown }).name;
    return { file, name: typeof name === "string" ? name : basenameWithoutExtension(file) };
  }
  return null;
}

export interface PresentationInfoLoaderCallbacks {
  onSuccess(info: PresentationInfo): void;
  onError(message: string): void;
}

export interface PresentationInfoLoader {
  load(): void;
}

/**
 * Same generation-guard shape as overview.ts's own `applyAspectRatio`
 * (its `aspectGeneration` counter) — the two share the same root cause:
 * `App.tsx`'s live-reload handler calls `load()` again on every
 * `presentation-changed` event, so two rapid saves start two independent,
 * unguarded fetches. Without this guard, a slower older response can
 * settle after a newer one and silently overwrite it with stale — or
 * outright wrong — titlebar metadata, and this held until the next save
 * or a manual reload (found in code review, #48 gate round 1). Both
 * outcomes are guarded, not just success: an older *failed* request
 * settling late must not clear correct metadata with a fabricated error
 * banner either.
 */
export function createPresentationInfoLoader(callbacks: PresentationInfoLoaderCallbacks): PresentationInfoLoader {
  let generation = 0;
  return {
    load() {
      const thisGeneration = ++generation;
      void (async () => {
        try {
          const info = await fetchPresentationInfo();
          if (generation !== thisGeneration) return;
          callbacks.onSuccess(info);
        } catch (error) {
          if (generation !== thisGeneration) return;
          callbacks.onError(error instanceof Error ? error.message : "簡報資訊載入失敗");
        }
      })();
    },
  };
}

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
  /**
   * `project.json`'s `templates` (NOOP-141's 新增投影片 menu). Absent, or
   * not a string array, is treated as "declared no templates" — a `[]`, not
   * a format error: `project-json.ts` already rejects a genuinely malformed
   * `templates` field server-side, so anything this loose check lets
   * through here is honestly untyped, not corrupt.
   */
  templates: string[];
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
  const templates =
    Array.isArray(data.templates) && data.templates.every((entry) => typeof entry === "string")
      ? (data.templates as string[])
      : [];
  return { name: data.name, canvas: { width, height }, templates };
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

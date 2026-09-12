import type { ServerResponse } from "node:http";
import { CoMotionError, CoMotionNotFoundError } from "./comotion/errors.js";
import { listEntries as listCommandEntries, loadProject as loadProjectFromCli, readPresentationText, renderSlide } from "./comotion/reads.js";
import { runJsonCommand } from "./comotion/command.js";
import type { ProjectJson } from "./comotion/project-json.js";
import { handleRawRequest } from "./raw.js";

/**
 * The three read-only routes every comotion HTTP server needs to render a
 * presentation, extracted out of `serve.ts` (NOOP-93, §3.6) so the export
 * server (`export/server.ts`) can share them verbatim instead of keeping a
 * second, independently-drifting copy. In particular `/api/files/`'s "a
 * slide path is rendered, everything else is `cat`" branch is exactly the
 * kind of thing that silently stops doing `{{ slide_number }}` substitution
 * if it ever forks into two copies.
 *
 * [E4.T9]/F7: every read here now spawns the Rust `comotion` binary
 * (`comotion/reads.ts`) instead of dispatching against an in-process
 * `CommandRegistry` — the HTTP-facing behaviour is unchanged.
 */

export { listCommandEntries as listEntries };

export async function loadProject(id: string): Promise<ProjectJson> {
  return loadProjectFromCli(id);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function contentTypeFor(virtualPath: string): string {
  if (virtualPath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (virtualPath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

/** `GET /api/presentation`. */
export async function handlePresentationRoute(presentationId: string, res: ServerResponse): Promise<void> {
  const project = await loadProject(presentationId);
  sendJson(res, 200, project);
}

/**
 * `GET /api/assets` (#303 背景圖片面板): the `assets/` folder's entries, for
 * the "選現有檔案" dropdown. A brand-new presentation has no `assets/`
 * directory at all yet — that is not an error here, just an empty list.
 */
export async function handleAssetsRoute(presentationId: string, res: ServerResponse): Promise<void> {
  try {
    const entries = await listCommandEntries(presentationId, "assets");
    sendJson(res, 200, { entries });
  } catch (error) {
    if (error instanceof CoMotionNotFoundError) {
      sendJson(res, 200, { entries: [] });
      return;
    }
    throw error;
  }
}

/** `GET /api/files/<virtual path>`. `virtualPath` is already percent-decoded by the caller. */
export async function handleFilesRoute(presentationId: string, virtualPath: string, res: ServerResponse): Promise<void> {
  // The virtual path space is the only path space (ADR-0004): whatever the
  // caller asks for goes straight into `cat`'s virtual-path lookup, which
  // structurally cannot resolve outside the presentation. There is no
  // separate "escape" case to special-case here — it is just another
  // not-found.
  //
  // A slide path is rendered for display — `{{ slide_number }}` and its
  // siblings substituted (NOOP-90/T4) — while every other path
  // (project.json, assets/*) keeps reading through `cat` unchanged.
  const project = await loadProject(presentationId);
  try {
    const content = project.slides.includes(virtualPath)
      ? await renderSlide(presentationId, virtualPath)
      : await readPresentationText(presentationId, virtualPath);
    res.writeHead(200, { "Content-Type": contentTypeFor(virtualPath) });
    res.end(content);
  } catch (error) {
    // Same narrow classification `/api/raw/` uses (ticket #11): only a
    // failure that positively proves absence is a 404. Everything else is
    // a 500, because "not classified as not-found" is not evidence the
    // file is missing.
    if (error instanceof CoMotionNotFoundError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    if (error instanceof CoMotionError) {
      sendJson(res, 500, { error: error.message });
      return;
    }
    throw error;
  }
}

/**
 * The normalized "nothing here yet" shape `/api/effects/` returns for a
 * declared slide that has never had a `<comot:effects>` written to it
 * ([E4.T7] D3). Mirrors `effect list`'s own defaults
 * (`packages/core/src/effects/index.ts`'s step derivation and
 * `packages/core/src/slide/transition.ts`'s `DEFAULT_TRANSITION`) exactly,
 * so a caller can treat "never edited" and "edited to be empty" the same
 * way without special-casing either.
 */
export const EMPTY_EFFECT_PLAN = {
  effects: [],
  steps: [],
  transition: {
    enter: { effect: "none", duration: 0.6 },
    exit: { effect: "none", duration: 0.5 },
  },
};

/**
 * `GET /api/effects/<virtual path>` ([E4.T7], plan 4.3): the step plan the
 * player and step-by-step export now fetch instead of computing themselves
 * in the browser (`apps/web/src/player-plan.ts`'s former `deriveSteps`/
 * `parseEffects`). Spawns the Rust `comotion effect list` command
 * ([E4.T9]/F7) rather than dispatching against an in-process registry.
 *
 * Deliberately narrower than `effect list`'s own command-layer contract
 * (D8): only a declared SLIDE is accepted here, not a template — the
 * player only ever plays slides, so a template path is reported as 404
 * ("not a slide") rather than silently returning a plan for it.
 */
export async function handleEffectsRoute(presentationId: string, virtualPath: string, res: ServerResponse): Promise<void> {
  const project = await loadProject(presentationId);
  if (!project.slides.includes(virtualPath)) {
    sendJson(res, 404, { error: `不是投影片：${virtualPath}` });
    return;
  }
  const result = await runJsonCommand<{ effects: unknown; steps: unknown; transition: unknown }>([
    "effect", "list", presentationId, virtualPath,
  ]);
  if (!result.ok) {
    if (result.failureKind === "not-found") {
      // A declared slide that has never had `<comot:effects>` written to
      // it — the command reports "沒有效果清單" (not-found); the route
      // normalizes that into a legal empty plan (D3) rather than
      // forwarding a 404 for a path that IS a real slide.
      sendJson(res, 200, EMPTY_EFFECT_PLAN);
      return;
    }
    // A damaged effect list (`failureKind === "failed"`) is forwarded
    // verbatim, unmodified, unprefixed — the command's own message is
    // already a complete, printable explanation.
    sendJson(res, 500, { error: result.message });
    return;
  }
  sendJson(res, 200, result.data);
}

/**
 * `GET /api/raw/<virtual path>`. `virtualPath` is already percent-decoded
 * by the caller — decoding can throw on malformed percent-escapes, and
 * that failure mode is the caller's to report (a 400), not this route's.
 */
export async function handleRawRoute(
  presentationId: string,
  virtualPath: string,
  res: ServerResponse,
  rangeHeader: string | undefined,
): Promise<void> {
  // The srcdoc iframe (canvas.ts) is an opaque-origin document (ADR-0009
  // sandboxing), so its @font-face url("/api/raw/fonts/...") load is a
  // cross-origin fetch even though it targets this same server — without
  // this header the browser silently refuses to use the font. `*` is safe
  // here: every /api/raw/ response is either public asset bytes gated only
  // by knowing an opaque presentation id, or a 404, never anything
  // credentialed.
  res.setHeader("Access-Control-Allow-Origin", "*");
  await handleRawRequest(presentationId, virtualPath, res, rangeHeader);
}

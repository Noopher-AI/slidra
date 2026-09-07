/**
 * [E2.T17] plan §4.2: the `ImportedAsset`/kind + canvas-size → `element
 * insert` input conversion, pulled out as a pure function (same reasoning
 * as `TextPanel.tsx`'s `textPanelInsertInput` — this codebase's React
 * component tests are all `renderToStaticMarkup`, so an interactive
 * decision like "what geometry does this asset get" can only be unit
 * tested by extracting it from under the JSX). Shared by `App.tsx`'s
 * drag/drop-and-paste path and the three Image/Video/Audio panels below,
 * so a dropped file and a panel-inserted one always produce the same shape
 * of element (D9 — a deliberate behaviour change from `App.tsx`'s previous,
 * now-removed inline geometry).
 */

export type MediaAssetKind = "image" | "video" | "audio";

export interface MediaInsertInput {
  kind: "image" | "video" | "audio" | "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  /** `image` only. */
  href?: string;
  /** Present whenever a real asset was imported; absent for an empty placeholder insert. */
  media?: string;
  /** [E2.T17] Present only for a third-party player embed (YouTube) — `media` is then the player URL, not a path inside the presentation. */
  embed?: string;
}

/**
 * Percentage-of-canvas boxes (plan §4.2's "抄原型 `MEDIA_BOX`"), the same
 * box for a real import and for that kind's empty placeholder — only
 * whether `href`/`media` get set differs.
 */
const MEDIA_BOX: Record<MediaAssetKind, { l: number; t: number; w: number; h: number }> = {
  image: { l: 56, t: 20, w: 36, h: 60 },
  video: { l: 56, t: 20, w: 36, h: 60 },
  audio: { l: 9, t: 56, w: 82, h: 22 },
};

/**
 * `kind` is the asset's own byte-detected kind (`ImportedAsset.kind` from
 * `resolveAssetImport`) when `path` is non-null — NOT necessarily the panel
 * the user opened (ADR-0015: format identity never comes from which panel
 * was open, plan §4.2 "在 Video 面板選了一個 PNG"). When `path` is null
 * (the "Insert" button pressed with no file/URL chosen), `kind` is instead
 * the panel's own identity, since there is no byte-detected asset to defer
 * to — this is what produces each kind's own empty placeholder shape.
 *
 * `canvasSize` is always the presentation's own real canvas size (`project.json`'s
 * `canvas`), never a hard-coded 1280×720 — same rule as `textPanelInsertInput`.
 */
export function mediaInsertInput(
  kind: MediaAssetKind,
  path: string | null,
  canvasSize: { width: number; height: number },
): MediaInsertInput {
  const box = MEDIA_BOX[kind];
  const x = (canvasSize.width * box.l) / 100;
  const y = (canvasSize.height * box.t) / 100;
  const width = (canvasSize.width * box.w) / 100;
  const height = (canvasSize.height * box.h) / 100;

  if (path === null) {
    // Empty placeholder: an image panel with nothing picked cannot become
    // `kind: "image"` (that kind requires `--href`, plan §4.2's own note),
    // so it degrades to a bare `rect` frame instead. video/audio keep their
    // own kind — `element insert` accepts both with no `--media` (§4.5).
    return kind === "image" ? { kind: "rect", x, y, width, height } : { kind, x, y, width, height };
  }

  // Slides live under `slides/`, assets under `assets/` (siblings of the
  // presentation root) — the virtual path returned by asset import is
  // root-relative ("assets/x.png"), so every slide-side reference needs `../`.
  const media = `../${path}`;
  return kind === "image" ? { kind: "image", x, y, width, height, href: media, media } : { kind, x, y, width, height, media };
}

/**
 * [E2.T17]: a YouTube link's own insert input. Same box as an ordinary
 * video (MEDIA_BOX.video) so an embed and a file sit in the same place on
 * the slide — the only difference is that `media` holds the player URL and
 * `embed` names the provider, which is what routes it to the parent
 * document's embed overlay instead of the slide's own media layer
 * (`packages/core/src/embed.ts` explains why it cannot live in the iframe).
 */
export function embedInsertInput(
  embed: { provider: string; url: string },
  canvasSize: { width: number; height: number },
): MediaInsertInput {
  const box = MEDIA_BOX.video;
  return {
    kind: "video",
    x: (canvasSize.width * box.l) / 100,
    y: (canvasSize.height * box.t) / 100,
    width: (canvasSize.width * box.w) / 100,
    height: (canvasSize.height * box.h) / 100,
    media: embed.url,
    embed: embed.provider,
  };
}

/**
 * Whether a just-inserted element should also get a `media`/`play` effect
 * started `on-click` — i.e. "advance one step in play mode and it plays".
 * Without one, an inserted video is an element the effect list knows
 * nothing about, so play mode has nothing to trigger.
 *
 * A third-party embed counts too: it has no `<video>` of its own, but the
 * effect still reaches it — the runtime forwards the intent and the
 * parent's embed overlay speaks the player's own API (`embed.ts`'s
 * `embedCommandMessage`). A placeholder with no media yet is excluded —
 * there is nothing to play.
 *
 * A predicate rather than a function that dispatches the command, so the
 * decision has one home and one unit test while each panel keeps its own
 * (already-awaited) command sequence.
 */
export function shouldAutoPlayOnClick(input: MediaInsertInput): boolean {
  if (input.media === undefined) return false;
  return input.kind === "video" || input.kind === "audio";
}

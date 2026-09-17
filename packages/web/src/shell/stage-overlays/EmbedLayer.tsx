// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useEffect, useRef, useState } from "react";
import { embedPlayerSrc } from "../../embed.js";
import type { CanvasController, EmbedState } from "../../canvas.js";
import { bindYouTubePlayer, loadYouTubeApi, type YouTubePlayer } from "./youtube-player.js";

export interface EmbedLayerProps {
  controller: CanvasController | null;
}

/**
 * [E2.T17] Third-party video embeds (YouTube), rendered as real `<iframe>`
 * elements in THIS document — the parent — rather than inside the slide
 * iframe.
 *
 * Why it cannot live in the slide iframe: that document is a `srcdoc`
 * document sandboxed with `allow-scripts` and, deliberately, no
 * `allow-same-origin` (ADR-0007 — with both, untrusted slide content can
 * script itself free of the sandbox, because `srcdoc` inherits the parent's
 * origin). Measured against the real player: under `allow-scripts` alone
 * YouTube refuses to load at all (`embedder.identity.missing.referrer`,
 * origin `null`), and adding `allow-same-origin` is exactly what ADR-0007
 * forbids. A nested iframe's sandbox flags are the INTERSECTION with its
 * parent's, so the permission cannot be granted to just the embed from the
 * inside either. Hosting the player here is what keeps the sandbox token
 * byte-for-byte unchanged.
 *
 * Unlike every other layer under `stage-overlays/`, this one is rendered
 * OUTSIDE `Stage.tsx`'s `shellVisible` gate: an embed has to keep playing
 * in play mode and in fullscreen, where `OverlayLayer` is unmounted.
 *
 * Geometry is not computed here. Both runtimes measure their own
 * placeholder with `getBoundingClientRect()` and post an `embed-boxes`
 * event; `canvas.ts` converts iframe-local px to parent client px, and this
 * component only subtracts its own container's origin — the same
 * `toLocalRect` shape `OverlayLayer` already uses.
 */
export function EmbedLayer({ controller }: EmbedLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<EmbedState>({ items: [], interactive: false });

  const framesRef = useRef(new Map<string, HTMLIFrameElement>());

  useEffect(() => {
    if (!controller) {
      setState({ items: [], interactive: false });
      return;
    }
    return controller.subscribeEmbeds(setState);
  }, [controller]);

  // id -> the YT.Player bound to that iframe, once the API has loaded and
  // the player has reported itself ready. Absent until then, which is the
  // same state as "the embed is still loading" — a command that arrives
  // early is dropped, never queued, because a `media` effect means "play
  // now", and replaying it a second later against a step the audience has
  // already moved past would be worse than not playing.
  const playersRef = useRef(new Map<string, YouTubePlayer>());

  const youtubeIds = state.items
    .filter((item) => item.provider === "youtube")
    .map((item) => item.id)
    .join(",");

  useEffect(() => {
    const ids = youtubeIds === "" ? [] : youtubeIds.split(",");
    const players = playersRef.current;

    // Tear down players whose element is gone (slide change): YT.Player
    // owns listeners on a frame this component no longer renders.
    for (const [id, player] of [...players]) {
      if (ids.includes(id)) continue;
      players.delete(id);
      player.destroy();
    }
    if (ids.length === 0) return;

    let cancelled = false;
    void loadYouTubeApi().then(
      (api) => {
        if (cancelled) return;
        for (const id of ids) {
          if (players.has(id)) continue;
          const frame = framesRef.current.get(id);
          if (!frame) continue;
          // Registered only on `onReady` — a player object that exists but
          // has not handshaken still ignores commands.
          const player = bindYouTubePlayer(api, frame, () => {
            if (!cancelled) players.set(id, player);
          });
        }
      },
      () => {
        // Offline, or the script blocked. The embed still renders and the
        // viewer can press the player's own play button; only the
        // effect-driven command is unavailable. Nothing to report — this
        // is not a damaged slide.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [youtubeIds]);

  // A `family="media"` effect that landed on an embed. The slide runtime
  // has no `<video>` to call `.play()` on, so it forwarded the intent and
  // this is where it becomes the provider's own API call.
  useEffect(() => {
    if (!controller) return;
    return controller.subscribeEmbedCommand(({ id, command }) => {
      const player = playersRef.current.get(id);
      if (!player) return;
      if (command === "play") player.playVideo();
      else player.pauseVideo();
    });
  }, [controller]);

  if (state.items.length === 0) return null;

  const origin = layerRef.current?.getBoundingClientRect();
  const originX = origin?.left ?? 0;
  const originY = origin?.top ?? 0;

  return (
    <div className="embed-layer" ref={layerRef}>
      {state.items.map((item) => (
        <iframe
          key={item.id}
          className="embed-frame"
          id={`slidra-embed-${item.id}`}
          data-embed-id={item.id}
          data-embed-provider={item.provider}
          ref={(node) => {
            if (node) framesRef.current.set(item.id, node);
            else framesRef.current.delete(item.id);
          }}
          // The stored URL plus whatever the provider needs to accept
          // remote-control commands (`enablejsapi=1` for YouTube) — that
          // parameter is a rendering detail and is deliberately not written
          // into the slide file.
          src={embedPlayerSrc(item.provider, item.url)}
          title={item.url}
          // The player's own origin, not the slide's — this iframe loads a
          // real https document, so it is NOT the sandboxed srcdoc frame
          // ADR-0007 is about and needs no sandbox token of its own.
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          style={{
            left: `${item.rect.x - originX}px`,
            top: `${item.rect.y - originY}px`,
            width: `${item.rect.width}px`,
            height: `${item.rect.height}px`,
            // View mode: the author is editing, and a player that took the
            // click would make its own element unselectable — the same
            // reasoning behind `.media-overlay-el`'s `pointer-events:none`
            // in the slide's stage media layer. Play mode: the audience is
            // watching, so the player takes its own clicks.
            pointerEvents: state.interactive ? "auto" : "none",
          }}
        />
      ))}
    </div>
  );
}

"use client";

// The embeddable player (/embed?deck=…[#slide]): the <slidra-player> web
// component (lib/element/) filling the frame, plus a link to the full
// viewer. Only this server's own decks play here.

import { useEffect, useState } from "react";

export default function EmbedShell() {
  const [deck, setDeck] = useState(null);
  const [start, setStart] = useState(1);
  const [slide, setSlide] = useState(1);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const deckUrl = new URLSearchParams(location.search).get("deck") ?? "";
    // An embed never fetches a URL from its query string that is not one of this server's decks.
    if (!deckUrl.startsWith("/decks/")) {
      setStatus("Nothing to play: the embed code names no deck on this server.");
      return;
    }
    import("../../lib/element/index.js").then(() => {
      const first = Math.max(1, Number.parseInt(location.hash.slice(1), 10) || 1);
      setStart(first);
      setSlide(first);
      setDeck(deckUrl);
    });
  }, []);

  useEffect(() => {
    const player = document.getElementById("player");
    if (!player) return;
    const follow = (event) => setSlide(event.detail.slide);
    player.addEventListener("slidechange", follow);
    player.focus();
    return () => player.removeEventListener("slidechange", follow);
  }, [deck]);

  return (
    <main className="embed">
      {deck ? <slidra-player id="player" src={deck} slide={String(start)} controls="" runtime-src="/js/player-runtime.js" class="embed-player"></slidra-player> : null}
      {deck ? (
        <a id="e-open" className="embed-open" href={`/?deck=${encodeURIComponent(deck)}#${slide}`} target="_blank" rel="noopener">
          Open in Slidra ↗
        </a>
      ) : null}
      {status ? (
        <p id="e-status" className="embed-status" role="status">
          {status}
        </p>
      ) : null}
    </main>
  );
}

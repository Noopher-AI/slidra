import { useCallback, useEffect, useState } from "react";
import type { CanvasState } from "../../../canvas.js";
import { readSlideTransition, type SlideTransition } from "@co-motion/core/slide";

/** Same "this page never had one set" meaning `readSlideTransition` itself defaults to — reused here so a fetch failure degrades to the identical values a slide with no `<comot:transition>` at all would show. */
const DEFAULT_TRANSITION: SlideTransition = {
  enter: { effect: "none", duration: 0.6 },
  exit: { effect: "none", duration: 0.5 },
};

export interface SlideTransitionState {
  /** `null` while the first fetch for the current slide is still in flight. */
  transition: SlideTransition | null;
  /** Re-fetches the current slide's markup — call after a `slide transition set` command settles, mirroring `useSlideEffects`'s own `refresh()`. */
  refresh(): void;
}

/**
 * [E2.T11]: `AnimatePagePanel`'s own data source, modeled directly on
 * `useSlideEffects` — independent of `CanvasState` for the same reason
 * (canvas.ts's minimal-touch scope does not extend to exposing a general
 * "current slide's parsed transition" field), reading the same
 * `/api/files/<slidePath>` byte stream through the same
 * `readSlideTransition` core reader `canvas.ts`'s own play-mode renderer
 * uses, so "what the panel shows" and "what will actually play" can never
 * quietly disagree.
 */
export function useSlideTransition(state: CanvasState): SlideTransitionState {
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;
  const [transition, setTransition] = useState<SlideTransition | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!slidePath) {
      setTransition(DEFAULT_TRANSITION);
      return;
    }
    let cancelled = false;
    setTransition(null);
    void fetch(`/api/files/${slidePath}`)
      .then((response) => response.text())
      .then((svg) => {
        if (cancelled) return;
        // §4.2/§4.7: a slide whose transition cannot be read shows the
        // panel's default values rather than an error — the play-mode
        // error banner is the one surface for a genuinely malformed
        // `<comot:transition>` (canvas.ts's renderPlay).
        try {
          setTransition(readSlideTransition(svg));
        } catch {
          setTransition(DEFAULT_TRANSITION);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setTransition(DEFAULT_TRANSITION);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshToken is a manual re-fetch trigger, not a value read inside the effect.
  }, [slidePath, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { transition, refresh };
}

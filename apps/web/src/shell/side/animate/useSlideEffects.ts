// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { useCallback, useEffect, useState } from "react";
import type { CanvasState } from "../../../canvas.js";
import { fetchSlideEffectPlan, invalidateSlideEffectPlans, type Effect } from "../../../effects.js";

/** `target` id -> what the Object list needs to label its card that `parseEffects` itself does not carry: its `data-slidra-name`, and — only when `target` is an actual group `<g>` with ≥2 `<g>` children (ADR-0012's own group-vs-leaf distinction) — how many members it has (D5's "Group N (n)" card). */
export interface TargetInfo {
  name: string | null;
  groupMemberCount: number | null;
}

export interface SlideEffectsState {
  /** In file order — the same order `effect move`'s 1-based addressing (D6) uses. `null` while the first fetch for the current slide is still in flight. */
  effects: Effect[] | null;
  targetInfo: Map<string, TargetInfo>;
  /** Re-fetches the current slide's markup — call after any `effect *`/`element group`/`element ungroup` command settles, so the panel does not wait for the next unrelated reload() to pick up its own write. */
  refresh(): void;
}

/**
 * `AnimateObjectPanel`'s own data source. Deliberately
 * independent of `CanvasState`/`OverlayState` — `canvas.ts`'s minimal-touch
 * scope (`hasAnimation`/`badges`/preview) does not extend to exposing a
 * general "current slide's parsed effect list" field, and the panel does
 * not need push-frequency updates the way overlay geometry does. Two
 * independent fetches run in parallel (2.2: not worth a combined route
 * for) — `fetchSlideEffectPlan` (the same cached `/api/effects/` route
 * client the player uses, so "what the panel shows" and "what will
 * actually play" can never quietly disagree) for the effect list, and a
 * plain `/api/files/<slidePath>` markup fetch for `parseTargetInfo`'s
 * id/name/group-size lookup, which the effects route does not carry.
 */
export function useSlideEffects(state: CanvasState): SlideEffectsState {
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;
  const [effects, setEffects] = useState<Effect[] | null>(null);
  const [targetInfo, setTargetInfo] = useState<Map<string, TargetInfo>>(new Map());
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!slidePath) {
      setEffects([]);
      setTargetInfo(new Map());
      return;
    }
    let cancelled = false;
    setEffects(null);
    // A slide whose effect list fails to parse shows an
    // empty list here too — same posture as OverlayState.hasAnimation/
    // badges and the GUI behaviour table's "effect list parse failure ->
    // treat as empty list, no error popup" row.
    const effectsPromise = fetchSlideEffectPlan(slidePath)
      .then((plan) => plan.effects)
      .catch(() => []);
    const targetInfoPromise = fetch(`/api/files/${slidePath}`)
      .then((response) => response.text())
      .then(parseTargetInfo)
      .catch(() => new Map<string, TargetInfo>());
    void Promise.all([effectsPromise, targetInfoPromise]).then(([nextEffects, nextTargetInfo]) => {
      if (cancelled) return;
      setEffects(nextEffects);
      setTargetInfo(nextTargetInfo);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshToken is a manual re-fetch trigger, not a value read inside the effect.
  }, [slidePath, refreshToken]);

  const refresh = useCallback(() => {
    if (slidePath) invalidateSlideEffectPlans(slidePath);
    setRefreshToken((token) => token + 1);
  }, [slidePath]);

  return { effects, targetInfo, refresh };
}

function parseTargetInfo(svg: string): Map<string, TargetInfo> {
  const info = new Map<string, TargetInfo>();
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch {
    return info;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return info;
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    const id = el.getAttribute("id");
    if (!id) continue;
    const name = el.getAttribute("data-slidra-name");
    const children = Array.from(el.children);
    const isGroup =
      el.tagName.toLowerCase() === "g" && children.length > 0 && children.every((child) => child.tagName.toLowerCase() === "g");
    info.set(id, { name, groupMemberCount: isGroup ? children.length : null });
  }
  return info;
}

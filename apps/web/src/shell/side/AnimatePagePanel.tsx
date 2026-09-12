// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import type { PageTransitionEffect } from "../../effects.js";
import type { CanvasController, CanvasState } from "../../canvas.js";
import { useSlideTransition } from "./animate/useSlideTransition.js";
import { PageTransitionView } from "./animate/PageTransitionView.js";

export interface AnimatePagePanelProps {
  state: CanvasState;
  controller: CanvasController | null;
}

/**
 * Animate > Page (§4.7): `useSlideTransition` supplies the data; each action
 * immediately sends `slide transition set` (D14: one command = one
 * `writePresentationFile` = one undo entry, so no undo code is written
 * here). Calls `refresh()` to re-read the file after a command succeeds —
 * it doesn't wait for the next unrelated reload() to see its own change;
 * on failure it neither calls `refresh()` nor changes the UI (mirroring
 * `AnimateObjectPanel`).
 */
export function AnimatePagePanel({ state, controller }: AnimatePagePanelProps) {
  const { transition, refresh } = useSlideTransition(state);
  const slidePath = state.currentIndex >= 0 ? state.slides[state.currentIndex] : null;

  if (!slidePath || transition === null) {
    return <div className="animate-page-panel" role="tabpanel" aria-label="Animate · Page" />;
  }

  async function runTransitionCommand(input: Record<string, unknown>): Promise<void> {
    if (!controller || !slidePath) return;
    const result = await controller.runCommand("slide transition set", { slidePath, ...input });
    if (result.ok) refresh();
  }

  function handleChangeEnterEffect(effect: PageTransitionEffect): void {
    void runTransitionCommand({ enter: effect });
  }
  function handleChangeEnterDuration(duration: number): void {
    void runTransitionCommand({ enterDuration: duration });
  }
  function handleChangeExitEffect(effect: PageTransitionEffect): void {
    void runTransitionCommand({ exit: effect });
  }
  function handleChangeExitDuration(duration: number): void {
    void runTransitionCommand({ exitDuration: duration });
  }
  function handleApplyAll(): void {
    void runTransitionCommand({ all: true });
  }

  return (
    <PageTransitionView
      transition={transition}
      onChangeEnterEffect={handleChangeEnterEffect}
      onChangeEnterDuration={handleChangeEnterDuration}
      onChangeExitEffect={handleChangeExitEffect}
      onChangeExitDuration={handleChangeExitDuration}
      onApplyAll={handleApplyAll}
    />
  );
}

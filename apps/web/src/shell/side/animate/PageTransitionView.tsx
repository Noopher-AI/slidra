// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { PageTransitionEffect, SlideTransition } from "../../../effects.js";

/** The value set both `enter` and `exit` share (§4.1) — only the GUI label differs by direction (`ENTER_LABELS`/`EXIT_LABELS` below). */
const EFFECTS: readonly PageTransitionEffect[] = ["none", "fade", "slide", "zoom"];

const ENTER_LABELS: Record<PageTransitionEffect, string> = {
  none: "None",
  fade: "Fade",
  slide: "Slide in",
  zoom: "Zoom in",
};
const EXIT_LABELS: Record<PageTransitionEffect, string> = {
  none: "None",
  fade: "Fade",
  slide: "Slide out",
  zoom: "Zoom out",
};

/** Prototype's own slider range (`Slidra (New v3).dc.html:674-686`) — deliberately narrower than the CLI's value domain (any finite, ≥0 duration is legal there); a value outside it still displays its real number, the slider handle just clamps to whichever end is closer (§4.7). */
const DURATION_MIN = 0.2;
const DURATION_MAX = 1.5;
const DURATION_STEP = 0.1;

function clampForSlider(duration: number): number {
  return Math.min(Math.max(duration, DURATION_MIN), DURATION_MAX);
}

export interface PageTransitionViewProps {
  transition: SlideTransition;
  onChangeEnterEffect(effect: PageTransitionEffect): void;
  onChangeEnterDuration(duration: number): void;
  onChangeExitEffect(effect: PageTransitionEffect): void;
  onChangeExitDuration(duration: number): void;
  onApplyAll(): void;
}

interface EdgeSectionProps {
  title: string;
  labels: Record<PageTransitionEffect, string>;
  effect: PageTransitionEffect;
  duration: number;
  onChangeEffect(effect: PageTransitionEffect): void;
  onChangeDuration(duration: number): void;
}

function EdgeSection({ title, labels, effect, duration, onChangeEffect, onChangeDuration }: EdgeSectionProps) {
  return (
    <div className="animate-page-section" data-edge={title.toLowerCase()}>
      <div className="animate-page-section-header">
        <span>{title}</span>
        <span className="animate-page-duration-value">{duration}s</span>
      </div>
      <div className="animate-page-effect-cards">
        {EFFECTS.map((value) => (
          <button
            key={value}
            type="button"
            className={value === effect ? "animate-page-effect-card selected" : "animate-page-effect-card"}
            aria-pressed={value === effect}
            onClick={() => onChangeEffect(value)}
          >
            {labels[value]}
          </button>
        ))}
      </div>
      <input
        type="range"
        className="animate-page-duration-slider"
        min={DURATION_MIN}
        max={DURATION_MAX}
        step={DURATION_STEP}
        value={clampForSlider(duration)}
        onChange={(event) => onChangeDuration(Number(event.target.value))}
      />
    </div>
  );
}

/**
 * Animate › Page's presentational half (§4.7): pure props,
 * renderable with `renderToStaticMarkup` — data-fetching and command
 * dispatch live in the container (`AnimatePagePanel.tsx`), same split as
 * `AnimateObjectPanel.tsx`/`ObjectList.tsx`.
 */
export function PageTransitionView({
  transition,
  onChangeEnterEffect,
  onChangeEnterDuration,
  onChangeExitEffect,
  onChangeExitDuration,
  onApplyAll,
}: PageTransitionViewProps) {
  return (
    <div className="animate-page-panel" role="tabpanel" aria-label="Animate · Page">
      <EdgeSection
        title="Enter"
        labels={ENTER_LABELS}
        effect={transition.enter.effect}
        duration={transition.enter.duration}
        onChangeEffect={onChangeEnterEffect}
        onChangeDuration={onChangeEnterDuration}
      />
      <EdgeSection
        title="Exit"
        labels={EXIT_LABELS}
        effect={transition.exit.effect}
        duration={transition.exit.duration}
        onChangeEffect={onChangeExitEffect}
        onChangeDuration={onChangeExitDuration}
      />
      <button type="button" className="animate-page-apply-all" onClick={onApplyAll}>
        Apply to all slides
      </button>
    </div>
  );
}

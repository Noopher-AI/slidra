// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

export interface StageBadge {
  target: string;
  /** 1-based, the target's first effect entry position in the file (matches Animate › Object's own card order). */
  n: number;
  /** `.stage-overlays`-relative px (already converted by `OverlayLayer`). */
  rect: { x: number; y: number; width: number; height: number };
}

export interface BadgeLayerProps {
  badges: StageBadge[];
  onSelect(target: string): void;
}

/**
 * The stage's numbered animation badges — one per element that
 * has at least one effect on the current slide, positioned at that
 * element's own top-left corner (CSS centres the circle on the point via
 * `transform`, see `animate.css`). Rendered only while the right rail sits
 * on Animate (gated by the caller, `OverlayLayer` — this component itself
 * has no opinion on which tab is active) and never during play/preview
 * (badges come from `OverlayState.badges`, which `canvas.ts` only ever
 * populates in view mode).
 */
export function BadgeLayer({ badges, onSelect }: BadgeLayerProps) {
  if (badges.length === 0) return <div className="badge-layer" />;
  return (
    <div className="badge-layer">
      {badges.map((badge) => (
        <button
          key={badge.target}
          type="button"
          className="animation-badge"
          style={{ left: badge.rect.x, top: badge.rect.y }}
          title={`Animation ${badge.n}`}
          aria-label={`Animation number ${badge.n}`}
          onClick={() => onSelect(badge.target)}
        >
          {badge.n}
        </button>
      ))}
    </div>
  );
}

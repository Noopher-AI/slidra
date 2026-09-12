// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import { formatZoomPercent } from "../stage-view.js";

export interface ZoomControlProps {
  zoom: number;
  open: boolean;
  onToggle(): void;
}

/** The toolbar's percentage button; clicking toggles the ZoomMenu open/closed. */
export function ZoomControl({ zoom, open, onToggle }: ZoomControlProps) {
  return (
    <button
      type="button"
      className="dock-zoom-control"
      title="Zoom (⌘0 fit · ⌘+ · ⌘−)"
      aria-expanded={open}
      onClick={onToggle}
    >
      {formatZoomPercent(zoom)}
    </button>
  );
}

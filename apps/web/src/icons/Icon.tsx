// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties } from "react";
import { ICON_REGISTRY, type IconName } from "./registry.js";

export type { IconName } from "./registry.js";

export type IconSize = "inline" | "control" | "command";

export interface IconProps {
  name: IconName;
  /** Defaults to "command". Maps to --icon-inline / --icon-control / --icon-command. */
  size?: IconSize;
  /** Extra class for the caller to position the icon. Never used to override colour or stroke. */
  className?: string;
}

const SIZE_TOKEN: Record<IconSize, string> = {
  inline: "var(--icon-inline)",
  control: "var(--icon-control)",
  command: "var(--icon-command)",
};

/**
 * A single icon, drawn on the canonical `0 0 20 20` grid regardless of
 * `size`. Always `aria-hidden` with no prop to turn that off — an
 * accessible name comes from the caller's own `aria-label` / `title` /
 * adjacent text, matching every existing call site (PlayChrome.tsx's
 * `aria-label`, StatusBar.tsx's `title`, Ribbon.tsx's sibling `<span>`).
 * Colour and stroke width are never inline literals: colour is always
 * `currentColor`, stroke width is always the `--icon-stroke` token.
 */
export function Icon({ name, size = "command", className }: IconProps) {
  const content = ICON_REGISTRY[name];
  if (!content) throw new Error(`Unknown icon name: ${name}`);

  const dimension = SIZE_TOKEN[size];
  const style: CSSProperties = {
    width: dimension,
    height: dimension,
    stroke: "currentColor",
    fill: "none",
    strokeWidth: "var(--icon-stroke)",
  };

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" style={style} className={className}>
      {content}
    </svg>
  );
}

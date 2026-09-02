import type { ReactElement } from "react";

/**
 * The 22 icons that exist in the product today. This registry is
 * exhaustive by construction (`Record<IconName, ReactElement>` below) —
 * adding a name here without a value is a type error, and there is no
 * name in here that isn't already drawn somewhere in the app (NOOP-3
 * does not speculate about icons a future feature might want).
 */
export type IconName =
  // 17 ribbon command icons — paths traced verbatim from
  // packages/web/src/shell/Ribbon.tsx's `ICON` map (already 0 0 20 20).
  | "plus"
  | "template"
  | "paste"
  | "cut"
  | "copy"
  | "textbox"
  | "shape"
  | "arrange"
  | "image"
  | "video"
  | "audio"
  | "number"
  | "none"
  | "fade"
  | "fromstart"
  | "fromhere"
  | "fullscr"
  // 2 play-nav icons — packages/web/src/shell/PlayChrome.tsx, originally
  // viewBox 0 0 16 16, coordinates below are ×1.25 onto the 20×20 canonical grid.
  | "prev"
  | "next"
  // 3 status-bar view icons — packages/web/src/shell/StatusBar.tsx, originally
  // viewBox 0 0 16 16, coordinates below are ×1.25 onto the 20×20 canonical grid.
  | "view-normal"
  | "view-grid"
  | "view-play";

/**
 * Canonical grid for every icon is `0 0 20 20` (Icon.tsx always renders
 * this viewBox regardless of `size`). Content is JSX, not an HTML string —
 * this registry does not use `dangerouslySetInnerHTML`. Colour is always
 * `currentColor` (or, for "fade", the deliberate 50%-opacity fill copied
 * from Ribbon.tsx's own rule) and geometry is unitless (SVG user units),
 * so nothing here hard-codes a hex/rgb colour or a px size.
 */
export const ICON_REGISTRY: Record<IconName, ReactElement> = {
  // ── Ribbon.tsx:43-59, traced from docs/design/base-shell.html's `const I` ──
  plus: <path d="M10 4v12M4 10h12" />,
  template: (
    <>
      <rect x={3} y={2.5} width={14} height={15} />
      <path d="M6 6.5h8M6 10h8M6 13.5h5" />
    </>
  ),
  paste: (
    <>
      <rect x={5} y={3} width={10} height={14} />
      <path d="M8 3V1.5h4V3" />
    </>
  ),
  cut: (
    <>
      <circle cx={5} cy={15} r={2} />
      <circle cx={15} cy={15} r={2} />
      <path d="M6 13.5L14 3M14 13.5L6 3" />
    </>
  ),
  copy: (
    <>
      <rect x={3} y={3} width={9} height={11} />
      <path d="M6 16h8V6" />
    </>
  ),
  textbox: (
    <>
      <rect x={2.5} y={5} width={15} height={10} />
      <path d="M7 8h6M10 8v4" />
    </>
  ),
  shape: (
    <>
      <circle cx={7} cy={7} r={4.5} />
      <rect x={8} y={9} width={8} height={8} />
    </>
  ),
  arrange: (
    <>
      <rect x={2.5} y={2.5} width={9} height={9} />
      <rect x={8} y={8} width={9} height={9} />
    </>
  ),
  image: (
    <>
      <rect x={2.5} y={3.5} width={15} height={13} />
      <circle cx={7} cy={8} r={1.5} />
      <path d="M3 15l5-5 4 4 2-2 3 3" />
    </>
  ),
  video: (
    <>
      <rect x={2.5} y={4.5} width={10} height={11} />
      <path d="M13 8l4.5-2.5v9L13 12z" />
    </>
  ),
  audio: (
    <>
      <path d="M4 8v4h3l4 3.5V4.5L7 8z" />
      <path d="M13.5 7.5a4 4 0 010 5" />
    </>
  ),
  number: (
    <>
      <rect x={2.5} y={3.5} width={15} height={13} />
      <path d="M12 14h3" />
    </>
  ),
  none: (
    <>
      <circle cx={10} cy={10} r={7} />
      <path d="M5 15L15 5" />
    </>
  ),
  fade: (
    <>
      <circle cx={10} cy={10} r={7} />
      <path d="M10 3a7 7 0 010 14z" fill="currentColor" stroke="none" opacity={0.5} />
    </>
  ),
  fromstart: (
    <>
      <path d="M6 4l9 6-9 6z" />
      <path d="M3 4v12" />
    </>
  ),
  fromhere: <path d="M5 4l9 6-9 6z" />,
  fullscr: <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />,

  // ── PlayChrome.tsx:172-184, originally viewBox 0 0 16 16 — ×1.25 below ──
  // prev: "M10 3 L5 8 L10 13" × 1.25
  prev: <path d="M12.5 3.75 L6.25 10 L12.5 16.25" />,
  // next: "M6 3 L11 8 L6 13" × 1.25
  next: <path d="M7.5 3.75 L13.75 10 L7.5 16.25" />,

  // ── StatusBar.tsx:94-125, originally viewBox 0 0 16 16 — ×1.25 below ──
  // view-normal: rect(1.5,2.5,4,11) + rect(7.5,2.5,7,11), each × 1.25
  "view-normal": (
    <>
      <rect x={1.875} y={3.125} width={5} height={13.75} />
      <rect x={9.375} y={3.125} width={8.75} height={13.75} />
    </>
  ),
  // view-grid: four rects, each × 1.25
  "view-grid": (
    <>
      <rect x={1.875} y={3.125} width={6.875} height={5.625} />
      <rect x={11.25} y={3.125} width={6.875} height={5.625} />
      <rect x={1.875} y={11.25} width={6.875} height={5.625} />
      <rect x={11.25} y={11.25} width={6.875} height={5.625} />
    </>
  ),
  // view-play: "M4 2.5 L13 8 L4 13.5 Z" × 1.25
  "view-play": <path d="M5 3.125 L16.25 10 L5 16.875 Z" />,
};

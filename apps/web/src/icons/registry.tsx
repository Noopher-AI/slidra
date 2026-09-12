// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import type { ReactElement } from "react";

/**
 * The 22 icons that exist in the product today. This registry is
 * exhaustive by construction (`Record<IconName, ReactElement>` below) —
 * adding a name here without a value is a type error, and there is no
 * name in here that isn't already drawn somewhere in the app (NOOP-376
 * does not speculate about icons a future feature might want).
 */
export type IconName =
  // 17 ribbon command icons — paths traced verbatim from
  // apps/web/src/shell/Ribbon.tsx's `ICON` map (already 0 0 20 20).
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
  // 2 play-nav icons — apps/web/src/shell/PlayChrome.tsx, originally
  // viewBox 0 0 16 16, coordinates below are ×1.25 onto the 20×20 canonical grid.
  | "prev"
  | "next"
  // 3 status-bar view icons — apps/web/src/shell/StatusBar.tsx, originally
  // viewBox 0 0 16 16, coordinates below are ×1.25 onto the 20×20 canonical grid.
  | "view-normal"
  | "view-grid"
  | "view-play"
  // New v3 shell (this ticket) — every path below is copied verbatim from
  // docs/design/prototype/slidra-logic-v3.js's `ICONS` constant (already
  // 0 0 20 20), or from the prototype HTML inline SVGs for the titlebar
  // buttons that have no `ICONS` entry (undo/redo/open/save/export/play/
  // hand — noted per-icon below).
  | "hand" // prototype HTML titlebar toolbar button, not in the ICONS constant
  | "undo" // prototype HTML titlebar, not in the ICONS constant
  | "redo" // prototype HTML titlebar, not in the ICONS constant
  | "open" // prototype HTML titlebar "Open…" button, not in the ICONS constant
  | "save" // prototype HTML titlebar "Save" button, not in the ICONS constant
  | "export" // prototype HTML titlebar "Export" button, not in the ICONS constant
  | "play" // prototype HTML titlebar "Play" button (filled triangle), not in the ICONS constant
  | "table"
  | "chart"
  | "rect"
  | "ellipse"
  | "line"
  | "spark" // Animate
  | "group"
  | "trash"
  | "dup"
  | "comment"
  | "edit" // Context bar: Edit style
  | "forward" // Context bar: Bring forward
  | "backward" // Context bar: Send backward
  | "alignL"
  | "alignC"
  | "alignR"
  | "alignT"
  | "alignM"
  | "alignB"
  | "distH"
  | "distV"
  | "front"
  | "back"
  // Animate > Object list reorder/remove — neither the prototype nor the
  // existing 22 icons has a matching glyph, so these two are new additions
  // rather than a rename of any existing icon.
  | "chevron-up"
  | "chevron-down"
  | "close"
  // [E3.T5]: titlebar settings (gear) button — no existing icon or
  // prototype path covers a gear, so this one is hand-drawn to the same
  // 0 0 20 20 grid/stroke-1.5 contract as every other icon here: eight
  // teeth swept between root r=5.6 and tip r=7.6 around a r=2.6 hub, so
  // its 2.47..17.53 extent matches the neighbouring save/close icons.
  | "settings"
  // The stop button used to be the literal word "stop", which clashed in
  // tone with the send arrow next to it — this is a solid square on the
  // same 0 0 20 20 grid instead (the conventional player "stop" glyph).
  | "stop";

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
  stop: <rect x={5.5} y={5.5} width={9} height={9} rx={1.5} fill="currentColor" stroke="none" />,
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

  // ── New v3 shell — paths copied verbatim from docs/design/prototype/
  // slidra-logic-v3.js's `ICONS` constant, or (where noted above in
  // IconName) from the prototype HTML's own inline titlebar SVGs. ──
  hand: <path d="M7 11V4.5a1.2 1.2 0 012.4 0V9M9.4 9V3.5a1.2 1.2 0 012.4 0V9M11.8 9V4.5a1.2 1.2 0 012.4 0V10M14.2 10V6.5a1.2 1.2 0 012.4 0V13c0 3-2 5.5-5.5 5.5S9 17 7.5 15.5L4.2 11.6a1.2 1.2 0 011.9-1.5L7 11" />,
  undo: (
    <>
      <path d="M7 6L3.5 9.5 7 13" />
      <path d="M4 9.5h8a4 4 0 010 8H9" />
    </>
  ),
  redo: (
    <>
      <path d="M13 6l3.5 3.5L13 13" />
      <path d="M16 9.5H8a4 4 0 000 8h3" />
    </>
  ),
  open: (
    <>
      <path d="M2.5 6.5V4.5h5l1.5 2h8.5v9h-15z" />
      <path d="M2.5 8.5h15" />
    </>
  ),
  save: (
    <>
      <path d="M3 3h11l3 3v11H3z" />
      <path d="M6 3v5h7V3" />
      <rect x={6} y={11.5} width={8} height={5.5} />
    </>
  ),
  export: (
    <>
      <path d="M10 12V3M6.5 6.5L10 3l3.5 3.5" />
      <path d="M3.5 12v4.5h13V12" />
    </>
  ),
  play: <path d="M5 4l9 6-9 6z" fill="currentColor" stroke="none" />,
  table: (
    <>
      <rect x={2.5} y={3.5} width={15} height={13} rx={1.5} />
      <path d="M2.5 8h15M7.5 8v8.5M12.5 8v8.5" />
    </>
  ),
  chart: <path d="M3 17h14M5 14V9M9 14V5M13 14v-3M17 14V7" />,
  rect: <rect x={3} y={4} width={14} height={12} rx={1.5} />,
  ellipse: <ellipse cx={10} cy={10} rx={7.5} ry={6} />,
  line: <path d="M3 16L17 4" />,
  spark: <path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8z" />,
  group: (
    <>
      <rect x={2.5} y={2.5} width={7} height={7} rx={1.5} />
      <rect x={10.5} y={10.5} width={7} height={7} rx={1.5} />
      <path d="M2.5 13v4.5h4M17.5 7V2.5h-4" strokeDasharray="2 2" />
    </>
  ),
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />,
  dup: (
    <>
      <rect x={6} y={6} width={11} height={11} rx={2} />
      <path d="M3 14V3h11" />
    </>
  ),
  comment: <path d="M3 4h14v9H9l-4 3v-3H3z" />,
  edit: (
    <>
      <path d="M4 16h3l9-9-3-3-9 9z" />
      <path d="M11.5 5.5l3 3" />
    </>
  ),
  alignL: <path d="M4 3v14M8 6h8v3H8zM8 11h5v3H8z" />,
  alignC: <path d="M10 3v14M6 6h8v3H6zM7.5 11h5v3h-5z" />,
  alignR: <path d="M16 3v14M4 6h8v3H4zM7 11h5v3H7z" />,
  alignT: <path d="M3 4h14M6 8h3v8H6zM11 8h3v5h-3z" />,
  alignM: <path d="M3 10h14M6 6h3v8H6zM11 7.5h3v5h-3z" />,
  alignB: <path d="M3 16h14M6 4h3v8H6zM11 7h3v5h-3z" />,
  distH: <path d="M3 3v14M17 3v14M7.5 7h5v6h-5z" />,
  distV: <path d="M3 3h14M3 17h14M7 7.5h6v5H7z" />,
  forward: (
    <>
      <rect x={5} y={7} width={10} height={10} rx={1.5} />
      <path d="M10 5V1.5M7.5 4L10 1.5 12.5 4" />
    </>
  ),
  backward: (
    <>
      <rect x={5} y={3} width={10} height={10} rx={1.5} />
      <path d="M10 15v3.5M7.5 16l2.5 2.5 2.5-2.5" />
    </>
  ),
  front: (
    <>
      <rect x={3} y={3} width={10} height={10} rx={1.5} />
      <path d="M8 17h9V8" />
    </>
  ),
  back: (
    <>
      <rect x={7} y={7} width={10} height={10} rx={1.5} />
      <path d="M12 3H3v9" />
    </>
  ),
  "chevron-up": <path d="M5 12.5l5-5 5 5" />,
  "chevron-down": <path d="M5 7.5l5 5 5-5" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  settings: (
    <>
      <circle cx={10} cy={10} r={2.6} />
      <path d="M8.79 4.53L9.01 2.47A7.6 7.6 0 0 1 10.99 2.47L11.21 4.53A5.6 5.6 0 0 1 13.01 5.28L14.63 3.97A7.6 7.6 0 0 1 16.03 5.37L14.72 6.99A5.6 5.6 0 0 1 15.47 8.79L17.53 9.01A7.6 7.6 0 0 1 17.53 10.99L15.47 11.21A5.6 5.6 0 0 1 14.72 13.01L16.03 14.63A7.6 7.6 0 0 1 14.63 16.03L13.01 14.72A5.6 5.6 0 0 1 11.21 15.47L10.99 17.53A7.6 7.6 0 0 1 9.01 17.53L8.79 15.47A5.6 5.6 0 0 1 6.99 14.72L5.37 16.03A7.6 7.6 0 0 1 3.97 14.63L5.28 13.01A5.6 5.6 0 0 1 4.53 11.21L2.47 10.99A7.6 7.6 0 0 1 2.47 9.01L4.53 8.79A5.6 5.6 0 0 1 5.28 6.99L3.97 5.37A7.6 7.6 0 0 1 5.37 3.97L6.99 5.28Z" />
    </>
  ),
};

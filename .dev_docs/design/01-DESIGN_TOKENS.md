# 01 · Design Tokens

The design language inherits from Holspire (warm-white shell, brand red, Plus Jakarta Sans) and extends it for the "dark stage + glass overlay" editor context. All values live as inline styles in the prototype; this document is the authoritative source.

## Color

### Brand / accent
| Token | Value | Use |
|---|---|---|
| `brand.red` | `#C8233B` | Primary actions, selection box, pin numbers, play button, switch-on state |
| `brand.red.hover` | `#A81C31` | Hover/pressed for the above; emphasized text (Slide 3 · sub) |
| `brand.red.tint` | `#FDE8EA` | Light red fill (Comment to AI hover, BETA, AI avatar background, freeze notice) |
| `brand.red.tint2` | `#FBD9DD` | Light red fill hover |
| `brand.red.ring` | `#F5C6CC` | Light red outline (active card, spinner track) |
| `brand.red.glow` | `rgba(200,35,59,.28)` | box-shadow glow when jumping to a pin |

### Shell neutrals (warm)
| Token | Value | Use |
|---|---|---|
| `surface.0` | `#FBF9F8` | App background, title bar, status bar |
| `surface.1` | `#F5F1EF` | Thumbnail rail background, segmented control background, secondary chip |
| `surface.2` | `#ECE5E2` | Dividers, borders, selected row background, hover |
| `surface.3` | `#F3EDEA` | Very faint dividers |
| `surface.white` | `#FFFFFF` | Panels, cards, inputs |
| `ink.900` | `#1F1A1A` | Primary text, black button (Preview) |
| `ink.800` | `#2B2424` | Message body text |
| `ink.700` | `#3A322F` | Toolbar button text |
| `ink.600` | `#4B4341` | Command/script text |
| `ink.500` | `#6E635F` | Secondary text, field labels |
| `ink.400` | `#9A8F8C` | Hint text, section headers |
| `ink.300` | `#B4A9A6` | Fainter hints, shortcut key text |
| `ink.200` | `#D9CFCB` | Dashed borders, switch-off state |

### Stage (dark)
| Token | Value | Use |
|---|---|---|
| `well.bg` | `#3A3A3D` | Stage area background (editing) |
| `well.play` | `#000000` | Play-mode background |
| `slide.bg.a` | `#14161A` | Slide background color A |
| `slide.bg.b` | `#1B1D24` | Slide background color B |
| `slide.ink` | `#F4F6F8` | Slide titles |
| `slide.ink.2` | `#E7E9EE` | Table/body text |
| `slide.muted` | `#A9B0B8` | Subtitles, axis labels, table headers |
| `slide.line` | `rgba(255,255,255,.1)` | Gridlines, table borders |
| `guide` | `#FF5C7A` | Alignment guides |

### Semantic colors
| Token | Value | Use |
|---|---|---|
| `ok` | `#3BA55D` / text `#2E7D4F` / bg `#EAF6EE` | Done badge |
| `info` | `#5B6DEA` / bg `#EEF0FD` | PDF+ label, chart secondary color |
| `accent.palette.brand` | `#C8233B #5B6DEA #4A8F45 #E08A2E #2B9E75 #A9B0B8` | Default chart palette, slide accent |
| `accent.palette.cool` | `#5B6DEA #2B9E75 #38BDF8 #A78BFA #22C55E #94A3B8` | |
| `accent.palette.warm` | `#C8233B #E08A2E #F4C542 #D9634C #B45309 #A9B0B8` | |

## Typography
| Token | Value |
|---|---|
| `font.ui` | `'Plus Jakarta Sans','Noto Sans TC','PingFang TC','Microsoft JhengHei',system-ui,sans-serif` |
| `font.mono` | `ui-monospace, Menlo, monospace` (commands/scripts, shortcut keys, media labels) |
| `font.slide` | Same as `font.ui`; in-slide font sizes are expressed in `cqw` (container-width %) so they scale with the stage |

### Font sizes (UI)
| Token | px | Use |
|---|---|---|
| `text.2xs` | 9.5–10 | Chart type labels, BETA |
| `text.xs` | 10.5–11 | Section headers (uppercase, .06em tracking), hints, shortcut keys |
| `text.sm` | 11.5–12 | Buttons, chips, panel body text |
| `text.base` | 12.5–13 | Primary UI text, messages |
| `text.md` | 13.5–14 | Filenames, panel titles |
| `text.lg` | 16–18 | Dialog titles, overview title |

### Font sizes (slide, container units)
| Element | Value |
|---|---|
| Title (centered layout) | `6.2cqw / 700` |
| Title (left/right layout) | `4.6cqw / 700` |
| Subtitle | `2.6cqw / 400` |
| Body | `2.2cqw / 400`; caption `1.6cqw` |
| Table | Header `1.5cqw` uppercase; body `2cqw` |

## Spacing and sizing
| Token | Value |
|---|---|
| `space.1..6` | 4 / 6 / 8 / 10 / 12 / 14 px |
| `space.8` | 16 px (panel padding) |
| `space.gutter` | 28px 36px (stage margin) + 76px reserved at the bottom for the toolbar |
| `titlebar.h` | 48 px |
| `toolbar.h` | 46 px (floating glass) |
| `statusbar.h` | 36 px |
| `rail.w` | 212 px |
| `panel.w` | 340 px |
| `notes.h` | 112 px |
| `control.h` | 30–34 px (button/input); 28 px compact variant |
| `hit.min` | 28 px |
| `deck.card.w` | 220 px (Deck Space grid card minimum width) |

## Radius
| Token | Value | Use |
|---|---|---|
| `radius.xs` | 5–6 px | Labels, pin numbers |
| `radius.sm` | 7–8 px | Buttons, chips |
| `radius.md` | 9–10 px | Inputs, segmented control |
| `radius.lg` | 12 px | Menus, cards |
| `radius.xl` | 14–16 px | Glass panels, dialogs |
| `radius.2xl` | 18–20 px | Large dialogs, empty-state cards |
| `radius.pill` | 999px | Badges, playback control bar |
| `stage.radius` | 6 px | Slide frame |

## Shadows
| Token | Value |
|---|---|
| `shadow.seg` | `0 1px 3px rgba(40,20,20,.12), 0 1px 2px rgba(40,20,20,.06)` — segmented control selected state |
| `shadow.menu` | `0 12px 32px rgba(40,20,20,.12)` |
| `shadow.dialog` | `0 24px 64px rgba(40,20,20,.25)` |
| `shadow.red` | `0 4px 12px rgba(200,35,59,.22)` — primary CTA, pin |
| `shadow.stage` | `0 1px 2px rgba(0,0,0,.4), 0 24px 64px -16px rgba(0,0,0,.7)` |
| `shadow.glass` | `inset 0 1px 0 rgba(255,255,255,.6), 0 12px 32px rgba(0,0,0,.28)` |

## Glass material
All overlays on the stage (toolbar, contextual bar, comment box, chart data window) share this material:
```
background: rgba(255,255,255,.72)   /* contextual bar / comment box .55 */
backdrop-filter: blur(22px) saturate(1.5)
border: 1px solid rgba(31,26,26,.10)
box-shadow: shadow.glass
border-radius: 12–16px
```
Button hover inside glass: `rgba(31,26,26,.07)`; dividers `rgba(31,26,26,.1)`; inputs `rgba(255,255,255,.38)` → focus `.55`.

## Motion
| Token | Value | Use |
|---|---|---|
| `ease.out` | `cubic-bezier(.2,.8,.2,1)` | Entrances, menu growth |
| `ease.in` | `cubic-bezier(.4,0,.8,.4)` | Page exit |
| `dur.fast` | 100–150 ms | Hover, menus |
| `dur.base` | 180–260 ms | Panel switches, overview |
| `hs-fade` | 4px shift up + fade in | Panels/cards |
| `hs-grow` | 8px shift up + scale .96 → 1 | Menus that grow directly above the toolbar |
| `hs-pop` | 6px shift up (centered) | Legacy contextual bar |
| Object entrance | `cm-a-fade / flyup / flyleft / zoom / wipe` | Default .6s |
| Page entrance | `cm-t-fade / slide / zoom` (two copies, a/b, for replay) | Default .6s |
| Page exit | `cm-x-fade / slide / zoom` | Default .5s |
| Charts | `cg-grow / growx / fade / dash` embedded in the SVG `<style>` | Self-contained |

## Icons
20×20 viewBox, `stroke:currentColor; fill:none; stroke-width:1.5` (1.6–1.8 at small sizes); corner `rx` 1.5–2. All defined in the `ICONS` constant.

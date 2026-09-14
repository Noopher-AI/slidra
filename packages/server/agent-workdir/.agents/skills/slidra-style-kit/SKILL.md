---
name: slidra-style-kit
description: Pick one of 25 color palettes and one of 10 shape languages and write them into plan/design-spec.md (palette, type scale table, fonts, spacing, shape language); a one-sentence description of the desired feel does a fuzzy match. Use when the author's message starts with /slidra-style-kit or when slidra-plan needs to fit a style
---

# Style library

Style decides **who appears to be speaking** in this deck. It has two layers, swappable independently:

1. **Color palette** (the 25 below) — color codes, type scale table, fonts, spacing anchors; one file each at `references/<number>-<name>.md`.
2. **Shape language** (the 10 in `shapes/`) — corner radii, decoration density, whitespace rhythm, font character, material. **It contains no color at all**, so any shape language can pair with any palette; each palette's JSON declares a default `shape_language`.

**The catalog is a starting point, not a whitelist.** When none fits exactly, take the closest one and modify it, or mix your own — as long as you fill in every `design-spec` field and write one sentence in the prose with its name and why. A palette is a set: splitting it into two and mixing them loses its logic; the type scale and spacing can be fine-tuned.

## Input

- The free text after `/slidra-style-kit` is the matching basis: temperament, occasion, industry, color leanings, reference targets.
- Without text, read the topic and `mode` in `plan/outline.md` and judge yourself.
- When `plan/design-spec.md` already exists, first ask the author whether to replace or fine-tune.

## Steps

1. **Read the index** (the two tables below), fuzzy-match the author's description against the "first-second feel" column, and pick the single best fit plus two alternates.
2. **Read only the chosen file**: `references/<number>-<name>.md`. One at a time.
3. **Confirm the canvas**: `slidra cat <presentation-id> project.json`. When it is not 1280×720, multiply every font size and `layout` anchor by `k = width ÷ 1280`.
4. **Fonts**: the style's `typography` names two families, heading/body. When one is not in the deck (`fonts` in `project.json`), import it with `slidra font import` per the list in `reference/fonts.md` — copy `--family`, `--license`, `--source` verbatim from the list. When import fails, fall back to the built-in `Noto Sans TC` and say what's missing in the report. At most 2 CJK families.
5. **Pick the shape language**: when the author's description mentions shape, material, or texture ("rounder", "looks hand-drawn", "like ink wash", "more restrained"), read the matching file in `shapes/` and replace the default; a deck has exactly one shape language.
6. **Write it in**: `slidra plan set <presentation-id> design-spec '<full text>'` (JSON section fields per `slidra-plan`). Write one sentence in the prose about why this palette and this shape language.
7. **Report**: in the format below, with the two alternates.

## The 10 shape languages

| Shape language | One line |
|---|---|
| `plain` | Right angles, no shadows, minimal decoration. The default, hardest to get wrong |
| `swiss-minimal` | Grid-locked, sharp edges, aggressive whitespace, near-zero decoration |
| `soft-rounded` | Rounded cards, soft lift, no sharp edges |
| `glass` | Translucent glass panels floating over a colored base, a bright line at the edges |
| `paper-cut` | Layered cut paper, offset; the layers have thickness |
| `ink-wash` | Rice-paper whitespace, brush strokes, one seal as the only accent |
| `chalkboard` | Chalk on a dark board; strokes are grainy, edges uneven |
| `sketch-notes` | Hand-drawn doodle lines, slightly crooked boxes, casually drawn arrows |
| `brutalist` | Newspaper density, heavy black borders, raw structure |
| `data-dense` | Multi-column micro-charts, sidebars, source lines; density is the point |

## The 25 color palettes

| # | Name | First-second feel | Fits | Suggested background |
|---|---|---|---|---|
| 01 | `editorial-tech` | Dark, precise, restrained, like a tech blog's dark mode | Product explainers, tech sharing, developer events | 02, 03 |
| 02 | `warm-editorial` | Wine red on cream; papery, warm, human | Food, culture, brand stories, teaching | 01 |
| 03 | `clean-brief` | Blue text on white; quiet, trustworthy, unobtrusive | Consulting decks, internal reports, proposals | 02/off |
| 04 | `midnight-lab` | Fluorescent cyan on near-black; a late-night lab screen | Research, data analysis, monitoring, deep tech | 02 |
| 05 | `paper-craft` | Kraft paper and brown ink; fibrous, you want to touch it | Workshops, handcraft, local brands, classroom settings | 01 |
| 06 | `nordic-calm` | Gray-blue white; low temperature, quiet; whitespace is the content | Design proposals, product philosophy, moments that need calm | 01/off |
| 07 | `bold-poster` | Fluorescent yellow on black; type so big it breaks the frame | Event promotion, openings, slogan pages | 03 |
| 08 | `soft-pastel` | Pink, lotus, mint; round, soft, no sharp corners | Teaching, kids, community | 01 |
| 09 | `mono-print` | Pure black/white plus one red; a newspaper front page | Investigative reporting, fact presentation | off |
| 10 | `deep-ocean` | Deep blue-green; steady and deep but not cold | Sustainability, energy, long-term plans | 01 |
| 11 | `sunset-gradient` | A warm coral-to-amber family; evening light | Consumer products, launches, fundraising | 01 |
| 12 | `forest-field` | Deep moss green and straw; a managed woodland | Agriculture, food origins, ESG, local development | 01/02 |
| 13 | `blueprint` | Indigo with white lines; an unrolled engineering blueprint | Architecture explainers, engineering processes, construction | 02 |
| 14 | `academic` | Off-white paper with dark-red serif; a printed paper | Research talks, oral defenses, white papers | off |
| 15 | `startup-neon` | Magenta-purple on near-black; a 7 p.m. launch | Product launches, fundraising, recruiting | 01/03 |
| 16 | `terracotta-studio` | Terracotta and sand; a design studio's wall | Design proposals, space, craft, portfolios | 01 |
| 17 | `medical-clear` | Pure white and steel blue; a clean clinic | Medical, health, public health | off |
| 18 | `finance-slate` | Slate gray with champagne gold; a private bank's annual report | Financial reports, investment, investor briefings | 01 |
| 19 | `kids-bright` | Bright red, yellow, lake blue; a kindergarten classroom | Kids' teaching, parent-child, camps | 01 |
| 20 | `luxury-noir` | All black with champagne white; more whitespace than content | Brands, luxury goods, openings and closings | off |
| 21 | `civic-plain` | Gray-white with olive green; a proper government flyer | Public sector, public policy, non-profits | off |
| 22 | `zine-punk` | Copier black/white plus fluorescent; a handmade underground zine | Culture, music, subcultures, arts festivals | 02 |
| 23 | `sky-brief` | A very pale sky blue; looking out an airplane window | Travel, aviation, cloud, scale and motion | 01 |
| 24 | `archive-sepia` | Aged paper and brown ink; files in an archive drawer | History, museums, brand timelines | 01 |
| 25 | `spectrum-data` | A neutral base with a set of distinguishable category colors | Dashboards, data decks, multi-chart pages | off |

The "Suggested background" numbers are recipes in `slidra-background-kit`; `off` means this style suggests no background image — cleanliness is part of its persuasiveness.

## Report format

First line: "Style: <name> — <one-sentence feel>". Then three lines: palette (the seven role color codes), type scale (three representative values: `cover`/`title`/`body`), and fonts (heading/body families) with the shape language. The final line lists the two alternates and their differences; say that swapping them is just one request away.

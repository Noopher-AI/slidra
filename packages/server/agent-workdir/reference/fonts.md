# Font Library

Half of a style's character comes from its typefaces. This list is a **curated set of open-source fonts**: every one's license permits embedding and commercial use (SIL OFL 1.1 or Apache 2.0), and their CJK coverage is sufficient for a full presentation in the target script.

**Font files are not in the repo.** Import them from the URLs below with `slidra font import`; once imported, that `.slidra` carries the font with it, so it renders correctly on any other machine.

## How to run the import

```
slidra font import <presentation-id> <URL> --family '<family name>' --license '<license>' --source '<origin>'
```

`--family` must use the family name from the table below **verbatim** — it is the string later written into the SVG `font-family`. A typo fails at typesetting time.

## CJK (Traditional Chinese)

| Family name | Character | Good for | License | Source |
|---|---|---|---|---|
| `Noto Sans TC` | Neutral, modern, high information density. **Built in**, no import needed | Almost anything | SIL OFL 1.1 | https://fonts.google.com/noto/specimen/Noto+Sans+TC |
| `Noto Serif TC` | Formal, weighty, with clear stroke starts and ends | Reports, culture, credibility | SIL OFL 1.1 | https://fonts.google.com/noto/specimen/Noto+Serif+TC |
| `Source Han Serif TC` | A song-ti serif with a more bookish feel and larger counters | Narrative, publishing, long titles | SIL OFL 1.1 | https://github.com/adobe-fonts/source-han-serif |
| `jf open 粉圓` | Rounded, friendly, non-aggressive | Education, children/youth, community, light topics | SIL OFL 1.1 | https://justfont.com/jfopenhuninn |
| `cwTeXKai` | A kai script with a hand-written stroke-order feel | Humanities, calligraphy, traditional topics | SIL OFL 1.1 | https://github.com/l10n-tw/cwtex-q-fonts |

**CJK fonts are large** (5–15 MB). Import at most **2 CJK fonts** per presentation (one for titles, one for body); more makes the `.slidra` file hard to share.

## Latin (for English titles and numbers)

| Family name | Character | Good for | License | Source |
|---|---|---|---|---|
| `Inter` | Neutral, screen-optimized, clear numerals | Product, data, dashboards | SIL OFL 1.1 | https://fonts.google.com/specimen/Inter |
| `Space Grotesk` | Geometric, slightly techy quirk | Tech, startups, keynotes | SIL OFL 1.1 | https://fonts.google.com/specimen/Space+Grotesk |
| `Playfair Display` | High-contrast serif, refined, dramatic | Brand, fashion, large cover titles | SIL OFL 1.1 | https://fonts.google.com/specimen/Playfair+Display |
| `IBM Plex Mono` | Monospace, engineering/data feel | Tech talks, code, numbering | SIL OFL 1.1 | https://fonts.google.com/specimen/IBM+Plex+Mono |

Latin fonts are only 100–300 KB, so importing a few more is no burden. **But Latin fonts contain no CJK** — setting CJK text with one fails, so use them only for elements you are sure contain no CJK (big numbers, English titles, numbering).

## Rules

- **Text boxes with CJK content always use a CJK family.** Use Latin families only for elements guaranteed to have no CJK.
- Keep the number of families per presentation to **2–3** (1–2 CJK + 0–1 Latin). Do more differentiation through weight and size, not by swapping fonts.
- On import failure (download fails, can't parse), **fall back to `Noto Sans TC`** and say so in your report — don't let a whole presentation hang on one font.
- `--license` and `--source` are required, not for show: a presentation that embeds someone else's font must carry its terms.

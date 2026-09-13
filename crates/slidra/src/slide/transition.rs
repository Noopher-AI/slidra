// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Per-page enter/exit transitions (`slide transition set`), ported from
//! `packages/core/src/slide/transition.ts` (full file): a pure
//! `svg_content -> ...` splice reader/writer, modeled on `notes.rs`. Lives
//! under `<metadata>` as `<slidra:transition>`, a sibling of `<slidra:effects>`
//! and `<slidra:notes>`. `read_slide_transition` also backs `effect list`'s
//! `data.transition` (plan 4.1) — it does not touch `<slidra:effects>` at
//! all, only this sibling node under the same `<metadata>`.

use crate::errors::{SlidraError, SlidraResult};
use crate::slide::notes::NOTES_NS as TRANSITION_NS;
use crate::slide::scan::{ScannedNode, attribute_value, scan_document};
use crate::svgnum::format_svg_number;
use crate::text::runs::utf16_offset_to_byte_offset;

const TRANSITION_TAG: &str = "slidra:transition";
const METADATA_TAG: &str = "metadata";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageTransitionEffect {
    None,
    Fade,
    Slide,
    Zoom,
}

impl PageTransitionEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            PageTransitionEffect::None => "none",
            PageTransitionEffect::Fade => "fade",
            PageTransitionEffect::Slide => "slide",
            PageTransitionEffect::Zoom => "zoom",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "none" => Some(PageTransitionEffect::None),
            "fade" => Some(PageTransitionEffect::Fade),
            "slide" => Some(PageTransitionEffect::Slide),
            "zoom" => Some(PageTransitionEffect::Zoom),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SlideTransitionEdge {
    pub effect: PageTransitionEffect,
    pub duration: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SlideTransition {
    pub enter: SlideTransitionEdge,
    pub exit: SlideTransitionEdge,
}

/// §4.2: "this page never had one set" — the same meaning as an absent
/// `<slidra:transition>` and, on the read side, an unknown future value.
pub const DEFAULT_TRANSITION: SlideTransition = SlideTransition {
    enter: SlideTransitionEdge {
        effect: PageTransitionEffect::None,
        duration: 0.6,
    },
    exit: SlideTransitionEdge {
        effect: PageTransitionEffect::None,
        duration: 0.5,
    },
};

fn require_svg_root(roots: Vec<ScannedNode>) -> SlidraResult<ScannedNode> {
    roots
        .into_iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| SlidraError::invalid("root node of the slide is not <svg>"))
}

struct Located<'a> {
    metadata: Option<&'a ScannedNode>,
    transition: Option<&'a ScannedNode>,
}

fn locate_transition(svg_root: &ScannedNode) -> SlidraResult<Located<'_>> {
    let metadata = svg_root
        .children
        .iter()
        .find(|child| child.tag == METADATA_TAG);
    let Some(metadata) = metadata else {
        return Ok(Located {
            metadata: None,
            transition: None,
        });
    };
    let nodes: Vec<&ScannedNode> = metadata
        .children
        .iter()
        .filter(|child| child.tag == TRANSITION_TAG)
        .collect();
    if nodes.len() > 1 {
        return Err(SlidraError::invalid(format!(
            "the metadata of this slide has {} set(s) of page entrance/exit settings, but a slide can only have one, presentation is corrupted.",
            nodes.len()
        )));
    }
    Ok(Located {
        metadata: Some(metadata),
        transition: nodes.into_iter().next(),
    })
}

fn parse_effect_attr(raw: Option<&str>, label: &str) -> SlidraResult<PageTransitionEffect> {
    let Some(raw) = raw else {
        return Ok(PageTransitionEffect::None);
    };
    PageTransitionEffect::parse(raw).ok_or_else(|| {
        SlidraError::invalid(format!(
            "page entrance/exit {label} value \"{raw}\" is not implemented yet."
        ))
    })
}

fn parse_duration_attr(raw: Option<&str>, label: &str, fallback: f64) -> SlidraResult<f64> {
    let Some(raw) = raw else {
        return Ok(fallback);
    };
    let value = if raw.trim().is_empty() {
        f64::NAN
    } else {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    };
    if !value.is_finite() || value < 0.0 {
        return Err(SlidraError::invalid(format!(
            "page entrance/exit {label} value \"{raw}\" is not a valid number of seconds."
        )));
    }
    Ok(value)
}

/// Reads a slide's page enter/exit transition. Absent/missing pieces
/// default; a present-but-illegal value errors.
pub fn read_slide_transition(svg_content: &str) -> SlidraResult<SlideTransition> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(roots)?;
    let located = locate_transition(&svg_root)?;
    let Some(transition) = located.transition else {
        return Ok(DEFAULT_TRANSITION);
    };

    Ok(SlideTransition {
        enter: SlideTransitionEdge {
            effect: parse_effect_attr(attribute_value(transition, "enter").as_deref(), "enter")?,
            duration: parse_duration_attr(
                attribute_value(transition, "enter-duration").as_deref(),
                "enter-duration",
                DEFAULT_TRANSITION.enter.duration,
            )?,
        },
        exit: SlideTransitionEdge {
            effect: parse_effect_attr(attribute_value(transition, "exit").as_deref(), "exit")?,
            duration: parse_duration_attr(
                attribute_value(transition, "exit-duration").as_deref(),
                "exit-duration",
                DEFAULT_TRANSITION.exit.duration,
            )?,
        },
    })
}

/// Whether `svg_content` already carries a `<slidra:transition>` — used only
/// by the `formatVersion` 2→3 migration step to decide whether a slide
/// should be left alone rather than overwritten.
pub fn slide_has_transition_metadata(svg_content: &str) -> SlidraResult<bool> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(roots)?;
    Ok(locate_transition(&svg_root)?.transition.is_some())
}

/// Writes (creates or replaces) a slide's `<slidra:transition>`, always with
/// all four attributes filled in — partial merging against the slide's
/// current values is the caller's job; this function trusts whatever
/// `SlideTransition` it is given and only handles the splice.
pub fn set_slide_transition(
    svg_content: &str,
    transition: SlideTransition,
) -> SlidraResult<String> {
    let markup = format!(
        "<{TRANSITION_TAG} xmlns:slidra=\"{TRANSITION_NS}\" enter=\"{}\" enter-duration=\"{}\" exit=\"{}\" exit-duration=\"{}\"/>",
        transition.enter.effect.as_str(),
        format_svg_number(transition.enter.duration),
        transition.exit.effect.as_str(),
        format_svg_number(transition.exit.duration),
    );

    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(roots)?;
    let located = locate_transition(&svg_root)?;

    let Some(metadata) = located.metadata else {
        let block = format!("<{METADATA_TAG}>{markup}</{METADATA_TAG}>");
        let insert_at = utf16_offset_to_byte_offset(svg_content, svg_root.content_start);
        return Ok(format!(
            "{}{}{}",
            &svg_content[..insert_at],
            block,
            &svg_content[insert_at..]
        ));
    };
    let Some(existing) = located.transition else {
        let insert_at = utf16_offset_to_byte_offset(svg_content, metadata.content_start);
        return Ok(format!(
            "{}{}{}",
            &svg_content[..insert_at],
            markup,
            &svg_content[insert_at..]
        ));
    };
    let start = utf16_offset_to_byte_offset(svg_content, existing.start);
    let end = utf16_offset_to_byte_offset(svg_content, existing.end);
    Ok(format!(
        "{}{}{}",
        &svg_content[..start],
        markup,
        &svg_content[end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLANK_SVG: &str =
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"></svg>\n";

    /// Has a real child so `content_start` (before it) and `content_end`
    /// (after it) are distinct byte offsets — `BLANK_SVG` has none, so both
    /// collapse to the same point and a `.contains(...)` assertion on it
    /// cannot tell a "first child" insert from a "last child" one apart
    /// (confirmed by mutating the insertion point to `content_end`: `cargo
    /// test` still passed). Mirrors real slides — `demo/slides/001.svg`/
    /// `002.svg` have no `<metadata>` but do have sibling content.
    const SVG_WITH_CHILD: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><g id=\"el-a\"/></svg>\n";

    #[test]
    fn read_missing_transition_returns_default() {
        let t = read_slide_transition(BLANK_SVG).unwrap();
        assert_eq!(t, DEFAULT_TRANSITION);
    }

    #[test]
    fn write_creates_metadata_and_transition_when_absent() {
        let updated = set_slide_transition(
            SVG_WITH_CHILD,
            SlideTransition {
                enter: SlideTransitionEdge {
                    effect: PageTransitionEffect::Fade,
                    duration: 0.4,
                },
                exit: SlideTransitionEdge {
                    effect: PageTransitionEffect::None,
                    duration: 0.5,
                },
            },
        )
        .unwrap();
        assert_eq!(
            updated,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"fade\" enter-duration=\"0.4\" exit=\"none\" exit-duration=\"0.5\"/></metadata><g id=\"el-a\"/></svg>\n"
        );
        let read_back = read_slide_transition(&updated).unwrap();
        assert_eq!(read_back.enter.effect, PageTransitionEffect::Fade);
        assert_eq!(read_back.enter.duration, 0.4);
    }

    #[test]
    fn write_replaces_existing_transition_in_place() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"none\" enter-duration=\"0.6\" exit=\"none\" exit-duration=\"0.5\"/></metadata></svg>\n";
        let updated = set_slide_transition(
            svg,
            SlideTransition {
                enter: SlideTransitionEdge {
                    effect: PageTransitionEffect::Zoom,
                    duration: 1.0,
                },
                exit: SlideTransitionEdge {
                    effect: PageTransitionEffect::Slide,
                    duration: 0.2,
                },
            },
        )
        .unwrap();
        assert!(
            updated.contains(
                "enter=\"zoom\" enter-duration=\"1\" exit=\"slide\" exit-duration=\"0.2\""
            )
        );
        assert_eq!(updated.matches("<slidra:transition").count(), 1);
    }

    #[test]
    fn duplicate_transition_metadata_errors() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"none\" enter-duration=\"0.6\" exit=\"none\" exit-duration=\"0.5\"/><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"none\" enter-duration=\"0.6\" exit=\"none\" exit-duration=\"0.5\"/></metadata></svg>\n";
        let err = read_slide_transition(svg).unwrap_err();
        assert!(err.message().contains("2 set(s)"));
    }

    #[test]
    fn illegal_enter_value_errors() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"bogus\" exit=\"none\"/></metadata></svg>\n";
        let err = read_slide_transition(svg).unwrap_err();
        assert!(err.message().contains("is not implemented yet"));
    }

    #[test]
    fn slide_has_transition_metadata_detects_presence() {
        assert!(!slide_has_transition_metadata(BLANK_SVG).unwrap());
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1280 720\"><metadata><slidra:transition xmlns:slidra=\"https://slidra.app/ns/2026\" enter=\"fade\" exit=\"none\"/></metadata></svg>\n";
        assert!(slide_has_transition_metadata(svg).unwrap());
    }
}

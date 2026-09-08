//! Per-page enter/exit transitions. Ported from
//! `packages/core/src/slide/transition.ts` — read side only (plan 2.1 item
//! 6: `setSlideTransition`'s write side belongs to F3's `slide transition
//! set`). `read_slide_transition` is this ticket's own read dependency
//! (`effect list`'s `data.transition`, plan 4.1) — it does not touch
//! `<comot:effects>` at all, only the sibling `<comot:transition>` node
//! under the same `<metadata>`.

use crate::errors::{CoMotionError, CoMotionResult};
use crate::slide::scan::{ScannedNode, attribute_value, scan_document};

const TRANSITION_TAG: &str = "comot:transition";
const METADATA_TAG: &str = "metadata";

#[derive(Debug, Clone, PartialEq)]
pub struct SlideTransitionEdge {
    pub effect: String,
    pub duration: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlideTransition {
    pub enter: SlideTransitionEdge,
    pub exit: SlideTransitionEdge,
}

/// §4.2: "this page never had one set" — the same meaning as an absent
/// `<comot:transition>`.
pub fn default_transition() -> SlideTransition {
    SlideTransition {
        enter: SlideTransitionEdge {
            effect: "none".to_string(),
            duration: 0.6,
        },
        exit: SlideTransitionEdge {
            effect: "none".to_string(),
            duration: 0.5,
        },
    }
}

fn require_svg_root(roots: &[ScannedNode]) -> CoMotionResult<&ScannedNode> {
    roots
        .iter()
        .find(|node| node.tag == "svg")
        .ok_or_else(|| CoMotionError::invalid("投影片的根節點不是 <svg>"))
}

fn locate_transition(svg_root: &ScannedNode) -> CoMotionResult<Option<&ScannedNode>> {
    let Some(metadata) = svg_root
        .children
        .iter()
        .find(|child| child.tag == METADATA_TAG)
    else {
        return Ok(None);
    };
    let nodes: Vec<&ScannedNode> = metadata
        .children
        .iter()
        .filter(|child| child.tag == TRANSITION_TAG)
        .collect();
    if nodes.len() > 1 {
        return Err(CoMotionError::invalid(format!(
            "這張投影片的 metadata 裡有 {} 組頁面進出場設定，但一張投影片只能有一份，簡報已損毀。",
            nodes.len()
        )));
    }
    Ok(nodes.first().copied())
}

const PAGE_TRANSITION_EFFECTS: &[&str] = &["none", "fade", "slide", "zoom"];

fn parse_effect_attr(raw: Option<&str>, label: &str) -> CoMotionResult<String> {
    match raw {
        None => Ok("none".to_string()),
        Some(value) if !value.is_empty() && PAGE_TRANSITION_EFFECTS.contains(&value) => {
            Ok(value.to_string())
        }
        Some(value) => Err(CoMotionError::invalid(format!(
            "頁面進出場的 {label} 值「{value}」尚未實作。"
        ))),
    }
}

fn parse_duration_attr(raw: Option<&str>, label: &str, fallback: f64) -> CoMotionResult<f64> {
    let Some(raw) = raw else { return Ok(fallback) };
    let trimmed = raw.trim();
    let value = if trimmed.is_empty() {
        f64::NAN
    } else {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    };
    if !value.is_finite() || value < 0.0 {
        return Err(CoMotionError::invalid(format!(
            "頁面進出場的 {label} 值「{raw}」不是合法的秒數。"
        )));
    }
    Ok(value)
}

/// Reads a slide's page enter/exit transition (`effect list`'s
/// `data.transition`, plan 4.1). Absent/missing pieces default; a
/// present-but-illegal value throws.
pub fn read_slide_transition(svg_content: &str) -> CoMotionResult<SlideTransition> {
    let roots = scan_document(svg_content)?;
    let svg_root = require_svg_root(&roots)?;
    let Some(transition) = locate_transition(svg_root)? else {
        return Ok(default_transition());
    };

    let default = default_transition();
    Ok(SlideTransition {
        enter: SlideTransitionEdge {
            effect: parse_effect_attr(attribute_value(transition, "enter").as_deref(), "enter")?,
            duration: parse_duration_attr(
                attribute_value(transition, "enter-duration").as_deref(),
                "enter-duration",
                default.enter.duration,
            )?,
        },
        exit: SlideTransitionEdge {
            effect: parse_effect_attr(attribute_value(transition, "exit").as_deref(), "exit")?,
            duration: parse_duration_attr(
                attribute_value(transition, "exit-duration").as_deref(),
                "exit-duration",
                default.exit.duration,
            )?,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_metadata_returns_default_transition() {
        let svg = r#"<svg viewBox="0 0 100 100"></svg>"#;
        assert_eq!(read_slide_transition(svg).unwrap(), default_transition());
    }

    #[test]
    fn reads_explicit_transition_attributes() {
        let svg = r#"<svg viewBox="0 0 100 100"><metadata><comot:transition xmlns:comot="https://co-motion.dev/ns" enter="fade" enter-duration="1.2" exit="zoom" exit-duration="0.8"/></metadata></svg>"#;
        let transition = read_slide_transition(svg).unwrap();
        assert_eq!(transition.enter.effect, "fade");
        assert_eq!(transition.enter.duration, 1.2);
        assert_eq!(transition.exit.effect, "zoom");
        assert_eq!(transition.exit.duration, 0.8);
    }

    #[test]
    fn unsupported_effect_value_is_rejected() {
        let svg = r#"<svg viewBox="0 0 100 100"><metadata><comot:transition xmlns:comot="https://co-motion.dev/ns" enter="wipe"/></metadata></svg>"#;
        let err = read_slide_transition(svg).unwrap_err();
        assert_eq!(err.message(), "頁面進出場的 enter 值「wipe」尚未實作。");
    }

    #[test]
    fn two_transition_nodes_is_damaged_presentation() {
        let svg = r#"<svg viewBox="0 0 100 100"><metadata><comot:transition xmlns:comot="https://co-motion.dev/ns"/><comot:transition xmlns:comot="https://co-motion.dev/ns"/></metadata></svg>"#;
        let err = read_slide_transition(svg).unwrap_err();
        assert!(err.message().contains("有 2 組頁面進出場設定"));
    }
}

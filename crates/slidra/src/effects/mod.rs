//! Single source of truth for "what is a legal effect item": the value
//! sets, per-attribute validation, and step derivation. `effects::edit` is
//! the reader/writer half, built on these types.

pub mod edit;

use crate::errors::{SlidraError, SlidraResult};

/// The fixed value set: not extended or trimmed without an ADR amendment.
/// `None` for an unknown family (mirrors the TS `SUPPORTED_EFFECTS[family]`
/// lookup returning `undefined`).
pub fn allowed_effects(family: &str) -> Option<&'static [&'static str]> {
    match family {
        "enter" => Some(&["appear", "fade", "fly-up", "fly-left", "zoom"]),
        "emphasis" => Some(&["pulse", "spin", "grow"]),
        "exit" => Some(&["disappear", "fade-out", "zoom-out"]),
        "path" => Some(&["path"]),
        "media" => Some(&["play", "pause"]),
        _ => None,
    }
}

pub const SUPPORTED_STARTS: &[&str] = &["on-click", "with-previous", "after-previous"];

const DEFAULT_DURATION_MEDIA: f64 = 0.0;
const DEFAULT_DURATION: f64 = 0.6;

/// Human-readable position, 1-based, for error messages.
pub fn at(index: usize) -> String {
    format!("第 {} 項", index + 1)
}

/// The four required attributes of a `<slidra:effect>`, read as raw strings
/// (or `None` when absent) by whichever scanner the caller uses.
#[derive(Debug, Clone, Default)]
pub struct RawEffectAttributes {
    pub target: Option<String>,
    pub family: Option<String>,
    pub effect: Option<String>,
    pub start: Option<String>,
    pub duration: Option<String>,
    pub delay: Option<String>,
    pub d: Option<String>,
}

/// This item's 0-based position in the slide's effect list — the runtime's
/// addressing scheme for Preview, since `derive_steps` groups items into
/// steps and would otherwise lose it.
#[derive(Debug, Clone, PartialEq)]
pub struct Effect {
    pub target: String,
    pub family: String,
    pub effect: String,
    pub start: String,
    pub duration: f64,
    pub delay: f64,
    /// Only meaningful for family "path", but preserved verbatim
    /// (unvalidated, unused) when present on any other family.
    pub d: Option<String>,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub effects: Vec<Effect>,
}

/// `""` is falsy in JS, same as `null`/`undefined` — mirrors every `!value`
/// check in the TS original against a `string | null` field.
fn is_blank(value: &Option<String>) -> bool {
    value.is_none() || matches!(value, Some(s) if s.is_empty())
}

/// Validates one effect item's raw attributes against the fixed value sets
/// and per-attribute rules, filling in `duration`/`delay` defaults, and
/// returns the typed `Effect`. Returns `Err` the moment anything is illegal
/// — never a patched-up value in place of a bad one.
///
/// `target_exists` is supplied by the caller (a `scanDocument` walk in the
/// writer) rather than computed here, since "does an id exist in this
/// document" is scanner-specific.
pub fn validate_effect_item(
    raw: &RawEffectAttributes,
    index: usize,
    target_exists: bool,
) -> SlidraResult<Effect> {
    let position = at(index);
    let label = match &raw.target {
        Some(target) if !target.is_empty() => format!("{position}（target 為 {target}）"),
        _ => position,
    };

    for (name, value) in [
        ("target", &raw.target),
        ("family", &raw.family),
        ("effect", &raw.effect),
        ("start", &raw.start),
    ] {
        if is_blank(value) {
            return Err(SlidraError::invalid(format!(
                "{label} 缺少必要屬性 {name}。"
            )));
        }
    }

    let target = raw.target.clone().expect("checked above");
    let family = raw.family.clone().expect("checked above");
    let effect = raw.effect.clone().expect("checked above");
    let start = raw.start.clone().expect("checked above");

    let Some(allowed) = allowed_effects(&family) else {
        return Err(SlidraError::invalid(format!(
            "{label} 的 family 值「{family}」尚未實作。"
        )));
    };
    if !allowed.contains(&effect.as_str()) {
        return Err(SlidraError::invalid(format!(
            "{label} 的 effect 值「{effect}」尚未實作。"
        )));
    }
    if !SUPPORTED_STARTS.contains(&start.as_str()) {
        return Err(SlidraError::invalid(format!(
            "{label} 的 start 值「{start}」尚未實作。"
        )));
    }

    if !target_exists {
        return Err(SlidraError::invalid(format!(
            "{label} 指向的元素不存在於這張投影片，簡報已損毀。"
        )));
    }

    if family == "path" && is_blank(&raw.d) {
        return Err(SlidraError::invalid(format!(
            "{label} 的 family 是 path，但沒有 d，簡報已損毀。"
        )));
    }

    let default_duration = if family == "media" {
        DEFAULT_DURATION_MEDIA
    } else {
        DEFAULT_DURATION
    };
    let duration = parse_seconds_attr(
        raw.duration.as_deref(),
        &label,
        "duration",
        default_duration,
    )?;
    let delay = parse_seconds_attr(raw.delay.as_deref(), &label, "delay", 0.0)?;

    Ok(Effect {
        target,
        family,
        effect,
        start,
        duration,
        delay,
        d: raw.d.clone(),
        index,
    })
}

/// Missing (`raw == None`, the attribute is absent) takes the default —
/// present-but-empty (`duration=""`) is a different case and is rejected,
/// same as any other non-numeric string.
///
/// KNOWN GAP (same stance as `slide/format.rs`'s `js_parse_finite`): JS's
/// `Number()` string coercion additionally accepts hexadecimal/octal/binary
/// integer literals ("0x10" -> 16), which `f64::parse` rejects. Every real
/// value this codebase ever writes here is a plain decimal from
/// `format_svg_number`, so this is believed unreachable on real documents.
fn parse_seconds_attr(
    raw: Option<&str>,
    label: &str,
    attr_name: &str,
    fallback: f64,
) -> SlidraResult<f64> {
    let Some(raw) = raw else { return Ok(fallback) };
    let trimmed = raw.trim();
    let value = if trimmed.is_empty() {
        f64::NAN
    } else {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    };
    if !value.is_finite() || value < 0.0 {
        return Err(SlidraError::invalid(format!(
            "{label} 的 {attr_name} 值「{raw}」不是合法的秒數。"
        )));
    }
    Ok(value)
}

/// Same legality rule as `parse_seconds_attr`, for a value that already
/// arrived as a number (the writer's CLI inputs) rather than a raw XML
/// string.
pub fn assert_legal_seconds(value: f64, label: &str, attr_name: &str) -> SlidraResult<()> {
    if !value.is_finite() || value < 0.0 {
        return Err(SlidraError::invalid(format!(
            "{label} 的 {attr_name} 值「{}」不是合法的秒數。",
            format_number_for_message(value)
        )));
    }
    Ok(())
}

/// Mirrors a JS number's default `toString()` closely enough for this
/// module's error messages: an integral value prints with no decimal
/// point, matching `serde_json`/Rust's own `f64` `Display` for the finite,
/// non-huge values that ever reach this function from CLI argv parsing
/// (which already rejects non-finite input earlier).
fn format_number_for_message(value: f64) -> String {
    format!("{value}")
}

pub fn default_duration_for(family: &str) -> f64 {
    if family == "media" {
        DEFAULT_DURATION_MEDIA
    } else {
        DEFAULT_DURATION
    }
}

/// Groups an effect list into steps: an "on-click" effect opens a new step;
/// "with-previous" and "after-previous" join the current one.
pub fn derive_steps(effects: &[Effect]) -> SlidraResult<Vec<Step>> {
    let mut steps: Vec<Step> = Vec::new();
    for (index, effect) in effects.iter().enumerate() {
        if effect.start == "on-click" {
            steps.push(Step {
                effects: vec![effect.clone()],
            });
            continue;
        }
        if steps.is_empty() {
            return Err(SlidraError::invalid(format!(
                "{} 的 start 是「{}」，但前面沒有可以併入的步驟，效果清單已損毀。",
                at(index),
                effect.start
            )));
        }
        steps
            .last_mut()
            .expect("checked non-empty above")
            .effects
            .push(effect.clone());
    }
    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(target: &str, family: &str, effect: &str, start: &str) -> RawEffectAttributes {
        RawEffectAttributes {
            target: Some(target.to_string()),
            family: Some(family.to_string()),
            effect: Some(effect.to_string()),
            start: Some(start.to_string()),
            duration: None,
            delay: None,
            d: None,
        }
    }

    #[test]
    fn every_family_accepts_its_own_legal_effect_values() {
        for (family, effects) in [
            (
                "enter",
                &["appear", "fade", "fly-up", "fly-left", "zoom"][..],
            ),
            ("emphasis", &["pulse", "spin", "grow"][..]),
            ("exit", &["disappear", "fade-out", "zoom-out"][..]),
            ("media", &["play", "pause"][..]),
        ] {
            for effect in effects {
                let mut r = raw("el1", family, effect, "on-click");
                if family == "path" {
                    r.d = Some("M0 0".to_string());
                }
                let result = validate_effect_item(&r, 0, true);
                assert!(
                    result.is_ok(),
                    "{family}/{effect} should be legal: {result:?}"
                );
            }
        }
        let mut r = raw("el1", "path", "path", "on-click");
        r.d = Some("M0 0".to_string());
        assert!(validate_effect_item(&r, 0, true).is_ok());
    }

    #[test]
    fn all_three_starts_are_legal() {
        for start in SUPPORTED_STARTS {
            let r = raw("el1", "enter", "fade", start);
            assert!(validate_effect_item(&r, 0, true).is_ok());
        }
    }

    #[test]
    fn missing_required_attribute_reports_which_one() {
        let mut r = raw("el1", "enter", "fade", "on-click");
        r.effect = None;
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 缺少必要屬性 effect。"
        );
    }

    #[test]
    fn empty_string_attribute_counts_as_missing() {
        let mut r = raw("el1", "enter", "fade", "on-click");
        r.effect = Some(String::new());
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 缺少必要屬性 effect。"
        );
    }

    #[test]
    fn unknown_family_value_is_rejected() {
        let r = raw("el1", "bogus", "fade", "on-click");
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 的 family 值「bogus」尚未實作。"
        );
    }

    #[test]
    fn effect_not_in_family_is_rejected() {
        let r = raw("el1", "enter", "wipe", "on-click");
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 的 effect 值「wipe」尚未實作。"
        );
    }

    #[test]
    fn unknown_start_value_is_rejected() {
        let r = raw("el1", "enter", "fade", "on-hover");
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 的 start 值「on-hover」尚未實作。"
        );
    }

    #[test]
    fn missing_target_element_is_rejected() {
        let r = raw("el1", "enter", "fade", "on-click");
        let err = validate_effect_item(&r, 0, false).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 指向的元素不存在於這張投影片，簡報已損毀。"
        );
    }

    #[test]
    fn path_family_missing_d_is_rejected() {
        let r = raw("el1", "path", "path", "on-click");
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 的 family 是 path，但沒有 d，簡報已損毀。"
        );
    }

    #[test]
    fn d_on_non_path_family_is_preserved_unvalidated() {
        let mut r = raw("el1", "enter", "fade", "on-click");
        r.d = Some("M0 0".to_string());
        let effect = validate_effect_item(&r, 0, true).unwrap();
        assert_eq!(effect.d.as_deref(), Some("M0 0"));
    }

    #[test]
    fn duration_defaults_media_zero_others_point_six() {
        let media =
            validate_effect_item(&raw("el1", "media", "play", "on-click"), 0, true).unwrap();
        assert_eq!(media.duration, 0.0);
        let enter =
            validate_effect_item(&raw("el1", "enter", "fade", "on-click"), 0, true).unwrap();
        assert_eq!(enter.duration, 0.6);
    }

    #[test]
    fn delay_defaults_to_zero() {
        let effect =
            validate_effect_item(&raw("el1", "enter", "fade", "on-click"), 0, true).unwrap();
        assert_eq!(effect.delay, 0.0);
    }

    #[test]
    fn duration_present_but_empty_string_is_rejected() {
        let mut r = raw("el1", "enter", "fade", "on-click");
        r.duration = Some(String::new());
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 的 duration 值「」不是合法的秒數。"
        );
    }

    #[test]
    fn negative_duration_is_rejected() {
        let mut r = raw("el1", "enter", "fade", "on-click");
        r.duration = Some("-1".to_string());
        let err = validate_effect_item(&r, 0, true).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項（target 為 el1） 的 duration 值「-1」不是合法的秒數。"
        );
    }

    #[test]
    fn duration_zero_is_legal() {
        let mut r = raw("el1", "enter", "fade", "on-click");
        r.duration = Some("0".to_string());
        let effect = validate_effect_item(&r, 0, true).unwrap();
        assert_eq!(effect.duration, 0.0);
    }

    #[test]
    fn derive_steps_empty_list_is_empty() {
        assert_eq!(derive_steps(&[]).unwrap(), Vec::new());
    }

    #[test]
    fn derive_steps_every_on_click_opens_a_new_step() {
        let effects = vec![
            Effect {
                target: "a".into(),
                family: "enter".into(),
                effect: "fade".into(),
                start: "on-click".into(),
                duration: 0.6,
                delay: 0.0,
                d: None,
                index: 0,
            },
            Effect {
                target: "b".into(),
                family: "enter".into(),
                effect: "fade".into(),
                start: "on-click".into(),
                duration: 0.6,
                delay: 0.0,
                d: None,
                index: 1,
            },
        ];
        let steps = derive_steps(&effects).unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].effects.len(), 1);
        assert_eq!(steps[1].effects.len(), 1);
    }

    #[test]
    fn derive_steps_with_previous_joins_current_step() {
        let effects = vec![
            Effect {
                target: "a".into(),
                family: "enter".into(),
                effect: "fade".into(),
                start: "on-click".into(),
                duration: 0.6,
                delay: 0.0,
                d: None,
                index: 0,
            },
            Effect {
                target: "b".into(),
                family: "enter".into(),
                effect: "fade".into(),
                start: "with-previous".into(),
                duration: 0.6,
                delay: 0.0,
                d: None,
                index: 1,
            },
        ];
        let steps = derive_steps(&effects).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].effects.len(), 2);
    }

    #[test]
    fn derive_steps_first_item_not_on_click_is_damaged() {
        let effects = vec![Effect {
            target: "a".into(),
            family: "enter".into(),
            effect: "fade".into(),
            start: "with-previous".into(),
            duration: 0.6,
            delay: 0.0,
            d: None,
            index: 0,
        }];
        let err = derive_steps(&effects).unwrap_err();
        assert_eq!(
            err.message(),
            "第 1 項 的 start 是「with-previous」，但前面沒有可以併入的步驟，效果清單已損毀。"
        );
    }
}

//! `ListKind`, `LIST_INDENT_EM`, and list-indent calculation, ported from
//! `packages/core/src/text/list.ts` (41 lines, ported in full).

use crate::errors::{SlidraError, SlidraResult};

/// `data-slidra-list` token kind, one per paragraph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
    Bullet,
    Number,
    None,
}

impl ListKind {
    pub(crate) fn as_token(self) -> &'static str {
        match self {
            ListKind::Bullet => "bullet",
            ListKind::Number => "number",
            ListKind::None => "none",
        }
    }

    fn from_token(token: &str) -> Option<Self> {
        match token {
            "bullet" => Some(ListKind::Bullet),
            "number" => Some(ListKind::Number),
            "none" => Some(ListKind::None),
            _ => None,
        }
    }
}

/// Left indent, in em (× font-size), for a list paragraph — a judgement
/// value (no ADR/ticket names one in the TS source either); tune by
/// changing this one constant.
pub const LIST_INDENT_EM: f64 = 1.5;

/// Parses a text box's `data-slidra-list` attribute value (`raw`, `None` when
/// the attribute is absent) into exactly `paragraph_count` tokens, one per
/// paragraph. A paragraph with no token — because the attribute is absent,
/// empty, or has fewer tokens than paragraphs — defaults to `ListKind::None`
/// (a legacy box with no attribute at all reads as "no list anywhere",
/// byte-for-byte the pre-list behaviour).
pub fn parse_list_tokens(
    raw: Option<&str>,
    paragraph_count: usize,
    element_id: &str,
) -> SlidraResult<Vec<ListKind>> {
    let tokens: Vec<&str> = match raw {
        None => Vec::new(),
        Some(s) if s.trim().is_empty() => Vec::new(),
        Some(s) => s.split_whitespace().collect(),
    };
    for token in &tokens {
        if ListKind::from_token(token).is_none() {
            return Err(SlidraError::invalid(format!(
                "元素 {element_id} 的 data-slidra-list 含不合法的值：{token}"
            )));
        }
    }
    Ok((0..paragraph_count)
        .map(|i| {
            tokens
                .get(i)
                .and_then(|t| ListKind::from_token(t))
                .unwrap_or(ListKind::None)
        })
        .collect())
}

/// `wrap_text`'s `indents` option, one entry per paragraph — non-`None`
/// paragraphs get `LIST_INDENT_EM * font_size`, everything else 0.
pub fn list_indents(tokens: &[ListKind], font_size_px: f64) -> Vec<f64> {
    tokens
        .iter()
        .map(|&kind| {
            if kind == ListKind::None {
                0.0
            } else {
                LIST_INDENT_EM * font_size_px
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_attribute_defaults_every_paragraph_to_none() {
        let tokens = parse_list_tokens(None, 3, "el1").unwrap();
        assert_eq!(tokens, vec![ListKind::None, ListKind::None, ListKind::None]);
    }

    #[test]
    fn empty_or_whitespace_only_attribute_defaults_to_none() {
        let tokens = parse_list_tokens(Some("   "), 2, "el1").unwrap();
        assert_eq!(tokens, vec![ListKind::None, ListKind::None]);
    }

    #[test]
    fn fewer_tokens_than_paragraphs_pads_remainder_with_none() {
        let tokens = parse_list_tokens(Some("bullet"), 3, "el1").unwrap();
        assert_eq!(
            tokens,
            vec![ListKind::Bullet, ListKind::None, ListKind::None]
        );
    }

    #[test]
    fn parses_one_token_per_paragraph_separated_by_whitespace() {
        let tokens = parse_list_tokens(Some("bullet number none"), 3, "el1").unwrap();
        assert_eq!(
            tokens,
            vec![ListKind::Bullet, ListKind::Number, ListKind::None]
        );
    }

    #[test]
    fn extra_tokens_beyond_paragraph_count_are_ignored() {
        let tokens = parse_list_tokens(Some("bullet number none bullet"), 2, "el1").unwrap();
        assert_eq!(tokens, vec![ListKind::Bullet, ListKind::Number]);
    }

    #[test]
    fn invalid_token_errors_with_element_id_and_the_bad_value() {
        let err = parse_list_tokens(Some("bullet garbage"), 2, "el42").unwrap_err();
        assert_eq!(
            err.message(),
            "元素 el42 的 data-slidra-list 含不合法的值：garbage"
        );
    }

    #[test]
    fn list_indents_gives_zero_for_none_and_em_scaled_for_others() {
        let tokens = vec![ListKind::Bullet, ListKind::None, ListKind::Number];
        let indents = list_indents(&tokens, 20.0);
        assert_eq!(indents, vec![30.0, 0.0, 30.0]); // 1.5em * 20px = 30px
    }

    #[test]
    fn as_token_round_trips_through_from_token() {
        for kind in [ListKind::Bullet, ListKind::Number, ListKind::None] {
            assert_eq!(ListKind::from_token(kind.as_token()), Some(kind));
        }
    }
}

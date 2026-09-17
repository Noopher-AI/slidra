// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Path redaction for agent responses (#397 AC: "No response to an agent
//! credential contains a real filesystem path"). Only `server::
//! handle_call` calls this, and only for `CallerKind::Agent` — an editor
//! or viewer credential's response is never touched here (#397's scope:
//! path stripping is specifically the agent's own concern, since only
//! the agent's box is denied a real path by construction elsewhere in
//! the spec — spec #395 decision 17, the workbench access interface
//! never returns one either).
//!
//! A literal byte-substring replace of `SLIDRA_HOME`'s own absolute path
//! — every real path this crate's commands can put in a response is
//! necessarily rooted there (`workspace::resolve_work_dir`/
//! `resolve_home`'s own contract) — rather than a general "looks like an
//! absolute path" heuristic: a byte-substring match can never misfire on
//! content that merely resembles a path (a slide's own text content, an
//! asset's binary bytes) unless it contains this exact, unusual prefix,
//! which is indistinguishable from an actual leak if it ever did.

const PLACEHOLDER: &[u8] = b"<redacted-path>";

/// Replaces every occurrence of `SLIDRA_HOME`'s absolute path with
/// `PLACEHOLDER`, in place. A no-op when the prefix never occurs at all
/// (the overwhelmingly common case — most responses name nothing real on
/// disk), which is what keeps this safe to run over `slide render`/`cat`'s
/// raw (including binary) output too: AC4's byte-exact contract is
/// violated only if the home prefix's bytes happen to occur inside a
/// payload that was never supposed to be touched, and at that point
/// replacing them is the correct call under AC9, not a bug.
pub fn redact_real_paths(bytes: &mut Vec<u8>) {
    let home = crate::workspace::resolve_home();
    let home_str = home.to_string_lossy().into_owned();
    let needle = home_str.as_bytes();
    replace_all(bytes, needle, PLACEHOLDER);
}

fn replace_all(haystack: &mut Vec<u8>, needle: &[u8], replacement: &[u8]) {
    if needle.is_empty() || haystack.len() < needle.len() {
        return;
    }
    if !contains(haystack, needle) {
        return; // common case: nothing to do, no allocation.
    }
    let mut result = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(needle) {
            result.extend_from_slice(replacement);
            i += needle.len();
        } else {
            result.push(haystack[i]);
            i += 1;
        }
    }
    *haystack = result;
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulates a handler that forgot to strip a real path — the same
    /// shape a genuine oversight in this crate would take. Removing the
    /// call to `redact_real_paths` (or making it a no-op) turns this test
    /// red, which is the point: it is the guard AC9 asks for.
    #[test]
    fn redacts_the_home_directory_prefix_from_a_fabricated_response() {
        let home = crate::workspace::resolve_home();
        let mut bytes = format!("wrote {}/deck.slidra to disk", home.display()).into_bytes();
        redact_real_paths(&mut bytes);
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            !text.contains(&home.display().to_string()),
            "real path leaked: {text}"
        );
        assert!(text.contains("<redacted-path>/deck.slidra to disk"));
    }

    #[test]
    fn leaves_output_with_no_real_path_byte_exact() {
        let mut bytes = b"no real paths in here at all".to_vec();
        let original = bytes.clone();
        redact_real_paths(&mut bytes);
        assert_eq!(bytes, original);
    }

    #[test]
    fn redacts_every_occurrence_not_just_the_first() {
        let home = crate::workspace::resolve_home();
        let home_str = home.display().to_string();
        let mut bytes = format!("{home_str}/a.slidra and also {home_str}/b.slidra").into_bytes();
        redact_real_paths(&mut bytes);
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.matches("<redacted-path>").count(), 2);
        assert!(!text.contains(&home_str));
    }

    #[test]
    fn is_byte_exact_on_arbitrary_binary_payloads_with_no_path_inside() {
        let mut bytes: Vec<u8> = (0u8..=255).collect();
        let original = bytes.clone();
        redact_real_paths(&mut bytes);
        assert_eq!(
            bytes, original,
            "binary payload with no real path must survive untouched (AC4)"
        );
    }
}

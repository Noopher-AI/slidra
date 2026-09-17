// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The credential the door reads (#397 "The credential model" / spec
//! #395 decision 9: "The credential names the caller"). Issuing a real,
//! launcher-signed credential is [S11.F6], explicitly out of scope here
//! (#397's own "Out of scope" list) — this module decodes a credential
//! shaped the way this ticket's own tests construct it (a base64 JSON
//! object naming a kind and a workbench id), not a signed one. Nothing
//! downstream can tell the difference: `handle_call` never sees the raw
//! header, only the `Credential` this module hands back.
//!
//! Only a header is ever consulted (spec #395 decision 10: the browser
//! holds the editor's credential in memory and sends it in a header,
//! never a cookie or a URL) — there is no cookie or query-string path
//! into this module at all, so "credential only via header" is
//! structural here, not a rule this code has to remember to enforce.

use std::str;

pub const CREDENTIAL_HEADER: &str = "x-slidra-credential";

/// A caller naming its OWN kind — in a header, or (were this door ever
/// extended to accept one) any other request field — is never believed
/// (#397: "The caller never states its own kind"; AC3). Its mere presence
/// is refused before the credential itself is even inspected, by
/// `server::handle_call`, which checks for this header directly (kept
/// here, not in `mod.rs`'s own constant list, because rejecting it is
/// as much a credential-model rule as parsing the real credential is).
pub const CALLER_KIND_HEADER: &str = "x-slidra-caller-kind";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerKind {
    Editor,
    Agent,
    Viewer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub kind: CallerKind,
    pub workbench_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    /// No credential header, an empty value, a value that fails to
    /// decode/parse, or an unknown `kind` — all refused identically
    /// (#397/behavior contract: "same text, same status code" for
    /// missing vs. wrong, so a caller can never use the response to tell
    /// which is closer to a real credential).
    Unauthorized,
}

/// Parses the credential out of `headers` (name/value pairs, as read off
/// the wire — case-insensitive lookup, matching HTTP itself). Only
/// `CREDENTIAL_HEADER` is ever consulted; there is no fallback to any
/// other field.
pub fn parse(headers: &[(String, String)]) -> Result<Credential, CredentialError> {
    let raw = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(CREDENTIAL_HEADER))
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or(CredentialError::Unauthorized)?;
    decode(raw).ok_or(CredentialError::Unauthorized)
}

fn decode(raw: &str) -> Option<Credential> {
    let bytes = crate::server::decode_base64(raw)?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let kind = match json.get("kind")?.as_str()? {
        "editor" => CallerKind::Editor,
        "agent" => CallerKind::Agent,
        "viewer" => CallerKind::Viewer,
        _ => return None,
    };
    let workbench_id = json.get("workbenchId")?.as_str()?.to_string();
    if workbench_id.is_empty() {
        return None;
    }
    Some(Credential { kind, workbench_id })
}

/// Encodes a credential the same way a (future, real) launcher would —
/// used by this ticket's own tests and by `shim_client` to build the
/// header it sends; production code never calls this in the other
/// direction (a credential is only ever decoded, never minted, outside
/// of tests — issuance is [S11.F6]).
pub fn encode(kind: CallerKind, workbench_id: &str) -> String {
    let kind_str = match kind {
        CallerKind::Editor => "editor",
        CallerKind::Agent => "agent",
        CallerKind::Viewer => "viewer",
    };
    let json = serde_json::json!({ "kind": kind_str, "workbenchId": workbench_id });
    crate::base64::encode(json.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn missing_header_is_unauthorized() {
        assert_eq!(parse(&headers(&[])), Err(CredentialError::Unauthorized));
    }

    #[test]
    fn empty_header_is_unauthorized() {
        assert_eq!(
            parse(&headers(&[(CREDENTIAL_HEADER, "")])),
            Err(CredentialError::Unauthorized)
        );
    }

    #[test]
    fn garbage_header_is_unauthorized() {
        assert_eq!(
            parse(&headers(&[(CREDENTIAL_HEADER, "not-base64-json")])),
            Err(CredentialError::Unauthorized)
        );
    }

    #[test]
    fn unknown_kind_is_unauthorized() {
        let raw = crate::base64::encode(br#"{"kind":"root","workbenchId":"wb1"}"#);
        assert_eq!(
            parse(&headers(&[(CREDENTIAL_HEADER, &raw)])),
            Err(CredentialError::Unauthorized)
        );
    }

    #[test]
    fn round_trips_through_encode() {
        let raw = encode(CallerKind::Agent, "wb1");
        let credential = parse(&headers(&[(CREDENTIAL_HEADER, &raw)])).unwrap();
        assert_eq!(credential.kind, CallerKind::Agent);
        assert_eq!(credential.workbench_id, "wb1");
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let raw = encode(CallerKind::Viewer, "wb2");
        let credential = parse(&headers(&[("X-Slidra-Credential", &raw)])).unwrap();
        assert_eq!(credential.kind, CallerKind::Viewer);
    }
}

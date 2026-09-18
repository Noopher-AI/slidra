// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! `GET /identity`, `POST /identity/sign-in`, `POST /identity/sign-out` —
//! in-process port of `packages/server/src/identity/session.ts` +
//! `identity/routes.ts` + `identity/anonymous-provider.ts`.
//!
//! Production registers exactly one identity provider, unconditionally:
//! `serve.ts`'s `options.identity?.providers ?? [createAnonymousProvider()]`
//! — `cli.ts` never overrides it, and that provider's `begin()` always
//! answers `unavailable` (no real sign-in exists yet; `identity/
//! anonymous-provider.ts`'s own doc comment). `identity/types.ts`'s full
//! `IdentityProvider` trait/registry shape exists in the TS original so a
//! SECOND provider (Email Magic Link) can be added later by only
//! implementing that interface — but no second provider exists anywhere
//! in this codebase yet (`identity/fake-provider.ts` is explicitly
//! test-only, never registered by `cli.ts`, and reached only through
//! `ServeOptions`'s in-process test wiring, which the deck server's
//! compiled binary has no equivalent entry point for). Porting a
//! provider-trait system for a provider that cannot be registered here is
//! exactly the "unneeded abstraction" this crate avoids elsewhere — this
//! module hard-codes the one production provider's behavior instead,
//! faithfully matching what `identity/session.ts`'s `applyOutcome` reduces
//! to when the only registered provider can never produce a `signed-in`
//! outcome.
//!
//! The in-memory "who is currently signed in" state IS kept as real,
//! mutable state (not simulated away) even though nothing can populate it
//! today: `visible_decks()` below (`GET /decks`'s default filter) and
//! `POST /identity/sign-out` both read/clear it exactly as `session.ts`'s
//! `current` closure variable does, so a future real provider only needs
//! to start writing to it, not a redesign of this module.

use std::net::TcpStream;
use std::sync::Mutex;

use crate::server::credential::CallerKind;
use crate::server::deck_store::{self, is_anonymous_owner};
use crate::server::{self, RawRequest};
use serde_json::Value;

const READ_CALLERS: &[CallerKind] = &[CallerKind::Editor, CallerKind::Viewer];
const EDITOR_ONLY: &[CallerKind] = &[CallerKind::Editor];

const ANONYMOUS_PROVIDER_KIND: &str = "anonymous";
const ANONYMOUS_PROVIDER_LABEL: &str = "Sign in";

struct CurrentIdentity {
    kind: String,
    id: String,
    display_name: String,
    avatar_url: Option<String>,
}

static CURRENT: Mutex<Option<CurrentIdentity>> = Mutex::new(None);

fn owner_tag(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

fn current_identity_json() -> Value {
    let guard = CURRENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*guard {
        None => Value::Null,
        Some(identity) => serde_json::json!({
            "id": identity.id,
            "displayName": identity.display_name,
            "avatarUrl": identity.avatar_url,
        }),
    }
}

fn parse_json_object_or_empty(request: &RawRequest) -> Result<serde_json::Map<String, Value>, ()> {
    if request.body.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::Map::new());
    }
    let parsed: Value = serde_json::from_slice(&request.body).map_err(|_| ())?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err(()),
    }
}

/// `GET /identity` — current identity (`null` when anonymous) plus every
/// registered provider's availability, for the user block's initial
/// render.
pub(crate) fn handle_get(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, READ_CALLERS) else {
        return;
    };
    server::write_json_response(
        stream,
        &serde_json::json!({
            "identity": current_identity_json(),
            "providers": [{ "kind": ANONYMOUS_PROVIDER_KIND, "label": ANONYMOUS_PROVIDER_LABEL, "available": false }],
        }),
    );
}

/// `POST /identity/sign-in` — body `{provider, ...}`. A body carrying a
/// string `challengeId` would continue a two-phase provider's pending
/// step (`session.complete`); the one registered provider is single-phase
/// and never offers sign-in in the first place, so this always answers
/// `unavailable` for a `begin`-shaped call and the provider's own "no
/// pending step" error for a `complete`-shaped one.
pub(crate) fn handle_sign_in(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };
    let Ok(body) = parse_json_object_or_empty(request) else {
        server::write_json_error(stream, 400, "Request body is not valid JSON");
        return;
    };
    let provider = match body.get("provider") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            server::write_json_error(stream, 400, "provider must be a string");
            return;
        }
    };
    if provider != ANONYMOUS_PROVIDER_KIND {
        server::write_json_error(stream, 404, &format!("no identity provider: {provider}"));
        return;
    }
    let is_complete_call = matches!(body.get("challengeId"), Some(Value::String(_)));
    if is_complete_call {
        server::write_json_error(stream, 400, "this provider has no pending step");
        return;
    }
    server::write_json_response(
        stream,
        &serde_json::json!({ "status": "unavailable", "message": "Sign-in isn't available yet." }),
    );
}

/// `POST /identity/sign-out` — always 200, idempotent, never an "unclaim"
/// (a claimed deck stays claimed).
pub(crate) fn handle_sign_out(request: &RawRequest, stream: &mut TcpStream) {
    let Some(_credential) = server::authorize(request, stream, EDITOR_ONLY) else {
        return;
    };
    *CURRENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    server::write_json_response(stream, &serde_json::json!({ "ok": true }));
}

/// The default `GET /decks` visibility filter (no explicit `?owner=`) —
/// mirrors `identity/session.ts`'s `visibleDecks()`: every anonymous-owned
/// deck, plus every deck owned by whichever identity is currently signed
/// in (always none in production today — see this module's own doc
/// comment), sorted by file name.
pub(crate) fn visible_decks() -> Result<Vec<deck_store::DeckListEntry>, deck_store::DeckStoreError>
{
    let tag = CURRENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|identity| owner_tag(&identity.kind, &identity.id));
    let mut entries: Vec<_> = deck_store::list_decks(None)?
        .into_iter()
        .filter(|entry| {
            is_anonymous_owner(entry.owner.as_deref()) || tag.as_deref() == entry.owner.as_deref()
        })
        .collect();
    entries.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_tag_matches_the_ts_format() {
        assert_eq!(owner_tag("anonymous", "abc"), "anonymous:abc");
    }

    #[test]
    fn current_identity_json_is_null_by_default() {
        // Nothing in this codebase can ever populate `CURRENT` (the one
        // registered provider always answers `unavailable`), so this
        // reads the real, shared static rather than a fixture — safe
        // across parallel tests for exactly that reason.
        assert_eq!(current_identity_json(), Value::Null);
    }
}

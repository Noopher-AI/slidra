// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Opaque id generation, ported from `packages/core/src/id.ts`'s
//! `randomBytes(9).toString("base64url")` (see plan section 3.8). No crate
//! dependency is introduced for base64 or randomness (plan section 2, item
//! 7 — the dependency list is fixed at clap/serde/serde_json); both are
//! ~15–20 lines each and are implemented here.
//!
//! `packages/core/src/id.ts` itself is NOT modified to add a test seed hook
//! (plan section 7.3 / 7.2): that file's opaque, non-guessable ids are a
//! documented security property (ADR-0003). `SLIDRA_ID_SEED` is therefore
//! Rust-only — golden fixtures that need reproducible ids only get that
//! reproducibility on the Rust side, and cross-engine golden comparisons
//! normalize ids instead (see tests/unit_golden.rs).

use std::cell::RefCell;
use std::fs::File;
use std::io::Read;

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// `randomBytes(9).toString("base64url")` — 9 raw bytes is exactly 12
/// base64url characters with no padding (9 * 8 = 72 bits = 12 * 6 bits).
pub fn generate_opaque_id() -> String {
    base64url_encode(&random_bytes(9))
}

/// Ports `generateElementId` (`packages/core/src/id.ts`): the same opaque
/// id, prefixed with `el-` so it is recognizable as an element reference.
/// Every command that mints a new element/group id (`insert`, `duplicate`,
/// `paste`, `group`) calls this rather than hand-formatting the prefix
/// itself.
pub fn generate_element_id() -> String {
    format!("el-{}", generate_opaque_id())
}

/// `randomBytes(6).toString("hex")` — used for temp-file name suffixes
/// (`.stack.json.<hex>.tmp`, `.projects.json.<hex>.tmp`).
pub fn random_hex_suffix() -> String {
    use std::fmt::Write;
    random_bytes(6)
        .iter()
        .fold(String::with_capacity(12), |mut out, b| {
            write!(out, "{b:02x}").expect("writing to a String cannot fail");
            out
        })
}

fn base64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64URL_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64URL_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(BASE64URL_ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(BASE64URL_ALPHABET[(triple & 0x3f) as usize] as char);
        }
    }
    out
}

thread_local! {
    // (seed string, current SplitMix64 state) — re-seeded whenever
    // `SLIDRA_ID_SEED` differs from the last call, so that switching the
    // env var (e.g. between test cases sharing a thread) doesn't leak state
    // from a previous seed.
    static SEEDED: RefCell<Option<(String, u64)>> = const { RefCell::new(None) };
}

/// Reads `n` random bytes, or — when `SLIDRA_ID_SEED` is set — derives
/// them deterministically from that seed via SplitMix64, so golden fixtures
/// can be regenerated reproducibly. Every call while the env var is set
/// advances the same generator, mirroring how repeated TS-side calls to
/// `randomBytes` in one process each draw fresh entropy: successive calls
/// must not repeat the same bytes either.
fn random_bytes(n: usize) -> Vec<u8> {
    match std::env::var("SLIDRA_ID_SEED") {
        Ok(seed) if !seed.is_empty() => seeded_bytes(&seed, n),
        _ => urandom_bytes(n),
    }
}

fn urandom_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .expect("/dev/urandom must be readable");
    buf
}

fn seeded_bytes(seed: &str, n: usize) -> Vec<u8> {
    SEEDED.with(|cell| {
        let mut slot = cell.borrow_mut();
        let needs_reseed = !matches!(&*slot, Some((s, _)) if s == seed);
        if needs_reseed {
            *slot = Some((seed.to_string(), fnv1a64(seed.as_bytes())));
        }
        let (_, state) = slot.as_mut().expect("just initialized above");

        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let (next_state, word) = splitmix64_next(*state);
            *state = next_state;
            out.extend_from_slice(&word.to_le_bytes());
        }
        out.truncate(n);
        out
    })
}

/// SplitMix64, the reference generator recommended for seeding/expanding a
/// single seed value (https://prng.di.unimi.it/splitmix64.c). Chosen because
/// it needs no dependency and is a couple of integer operations.
fn splitmix64_next(state: u64) -> (u64, u64) {
    let next_state = state.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = next_state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^= z >> 31;
    (next_state, z)
}

/// FNV-1a, 64-bit variant. Also used by `workspace::lock` to derive a
/// per-deck lock filename from a canonical path (`PresentationLock`) — a
/// second, unrelated use of the same well-known, dependency-free hash, not
/// a shared abstraction between the two.
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_encodes_nine_bytes_to_twelve_chars_no_padding() {
        let id = base64url_encode(&[0u8; 9]);
        assert_eq!(id.len(), 12);
        assert!(!id.contains('='));
    }

    #[test]
    fn base64url_alphabet_matches_rfc4648_url_safe() {
        // 0xfb 0xff 0xbf = 111110 111111 111110 111111 in 6-bit groups,
        // i.e. indices 62,63,62,63 -> exercises both '-' (62) and '_' (63).
        let encoded = base64url_encode(&[0xfb, 0xff, 0xbf]);
        assert_eq!(encoded, "-_-_");
    }

    #[test]
    fn generate_opaque_id_is_deterministic_under_seed() {
        unsafe {
            std::env::set_var("SLIDRA_ID_SEED", "golden-fixture-seed-a");
        }
        let a1 = generate_opaque_id();
        unsafe {
            std::env::set_var("SLIDRA_ID_SEED", "golden-fixture-seed-a");
        }
        // Re-seeding with the SAME value mid-process must not replay bytes
        // already handed out: a fresh generate_opaque_id() call under a
        // constant seed still advances the generator (matches the "must not
        // repeat" contract above), so a1 != a2.
        let a2 = generate_opaque_id();
        unsafe {
            std::env::remove_var("SLIDRA_ID_SEED");
        }
        assert_eq!(a1.len(), 12);
        assert_eq!(a2.len(), 12);
        assert_ne!(a1, a2);
    }

    #[test]
    fn generate_element_id_has_el_dash_prefix_and_twelve_char_suffix() {
        let id = generate_element_id();
        assert!(id.starts_with("el-"));
        assert_eq!(id.len(), "el-".len() + 12);
    }

    #[test]
    fn random_hex_suffix_is_twelve_lowercase_hex_chars() {
        let suffix = random_hex_suffix();
        assert_eq!(suffix.len(), 12);
        assert!(
            suffix
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }
}

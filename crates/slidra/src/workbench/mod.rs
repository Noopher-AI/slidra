// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! The workbench access interface (spec #395/#396): the unit everything
//! else is addressed by. A workbench is exactly one deck plus the policy
//! it runs under — created when a deck is opened, deleted when the session
//! ends. This module defines the seam (`WorkbenchStore`) a hosted edition
//! will one day implement against a store that is not a local filesystem,
//! and the local implementation (`local::LocalWorkbench`) this CLI uses
//! today.
//!
//! The interface never exposes a real filesystem path in any form (see
//! `WorkbenchStore`'s own doc comment) — the one narrow exception,
//! `local::LocalWorkbench::scratch_dir_for_local_spawn`, is deliberately
//! NOT part of this trait (plan §7.8): it exists only for the local
//! launcher to hand an agent process a directory to work in with ordinary
//! file APIs, and nothing holding a `&dyn WorkbenchStore` can reach it.
//!
//! Public API:
//! - `WorkbenchId`/`UploadId` — opaque identifiers, never derived from or
//!   revealing a real path.
//! - `WorkbenchStore` — the deck, uploads and scratch-area lifecycle, all a
//!   caller may reach through this module.
//! - `local::LocalWorkbench` — the local, temp-directory-backed
//!   implementation; `local::sweep_orphans` — abandoned-workbench cleanup.
//! - `deck_list::read_deck_list`/`deck_list::record_opened_deck` — the
//!   list of decks a person has opened (paths only, nothing else).
//!
//! This module does not read or write any of the state the previous local
//! layout kept under `SLIDRA_HOME` beyond what is listed above — no
//! per-presentation registry, no per-deck coordination file, no clipboard
//! file. Removing that previous layout from the rest of the crate is a
//! separate change; this module simply never depends on it in the first
//! place (`mod.rs`'s own guard test in `#[cfg(test)]` below enforces this
//! mechanically).

pub mod deck_list;
pub mod local;

#[cfg(test)]
pub(crate) mod conformance;
#[cfg(test)]
pub(crate) mod memory;

use crate::errors::{SlidraError, SlidraResult};

/// Opaque identifier for a workbench, minted fresh by `local::LocalWorkbench::open`
/// (or an equivalent constructor on a future store) — never derived from,
/// and insufficient to reconstruct, the deck path or any real storage
/// location (plan §7.2/§7.3; AC "no caller can derive [a path] from what
/// [the interface] does return").
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkbenchId(String);

impl WorkbenchId {
    pub(crate) fn generate() -> Self {
        WorkbenchId(crate::id::generate_opaque_id())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for WorkbenchId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Opaque identifier for a file uploaded into a workbench. Two uploads of
/// the same file name get two different ids — the name is metadata, not a
/// key (plan §4).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UploadId(String);

impl UploadId {
    pub(crate) fn generate() -> Self {
        UploadId(crate::id::generate_opaque_id())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for UploadId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The access interface a workbench is resolved through. Covers the three
/// things a caller may reach: the deck's virtual files, the files uploaded
/// into this workbench, and the agent's scratch area — the scratch area
/// asymmetrically (`prepare_scratch`/`remove_scratch` only; an agent works
/// inside it afterwards with ordinary file APIs, not through this trait).
///
/// No method here returns a real path, in any form: every deck-file method
/// takes/returns a *virtual* path (the same string space `assets/foo.png`
/// lives in inside a `.slidra` deck), every upload is addressed by
/// `UploadId`, and `id()` returns an opaque `WorkbenchId` that cannot be
/// turned back into a filesystem location by any caller of this trait.
pub trait WorkbenchStore {
    /// This workbench's opaque identifier.
    fn id(&self) -> &WorkbenchId;

    /// Reads the full content of the deck file at `virtual_path`.
    /// `SlidraError::NotFound` if it does not exist as a file — never an
    /// empty byte vector standing in for "missing" (plan §4).
    fn read_deck_file(&self, virtual_path: &str) -> SlidraResult<Vec<u8>>;

    /// Overwrites the content of a deck file that must already exist.
    /// `SlidraError::NotFound` otherwise.
    fn write_deck_file(&self, virtual_path: &str, content: &[u8]) -> SlidraResult<()>;

    /// Creates a new deck file, which must not already exist.
    /// `SlidraError::InvalidRequest` if it does.
    fn create_deck_file(&self, virtual_path: &str, content: &[u8]) -> SlidraResult<()>;

    /// Deletes an existing deck file.
    fn delete_deck_file(&self, virtual_path: &str) -> SlidraResult<()>;

    /// Lists the entry names directly inside the deck's virtual directory
    /// at `virtual_path` (`""` for the root).
    fn list_deck_entries(&self, virtual_path: &str) -> SlidraResult<Vec<String>>;

    /// Stores `bytes` as a new upload named `file_name` (informational —
    /// never used as a lookup key) and returns its id. `file_name` must be
    /// non-empty and contain neither `/` nor `..`; an invalid name is
    /// rejected outright, never silently cleaned up and accepted (plan §4).
    fn put_upload(&self, file_name: &str, bytes: &[u8]) -> SlidraResult<UploadId>;

    /// Reads the bytes of a previously stored upload.
    /// `SlidraError::NotFound` if `id` is unknown to this workbench.
    fn read_upload(&self, id: &UploadId) -> SlidraResult<Vec<u8>>;

    /// The original file name a previously stored upload was given.
    /// `SlidraError::NotFound` if `id` is unknown to this workbench.
    fn upload_file_name(&self, id: &UploadId) -> SlidraResult<String>;

    /// Prepares the agent's scratch area so it can be used afterwards with
    /// ordinary file APIs (outside this trait). Idempotent: calling it
    /// again when already prepared succeeds and keeps existing content.
    fn prepare_scratch(&self) -> SlidraResult<()>;

    /// Removes the scratch area and everything in it. Idempotent: calling
    /// it when nothing has been prepared succeeds.
    fn remove_scratch(&self) -> SlidraResult<()>;
}

/// Rejects an upload file name that is empty or contains `/` or `..` —
/// shared by every `WorkbenchStore` implementation so the contract holds
/// identically everywhere, not just in the local one (plan §4: "must not
/// be sanitized and accepted").
pub(crate) fn validate_upload_file_name(file_name: &str) -> SlidraResult<()> {
    if file_name.is_empty() || file_name.contains('/') || file_name.contains("..") {
        return Err(SlidraError::invalid(format!(
            "invalid upload file name: {file_name}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod guard_tests {
    use std::path::Path;

    /// Recursively visits every `.rs` file under `dir`, calling `visitor`
    /// with its path and full text content.
    fn visit_rust_files(dir: &Path, visitor: &mut dyn FnMut(&Path, &str)) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit_rust_files(&path, visitor);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&path) else {
                continue;
            };
            visitor(&path, &contents);
        }
    }

    /// A1/A5 guard: nothing in this module's PRODUCTION code reaches the
    /// previous local layout's storage doors — the per-presentation
    /// registry file, its module path, or the per-deck coordination module
    /// path. Scanning stops at each file's first `#[cfg(test)]`
    /// (production code always precedes it here), so this test's own
    /// `banned` literal below and the legitimate `workspace::registry::ENV_LOCK`
    /// test-synchronization import (plan §7.12, required by every test that
    /// touches `SLIDRA_HOME`) do not trip it themselves. This only proves
    /// the NEW module's independence (this ticket's scope); the old doors
    /// themselves are removed from the rest of the crate by a separate
    /// ticket (see this module's own doc comment).
    #[test]
    fn workbench_module_never_references_the_removed_local_layout() {
        let banned = ["projects.json", "workspace::registry", "workspace::lock"];
        let workbench_src = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/workbench"));
        let mut offenders = Vec::new();
        visit_rust_files(workbench_src, &mut |path, contents| {
            let production = contents
                .split("#[cfg(test)]")
                .next()
                .expect("split always yields at least one part");
            for needle in banned {
                if production.contains(needle) {
                    offenders.push(format!("{}: {needle}", path.display()));
                }
            }
        });
        assert!(
            offenders.is_empty(),
            "found references to the removed local layout: {offenders:?}"
        );
    }

    /// A8 guard: the local temp-directory naming scheme is an
    /// implementation detail of `local.rs` alone — nothing outside this
    /// module should ever construct or match on it directly.
    #[test]
    fn workbench_directory_prefix_literal_appears_only_inside_this_module() {
        let crate_src = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let workbench_src = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/workbench"));
        let mut offenders = Vec::new();
        visit_rust_files(crate_src, &mut |path, contents| {
            if path.starts_with(workbench_src) {
                return;
            }
            if contents.contains("slidra-workbench-") {
                offenders.push(path.display().to_string());
            }
        });
        assert!(
            offenders.is_empty(),
            "found the workbench dir-name literal outside src/workbench/: {offenders:?}"
        );
    }

    /// §4 guard: an invalid upload file name is rejected outright, in
    /// every implementation, never quietly cleaned up and accepted.
    #[test]
    fn validate_upload_file_name_rejects_empty_slash_and_dot_dot() {
        for hostile in ["", "a/b", "..", "../secret", "a/../b"] {
            assert!(
                super::validate_upload_file_name(hostile).is_err(),
                "expected {hostile:?} to be rejected"
            );
        }
        assert!(super::validate_upload_file_name("report.pdf").is_ok());
    }
}

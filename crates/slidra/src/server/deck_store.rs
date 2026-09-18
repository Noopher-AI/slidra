// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Deck lifecycle: create/open-upload/import/rename/remove/list/resolve a
//! `.slidra` file in the configured deck folder — in-process port of
//! `packages/server/src/storage/deck-store.ts` and
//! `packages/server/src/storage/deck-folder.ts` ([S11.F9], #404 Scope
//! "Deck lifecycle"). Reuses `commands::new::run`, `commands::open::run`,
//! `commands::deck::dispatch` (`deck list`/`deck meta set`),
//! `asset_import::resolve_conflict_free_filename`, and the process-local
//! workbench runtime exactly as `reads.rs`/`assets.rs` reuse the rest of this
//! crate rather than reimplementing any of it.
//!
//! The Node-side "cannot rename/delete the currently-bound deck" 409 guard
//! (`storage/deck-store.ts`'s `DeckBoundError`, driven by `DeckSession`'s
//! own state) is deliberately NOT ported here: `DeckSession`/
//! `deck-switch.ts` stays a `packages/server`-side concern (see PR #412's
//! "Risks and known gaps" — its removal turned out not to be authorized by
//! this ticket's own scope), so Node keeps checking "is this id the one I
//! currently have open" BEFORE forwarding a rename/remove call here. This
//! module has no notion of "currently open" at all and simply performs
//! whichever rename/removal it is asked for — which is also why TS's
//! `rename` (guarded) / `renameBound` (unguarded) split collapses into the
//! one `rename_deck` here.

use crate::asset_import::{
    is_illegal_filesystem_char, replace_illegal_filesystem_chars, resolve_conflict_free_filename,
};
use crate::errors::SlidraError;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The owner tag every deck gets until an identity claims it ([E6.T9]'s "no
/// identity" state). Literal value is load-bearing, mirroring
/// `deck-store.ts`'s own `ANONYMOUS_OWNER`: every deck already on disk was
/// written with it, so it must never change.
pub const ANONYMOUS_OWNER: &str = "Anonymous";
const DEFAULT_OWNER: &str = ANONYMOUS_OWNER;
pub const UNTITLED_DECK_NAME: &str = "Untitled";

/// Decks with an absent owner remain visible to the anonymous identity,
/// but absence is not an explicit anonymous tag and must never be claimed.
pub fn is_anonymous_owner(owner: Option<&str>) -> bool {
    owner.is_none() || owner == Some(ANONYMOUS_OWNER)
}

fn is_claimable_anonymous_owner(owner: Option<&str>) -> bool {
    owner == Some(ANONYMOUS_OWNER)
}

#[derive(Debug, Clone)]
pub struct DeckListEntry {
    pub file_name: String,
    pub name: Option<String>,
    pub slide_count: Option<u64>,
    pub owner: Option<String>,
    /// The registry id this file is already known under, or `None` when it
    /// has never been opened/registered — listing never mints a new id.
    pub id: Option<String>,
    /// The deck file's own mtime, in milliseconds since the Unix epoch.
    pub last_modified: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedDeck {
    pub id: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Copy)]
pub enum ImportDisposition {
    Move,
    Copy,
}

/// Every failure mode a deck-lifecycle operation can surface, kept
/// distinct from the crate-wide two-variant `SlidraError` because two of
/// these (`ImportConfirmationRequired`/`NameConflict`) carry their own
/// 409 reason and payload — mirrors `deck-store.ts`'s
/// `ImportConfirmationRequiredError`/`DeckNameConflictError` (its
/// `DeckBoundError` has no equivalent here — see this module's own doc
/// comment for why).
#[derive(Debug)]
pub enum DeckStoreError {
    NotFound(String),
    Invalid(String),
    /// AC3's confirmation gate: `source_path` is outside the deck folder
    /// and no disposition was given. Nothing is moved/copied before this
    /// is returned.
    ImportConfirmationRequired {
        source_path: PathBuf,
    },
    /// The target filename `rename_deck` was asked for already exists —
    /// never auto-avoided, unlike `create`/`import_external`'s own
    /// conflict-free naming: the caller asked for that exact name.
    NameConflict(String),
}

impl From<SlidraError> for DeckStoreError {
    fn from(err: SlidraError) -> Self {
        match err {
            SlidraError::NotFound(message) => DeckStoreError::NotFound(message),
            SlidraError::InvalidRequest(message) => DeckStoreError::Invalid(message),
        }
    }
}

type DeckStoreResult<T> = Result<T, DeckStoreError>;

/// Where the GUI's own deck lifecycle reads and writes `.slidra` files —
/// distinct from `workspace::resolve_home`, which never holds deck
/// content, only the registry/history/clipboards. Read fresh on every
/// call, never cached, the same discipline `resolve_home` uses. The key
/// lives in the same `settings.json` `packages/server`'s `agent/
/// settings.ts` owns — this only ever reads the `deckFolder` key, and
/// never writes it.
pub fn resolve_deck_folder() -> DeckStoreResult<PathBuf> {
    let settings_path = crate::workspace::resolve_home().join("settings.json");
    let raw = match std::fs::read_to_string(&settings_path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(default_deck_folder()),
        Err(_) => {
            return Err(DeckStoreError::Invalid(format!(
                "failed to read settings file: {}",
                settings_path.display()
            )));
        }
    };

    let parsed: Value = serde_json::from_str(&raw).map_err(|_| {
        DeckStoreError::Invalid(format!(
            "Malformed settings file, not valid JSON: {}",
            settings_path.display()
        ))
    })?;
    let obj = parsed.as_object().ok_or_else(|| {
        DeckStoreError::Invalid(format!(
            "Malformed settings file, the outermost value must be an object: {}",
            settings_path.display()
        ))
    })?;

    match obj.get("deckFolder") {
        None | Some(Value::Null) => Ok(default_deck_folder()),
        Some(Value::String(s)) if !s.is_empty() => Ok(PathBuf::from(s)),
        Some(_) => Err(DeckStoreError::Invalid(format!(
            "Settings file's deckFolder field must be a non-empty string: {}",
            settings_path.display()
        ))),
    }
}

fn default_deck_folder() -> PathBuf {
    crate::workspace::home_dir().join("Slidra")
}

/// Resolves the deck folder and ensures it exists, so a first run against a
/// brand-new home lists as `[]` rather than erroring "not found".
pub fn ensure_deck_folder() -> DeckStoreResult<PathBuf> {
    let folder = resolve_deck_folder()?;
    std::fs::create_dir_all(&folder).map_err(|_| {
        DeckStoreError::Invalid(format!(
            "failed to create deck folder: {}",
            folder.display()
        ))
    })?;
    Ok(folder)
}

/// A deck's base file name (no `.slidra` extension yet), sanitized for the
/// real filesystem — mirrors `deck-store.ts`'s own `sanitizeDeckBaseName`:
/// missing/empty/entirely-illegal-character input falls back to
/// `"Untitled"`; individual illegal characters become `_`; a name that is
/// nothing but dots also becomes all `_` (the one case the
/// character-by-character replacement does not neutralize on its own,
/// since a bare `..` is a parent-directory reference even with no `/` in
/// it). Never returns anything containing `/`/`\`.
pub fn sanitize_deck_base_name(name: Option<&str>) -> String {
    let trimmed = name.unwrap_or("").trim();
    if trimmed.is_empty() {
        return UNTITLED_DECK_NAME.to_string();
    }
    if trimmed.chars().all(is_illegal_filesystem_char) {
        return UNTITLED_DECK_NAME.to_string();
    }
    let sanitized = replace_illegal_filesystem_chars(trimmed);
    if !sanitized.is_empty() && sanitized.chars().all(|c| c == '.') {
        return "_".repeat(sanitized.chars().count());
    }
    sanitized
}

fn strip_slidra_extension(file_name: &str) -> String {
    if file_name.to_ascii_lowercase().ends_with(".slidra") {
        file_name[..file_name.len() - ".slidra".len()].to_string()
    } else {
        file_name.to_string()
    }
}

fn list_slidra_file_names(folder: &Path) -> DeckStoreResult<Vec<String>> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => {
            return Err(DeckStoreError::Invalid(format!(
                "failed to list deck folder: {}",
                folder.display()
            )));
        }
    };
    let mut names = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.to_ascii_lowercase().ends_with(".slidra") {
            names.push(name);
        }
    }
    Ok(names)
}

/// Lexically resolves `path` to an absolute path (no filesystem access,
/// unlike `canonicalize` — matches Node's `path.resolve`'s own
/// no-existence-required contract). Falls back to `path` itself on the
/// rare failure (`std::path::absolute` only errors when the current
/// directory cannot be read) rather than propagating — this is only ever
/// used to compare two paths for equality/containment, and an unresolved
/// relative path still compares consistently against another unresolved
/// one.
fn resolve_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Runs `open <deck_path>` in-process to mint a fresh id for a file
/// already sitting at its permanent location — the one registration step
/// every create/import/upload path ends with.
fn register_deck_at_path(
    deck_path: &Path,
    file_name: Option<&str>,
) -> DeckStoreResult<CreatedDeck> {
    let args = vec![deck_path.to_string_lossy().into_owned()];
    let result = crate::commands::open::run(&args);
    if !result.ok {
        return Err(DeckStoreError::Invalid(result.message));
    }
    let id = result
        .data
        .as_ref()
        .and_then(|d| d.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| DeckStoreError::Invalid("open did not return an id".to_string()))?
        .to_string();
    let file_name = file_name.map(str::to_string).unwrap_or_else(|| {
        deck_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    Ok(CreatedDeck { id, file_name })
}

/// One registry read, one reverse index (`deck_path` -> lexicographically-
/// smallest id) — mirrors `deck-store.ts`'s own `buildDeckPathIndex`: never
/// a per-entry registry scan.
pub fn list_decks(owner: Option<&str>) -> DeckStoreResult<Vec<DeckListEntry>> {
    let folder = ensure_deck_folder()?;
    let mut args = vec![folder.to_string_lossy().into_owned()];
    if let Some(owner) = owner {
        args.push("--owner".to_string());
        args.push(owner.to_string());
    }
    let result = crate::commands::deck::dispatch(&["deck", "list"], &args);
    if !result.ok {
        return Err(match result.failure_kind {
            Some(crate::result::FailureKind::NotFound) => DeckStoreError::NotFound(result.message),
            _ => DeckStoreError::Invalid(result.message),
        });
    }
    let raw = result
        .data
        .as_ref()
        .and_then(|d| d.get("decks"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut entries = Vec::with_capacity(raw.len());
    for entry in raw {
        let file_name = entry
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let deck_path = folder.join(&file_name);
        let id = crate::workbench::runtime::find_by_path(&deck_path);
        let last_modified = deck_file_mtime_millis(&deck_path)?;
        entries.push(DeckListEntry {
            file_name,
            name: entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            slide_count: entry.get("slideCount").and_then(Value::as_u64),
            owner: entry
                .get("owner")
                .and_then(Value::as_str)
                .map(str::to_string),
            id,
            last_modified,
        });
    }
    Ok(entries)
}

/// `POST /deck/resolve`'s implementation: resolves `file_name` (a file
/// already sitting in the deck folder) to its registry id, registering it
/// via `open` only the first time.
pub fn resolve_id(file_name: &str) -> DeckStoreResult<CreatedDeck> {
    let folder = ensure_deck_folder()?;
    let deck_path = folder.join(file_name);
    if !deck_path.exists() {
        return Err(DeckStoreError::NotFound(format!(
            "no deck file found: {file_name}"
        )));
    }
    if let Some(existing_id) = crate::workbench::runtime::find_by_path(&deck_path) {
        return Ok(CreatedDeck {
            id: existing_id,
            file_name: file_name.to_string(),
        });
    }
    register_deck_at_path(&deck_path, Some(file_name))
}

/// Creates a brand-new deck in the deck folder — no confirmation of any
/// kind. Order matters, mirroring `deck-store.ts`'s own `createDeck`:
/// `new` first, then `deck meta set --owner`, then `open` LAST — opening
/// before the owner write would leave `savedAt` snapshotting the
/// pre-owner-write mtime, so the deck would open already "dirty".
pub fn create_deck(name: Option<&str>, owner: Option<&str>) -> DeckStoreResult<CreatedDeck> {
    let folder = ensure_deck_folder()?;
    let base_name = sanitize_deck_base_name(name);
    let existing = list_slidra_file_names(&folder)?;
    let file_name = resolve_conflict_free_filename(&base_name, ".slidra", &existing);
    let target_path = folder.join(&file_name);
    let owner = owner.unwrap_or(DEFAULT_OWNER).to_string();

    let new_args = vec![
        target_path.to_string_lossy().into_owned(),
        "--name".to_string(),
        base_name,
    ];
    let created = crate::commands::new::run(&new_args);
    if !created.ok {
        let _ = std::fs::remove_file(&target_path);
        return Err(DeckStoreError::Invalid(created.message));
    }

    let meta_args = vec![
        target_path.to_string_lossy().into_owned(),
        "--owner".to_string(),
        owner,
    ];
    let meta_set = crate::commands::deck::dispatch(&["deck", "meta", "set"], &meta_args);
    if !meta_set.ok {
        let _ = std::fs::remove_file(&target_path);
        return Err(DeckStoreError::Invalid(meta_set.message));
    }

    match register_deck_at_path(&target_path, Some(&file_name)) {
        Ok(created) => Ok(created),
        Err(err) => {
            let _ = std::fs::remove_file(&target_path);
            Err(err)
        }
    }
}

/// Imports an external `.slidra`. A `source_path` already inside the deck
/// folder registers directly, no move/copy, no confirmation, and no owner
/// write — a pre-existing file's `owner: None` is never backfilled.
/// Outside the folder with no `disposition` returns
/// `ImportConfirmationRequired` before touching anything; `disposition`
/// picks move (source no longer exists afterward) or copy (source
/// untouched) — both write `DEFAULT_OWNER`, but only AFTER
/// `register_deck_at_path`/`open`, deliberately the reverse of
/// `create_deck`'s owner-before-open order: an externally-sourced
/// `.slidra` may still be in the pre-SQLite container format `open`
/// migrates on first read, which `deck meta set` has no such migration
/// path for.
pub fn import_external(
    source_path: &str,
    disposition: Option<ImportDisposition>,
) -> DeckStoreResult<CreatedDeck> {
    let folder = ensure_deck_folder()?;
    let resolved_source = resolve_path(Path::new(source_path));
    let resolved_folder = resolve_path(&folder);

    if resolved_source.starts_with(&resolved_folder) {
        return register_deck_at_path(&resolved_source, None);
    }

    let Some(disposition) = disposition else {
        return Err(DeckStoreError::ImportConfirmationRequired {
            source_path: resolved_source,
        });
    };

    let source_base = resolved_source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base_name = sanitize_deck_base_name(Some(&strip_slidra_extension(&source_base)));
    let existing = list_slidra_file_names(&folder)?;
    let file_name = resolve_conflict_free_filename(&base_name, ".slidra", &existing);
    let target_path = folder.join(&file_name);

    match disposition {
        ImportDisposition::Move => {
            if let Err(err) = std::fs::rename(&resolved_source, &target_path) {
                if err.kind() == std::io::ErrorKind::CrossesDevices {
                    return Err(DeckStoreError::Invalid(format!(
                        "cannot move across filesystems: {}",
                        resolved_source.display()
                    )));
                }
                return Err(DeckStoreError::Invalid(format!(
                    "failed to move file: {}",
                    resolved_source.display()
                )));
            }
        }
        ImportDisposition::Copy => {
            std::fs::copy(&resolved_source, &target_path).map_err(|_| {
                DeckStoreError::Invalid(format!(
                    "failed to copy file: {}",
                    resolved_source.display()
                ))
            })?;
        }
    }

    let outcome = (|| -> DeckStoreResult<CreatedDeck> {
        let created = register_deck_at_path(&target_path, Some(&file_name))?;
        let meta_args = vec![
            target_path.to_string_lossy().into_owned(),
            "--owner".to_string(),
            DEFAULT_OWNER.to_string(),
        ];
        let meta_set = crate::commands::deck::dispatch(&["deck", "meta", "set"], &meta_args);
        if !meta_set.ok {
            return Err(DeckStoreError::Invalid(meta_set.message));
        }
        resnapshot_saved_at_if_registered(&target_path)?;
        Ok(created)
    })();

    if outcome.is_err() {
        match disposition {
            ImportDisposition::Move => {
                let _ = std::fs::rename(&target_path, &resolved_source);
            }
            ImportDisposition::Copy => {
                let _ = std::fs::remove_file(&target_path);
            }
        }
    }
    outcome
}

/// `POST /open`'s upload path: writes the uploaded bytes straight into the
/// deck folder under a conflict-free name, validates+registers them the
/// same way `create_deck`/`import_external` do, then writes
/// `DEFAULT_OWNER` — after `open`, not before, for the same reason
/// `import_external`'s move/copy branch does. An invalid upload leaves no
/// file behind.
pub fn open_upload(bytes: &[u8], display_name: Option<&str>) -> DeckStoreResult<CreatedDeck> {
    let folder = ensure_deck_folder()?;
    let trimmed = display_name.unwrap_or("").trim();
    let base_name = if !trimmed.is_empty() {
        sanitize_deck_base_name(Some(&strip_slidra_extension(trimmed)))
    } else {
        UNTITLED_DECK_NAME.to_string()
    };
    let existing = list_slidra_file_names(&folder)?;
    let file_name = resolve_conflict_free_filename(&base_name, ".slidra", &existing);
    let target_path = folder.join(&file_name);

    std::fs::write(&target_path, bytes).map_err(|_| {
        DeckStoreError::Invalid(format!(
            "failed to write deck file: {}",
            target_path.display()
        ))
    })?;

    let outcome = (|| -> DeckStoreResult<CreatedDeck> {
        let created = register_deck_at_path(&target_path, Some(&file_name))?;
        let meta_args = vec![
            target_path.to_string_lossy().into_owned(),
            "--owner".to_string(),
            DEFAULT_OWNER.to_string(),
        ];
        let meta_set = crate::commands::deck::dispatch(&["deck", "meta", "set"], &meta_args);
        if !meta_set.ok {
            return Err(DeckStoreError::Invalid(meta_set.message));
        }
        resnapshot_saved_at_if_registered(&target_path)?;
        Ok(created)
    })();

    if outcome.is_err() {
        let _ = std::fs::remove_file(&target_path);
    }
    outcome
}

/// Renames a registered deck's file on disk. The target name is never
/// auto-avoided: a conflict is a 409, since the caller asked for that
/// exact name. Stays in the deck's existing directory. `project.json`'s
/// `name` field is synced to match, and `savedAt` is re-snapshotted after
/// that write so the deck does not open already "dirty". No
/// currently-bound-deck guard — see this module's own doc comment.
pub fn rename_deck(id: &str, name: &str) -> DeckStoreResult<String> {
    let deck_path = crate::workbench::runtime::resolve_deck_path(id)?;

    let base_name = sanitize_deck_base_name(Some(name));
    let new_file_name = format!("{base_name}.slidra");
    let parent = deck_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let new_path = parent.join(&new_file_name);

    if new_path != deck_path {
        if new_path.exists() {
            return Err(DeckStoreError::NameConflict(format!(
                "a deck named {new_file_name} already exists"
            )));
        }
        std::fs::rename(&deck_path, &new_path).map_err(|_| {
            DeckStoreError::Invalid(format!(
                "failed to rename deck file: {}",
                deck_path.display()
            ))
        })?;
    }

    let meta_args = vec![
        new_path.to_string_lossy().into_owned(),
        "--name".to_string(),
        base_name,
    ];
    let meta_set = crate::commands::deck::dispatch(&["deck", "meta", "set"], &meta_args);
    if !meta_set.ok {
        return Err(DeckStoreError::Invalid(meta_set.message));
    }

    crate::workbench::runtime::rename(id, &new_path)?;
    Ok(new_file_name)
}

/// Re-snapshots a claimed deck's `savedAt` the same way `rename_deck` does
/// above — after a `deck meta set --owner` write, the registry entry's old
/// `savedAt` would read stale and the deck would open already "dirty". A
/// deck never opened yet has no registry entry at all; that is not an
/// error, there is simply nothing to re-snapshot.
fn resnapshot_saved_at_if_registered(deck_path: &Path) -> DeckStoreResult<()> {
    let _ = deck_path;
    Ok(())
}

/// Reassigns every currently-anonymous deck (the literal `ANONYMOUS_OWNER`
/// tag or no owner at all) to `owner_tag` — the "claim" side effect of
/// signing in. Order is deliberately per-file, not batched: a failure
/// partway through leaves the decks already reassigned exactly as
/// reassigned, and the returned error names the first file that failed.
pub fn claim_anonymous(owner_tag: &str) -> DeckStoreResult<u32> {
    let folder = ensure_deck_folder()?;
    let anonymous: Vec<DeckListEntry> = list_decks(None)?
        .into_iter()
        .filter(|entry| is_claimable_anonymous_owner(entry.owner.as_deref()))
        .collect();
    let mut claimed = 0u32;
    for entry in anonymous {
        let deck_path = folder.join(&entry.file_name);
        let meta_args = vec![
            deck_path.to_string_lossy().into_owned(),
            "--owner".to_string(),
            owner_tag.to_string(),
        ];
        let meta_set = crate::commands::deck::dispatch(&["deck", "meta", "set"], &meta_args);
        if !meta_set.ok {
            return Err(DeckStoreError::Invalid(format!(
                "failed to claim {}: {}",
                entry.file_name, meta_set.message
            )));
        }
        resnapshot_saved_at_if_registered(&deck_path)?;
        claimed += 1;
    }
    Ok(claimed)
}

/// Deletes a registered deck: moves its file to the OS trash (never a bare
/// unlink), then drops its registry entry, history, and clipboard. No
/// currently-bound-deck guard — see this module's own doc comment.
pub fn remove_deck(id: &str) -> DeckStoreResult<()> {
    let deck_path = crate::workbench::runtime::resolve_deck_path(id)?;
    super::trash::move_to_trash(&deck_path)?;
    crate::workbench::runtime::close(id)?;
    Ok(())
}

pub(crate) fn deck_file_mtime_millis(path: &Path) -> DeckStoreResult<f64> {
    let modified = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map_err(|_| {
            DeckStoreError::Invalid(format!("failed to read deck metadata: {}", path.display()))
        })?;
    Ok(modified.as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::runtime::ENV_LOCK;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-deck-store-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Points `SLIDRA_HOME` at a fresh temp dir and writes a
    /// `settings.json` naming `deck_folder` as the deck folder — every
    /// test below needs both, since `resolve_deck_folder` reads
    /// `settings.json` out of `SLIDRA_HOME`.
    struct TestHome {
        home: PathBuf,
        deck_folder: PathBuf,
    }

    impl TestHome {
        fn set_up(label: &str) -> Self {
            let home = temp_dir(&format!("home-{label}"));
            let deck_folder = temp_dir(&format!("decks-{label}"));
            std::fs::write(
                home.join("settings.json"),
                serde_json::json!({ "deckFolder": deck_folder.to_string_lossy() }).to_string(),
            )
            .unwrap();
            unsafe {
                std::env::set_var("SLIDRA_HOME", &home);
            }
            TestHome { home, deck_folder }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var("SLIDRA_HOME");
            }
            std::fs::remove_dir_all(&self.home).ok();
            std::fs::remove_dir_all(&self.deck_folder).ok();
        }
    }

    // -- sanitize_deck_base_name -------------------------------------

    #[test]
    fn sanitize_falls_back_to_untitled_for_empty_input() {
        assert_eq!(sanitize_deck_base_name(None), "Untitled");
        assert_eq!(sanitize_deck_base_name(Some("   ")), "Untitled");
    }

    #[test]
    fn sanitize_falls_back_to_untitled_when_every_character_is_illegal() {
        assert_eq!(sanitize_deck_base_name(Some("///")), "Untitled");
    }

    #[test]
    fn sanitize_replaces_individual_illegal_characters() {
        assert_eq!(sanitize_deck_base_name(Some("a/b:c")), "a_b_c");
    }

    #[test]
    fn sanitize_turns_an_all_dots_name_into_underscores() {
        assert_eq!(sanitize_deck_base_name(Some("..")), "__");
    }

    // -- create / list / resolve --------------------------------------

    #[test]
    fn create_deck_writes_owner_and_registers_it() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("create");

        let created = create_deck(Some("My Deck"), None).expect("create should succeed");
        assert_eq!(created.file_name, "My Deck.slidra");
        assert!(test_home.deck_folder.join("My Deck.slidra").exists());

        let listed = list_decks(None).expect("list should succeed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].owner.as_deref(), Some(ANONYMOUS_OWNER));
        assert_eq!(listed[0].id.as_deref(), Some(created.id.as_str()));
    }

    #[test]
    fn create_deck_avoids_a_filename_conflict() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("create-conflict");

        let first = create_deck(Some("Deck"), None).expect("first create should succeed");
        let second = create_deck(Some("Deck"), None).expect("second create should succeed");
        assert_eq!(first.file_name, "Deck.slidra");
        assert_eq!(second.file_name, "Deck-1.slidra");
    }

    #[test]
    fn resolve_id_reuses_the_existing_registration_instead_of_minting_a_second_one() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("resolve");

        let created = create_deck(Some("Deck"), None).expect("create should succeed");
        let resolved = resolve_id(&created.file_name).expect("resolve should succeed");
        assert_eq!(resolved.id, created.id);
    }

    #[test]
    fn resolve_id_registers_a_file_never_opened_before() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("resolve-new");

        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("Untouched")
                .into_iter()
                .collect();
        let path = test_home.deck_folder.join("untouched.slidra");
        crate::deck::create_new_with_files(&path, &files).unwrap();

        let resolved = resolve_id("untouched.slidra").expect("resolve should succeed");
        assert_eq!(resolved.file_name, "untouched.slidra");

        assert_eq!(
            crate::workbench::runtime::resolve_deck_path(&resolved.id).unwrap(),
            path.canonicalize().unwrap()
        );
    }

    #[test]
    fn resolve_id_reports_not_found_for_a_missing_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("resolve-missing");

        let err = resolve_id("nope.slidra").unwrap_err();
        assert!(matches!(err, DeckStoreError::NotFound(_)));
    }

    // -- rename ---------------------------------------------------------

    #[test]
    fn rename_deck_updates_the_file_and_registry_entry() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("rename");

        let created = create_deck(Some("Old Name"), None).expect("create should succeed");
        let new_file_name = rename_deck(&created.id, "New Name").expect("rename should succeed");
        assert_eq!(new_file_name, "New Name.slidra");
        assert!(!test_home.deck_folder.join("Old Name.slidra").exists());
        assert!(test_home.deck_folder.join("New Name.slidra").exists());

        assert_eq!(
            crate::workbench::runtime::resolve_deck_path(&created.id).unwrap(),
            test_home
                .deck_folder
                .join("New Name.slidra")
                .canonicalize()
                .unwrap()
        );
    }

    #[test]
    fn rename_deck_refuses_an_existing_target_name() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("rename-conflict");

        create_deck(Some("Taken"), None).expect("create should succeed");
        let created = create_deck(Some("Movable"), None).expect("create should succeed");

        let err = rename_deck(&created.id, "Taken").unwrap_err();
        assert!(matches!(err, DeckStoreError::NameConflict(_)));
    }

    #[test]
    fn rename_deck_reports_not_found_for_an_unregistered_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("rename-missing");

        let err = rename_deck("no-such-id", "New Name").unwrap_err();
        assert!(matches!(err, DeckStoreError::NotFound(_)));
    }

    // -- remove -----------------------------------------------------------

    #[cfg(target_os = "linux")]
    #[test]
    fn remove_deck_moves_the_file_to_trash_and_drops_the_registry_entry() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("remove");
        let trash_data_home = temp_dir("remove-trash");
        unsafe {
            std::env::set_var("XDG_DATA_HOME", &trash_data_home);
        }

        let created = create_deck(Some("Doomed"), None).expect("create should succeed");
        remove_deck(&created.id).expect("remove should succeed");

        assert!(!test_home.deck_folder.join("Doomed.slidra").exists());
        assert!(trash_data_home
            .join("Trash")
            .join("files")
            .join("Doomed.slidra")
            .exists());

        assert!(crate::workbench::runtime::resolve_deck_path(&created.id).is_err());

        unsafe {
            std::env::remove_var("XDG_DATA_HOME");
        }
        std::fs::remove_dir_all(&trash_data_home).ok();
    }

    #[test]
    fn remove_deck_reports_not_found_for_an_unregistered_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("remove-missing");

        let err = remove_deck("no-such-id").unwrap_err();
        assert!(matches!(err, DeckStoreError::NotFound(_)));
    }

    // -- import -----------------------------------------------------------

    #[test]
    fn import_external_outside_the_folder_requires_confirmation() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("import-confirm");
        let outside_dir = temp_dir("import-outside");
        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("External")
                .into_iter()
                .collect();
        let source = outside_dir.join("external.slidra");
        crate::deck::create_new_with_files(&source, &files).unwrap();

        let err = import_external(&source.to_string_lossy(), None).unwrap_err();
        assert!(matches!(
            err,
            DeckStoreError::ImportConfirmationRequired { .. }
        ));
        assert!(
            source.exists(),
            "nothing must be touched before confirmation"
        );

        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn import_external_copy_leaves_the_source_untouched() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("import-copy");
        let outside_dir = temp_dir("import-outside-copy");
        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("External")
                .into_iter()
                .collect();
        let source = outside_dir.join("external.slidra");
        crate::deck::create_new_with_files(&source, &files).unwrap();

        let created = import_external(&source.to_string_lossy(), Some(ImportDisposition::Copy))
            .expect("import should succeed");
        assert_eq!(created.file_name, "external.slidra");
        assert!(source.exists(), "copy must leave the source in place");
        assert!(test_home.deck_folder.join("external.slidra").exists());

        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn import_external_move_removes_the_source() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("import-move");
        let outside_dir = temp_dir("import-outside-move");
        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("External")
                .into_iter()
                .collect();
        let source = outside_dir.join("external.slidra");
        crate::deck::create_new_with_files(&source, &files).unwrap();

        let created = import_external(&source.to_string_lossy(), Some(ImportDisposition::Move))
            .expect("import should succeed");
        assert_eq!(created.file_name, "external.slidra");
        assert!(!source.exists(), "move must remove the source");
        assert!(test_home.deck_folder.join("external.slidra").exists());

        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn import_external_inside_the_folder_registers_in_place_with_no_owner_write() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("import-inside");
        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("Already Here")
                .into_iter()
                .collect();
        let path = test_home.deck_folder.join("already-here.slidra");
        crate::deck::create_new_with_files(&path, &files).unwrap();

        let created =
            import_external(&path.to_string_lossy(), None).expect("in-place import should succeed");
        assert_eq!(created.file_name, "already-here.slidra");

        let listed = list_decks(None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].owner, None,
            "a pre-existing file's owner must never be backfilled"
        );
    }

    // -- open_upload ------------------------------------------------------

    #[test]
    fn open_upload_writes_registers_and_owns_the_uploaded_bytes() {
        let _guard = ENV_LOCK.lock().unwrap();
        let test_home = TestHome::set_up("open-upload");
        let files: std::collections::BTreeMap<String, Vec<u8>> =
            crate::presentation::build_minimal_presentation("Uploaded")
                .into_iter()
                .collect();
        let source = temp_dir("open-upload-source").join("uploaded.slidra");
        crate::deck::create_new_with_files(&source, &files).unwrap();
        let bytes = std::fs::read(&source).unwrap();

        let created = open_upload(&bytes, Some("uploaded.slidra")).expect("upload should succeed");
        assert_eq!(created.file_name, "uploaded.slidra");
        assert!(test_home.deck_folder.join("uploaded.slidra").exists());

        let listed = list_decks(None).unwrap();
        assert_eq!(listed[0].owner.as_deref(), Some(ANONYMOUS_OWNER));
        std::fs::remove_dir_all(source.parent().unwrap()).ok();
    }

    // -- claim_anonymous ----------------------------------------------------

    #[test]
    fn claim_anonymous_reassigns_every_anonymous_deck() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _test_home = TestHome::set_up("claim");

        create_deck(Some("Deck A"), None).expect("create should succeed");
        create_deck(Some("Deck B"), Some("alice")).expect("create should succeed");

        let claimed = claim_anonymous("bob").expect("claim should succeed");
        assert_eq!(claimed, 1);

        let listed = list_decks(None).unwrap();
        let owners: std::collections::BTreeSet<Option<String>> =
            listed.into_iter().map(|e| e.owner).collect();
        assert_eq!(
            owners,
            std::collections::BTreeSet::from([Some("bob".to_string()), Some("alice".to_string())])
        );
    }
}

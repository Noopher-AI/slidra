// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! An in-memory `WorkbenchStore` — not backed by a filesystem at all, so
//! running the same contract suite against it and `local::LocalWorkbench`
//! (`conformance.rs`) demonstrates no caller depends on paths (AC: "at
//! least one test double that is not backed by a filesystem"). Test-only
//! (`#[cfg(test)]` on the module declaration in `mod.rs`, plan §7.1): it is
//! never compiled into the production binary and never part of the public
//! API.

use super::{UploadId, WorkbenchId, WorkbenchStore, validate_upload_file_name};
use crate::errors::{SlidraError, SlidraResult};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

pub(crate) struct MemoryWorkbench {
    id: WorkbenchId,
    deck_files: RefCell<HashMap<String, Vec<u8>>>,
    uploads: RefCell<HashMap<String, (String, Vec<u8>)>>,
    scratch_prepared: RefCell<bool>,
}

impl MemoryWorkbench {
    /// Builds a workbench whose deck starts out holding `files` (virtual
    /// path -> content) — the in-memory equivalent of `LocalWorkbench::open`
    /// against a deck seeded with the same files.
    pub(crate) fn open(files: &[(&str, &[u8])]) -> Self {
        let deck_files = files
            .iter()
            .map(|(path, bytes)| ((*path).to_string(), bytes.to_vec()))
            .collect();
        MemoryWorkbench {
            id: WorkbenchId::generate(),
            deck_files: RefCell::new(deck_files),
            uploads: RefCell::new(HashMap::new()),
            scratch_prepared: RefCell::new(false),
        }
    }
}

impl WorkbenchStore for MemoryWorkbench {
    fn id(&self) -> &WorkbenchId {
        &self.id
    }

    fn read_deck_file(&self, virtual_path: &str) -> SlidraResult<Vec<u8>> {
        self.deck_files
            .borrow()
            .get(virtual_path)
            .cloned()
            .ok_or_else(|| SlidraError::not_found(format!("file not found: {virtual_path}")))
    }

    fn write_deck_file(&self, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
        let mut files = self.deck_files.borrow_mut();
        if !files.contains_key(virtual_path) {
            return Err(SlidraError::not_found(format!(
                "file not found: {virtual_path}"
            )));
        }
        files.insert(virtual_path.to_string(), content.to_vec());
        Ok(())
    }

    fn create_deck_file(&self, virtual_path: &str, content: &[u8]) -> SlidraResult<()> {
        let mut files = self.deck_files.borrow_mut();
        if files.contains_key(virtual_path) {
            return Err(SlidraError::invalid(format!(
                "file already exists: {virtual_path}"
            )));
        }
        files.insert(virtual_path.to_string(), content.to_vec());
        Ok(())
    }

    fn delete_deck_file(&self, virtual_path: &str) -> SlidraResult<()> {
        if self.deck_files.borrow_mut().remove(virtual_path).is_none() {
            return Err(SlidraError::invalid(format!(
                "error deleting file: {virtual_path}"
            )));
        }
        Ok(())
    }

    fn list_deck_entries(&self, virtual_path: &str) -> SlidraResult<Vec<String>> {
        let prefix = if virtual_path.is_empty() {
            String::new()
        } else {
            format!("{virtual_path}/")
        };
        let mut names = BTreeSet::new();
        let mut directory_seen = virtual_path.is_empty();
        for path in self.deck_files.borrow().keys() {
            let Some(remainder) = path.strip_prefix(prefix.as_str()) else {
                continue;
            };
            if remainder.is_empty() {
                continue;
            }
            directory_seen = true;
            let name = remainder
                .split('/')
                .next()
                .expect("split always yields at least one part");
            names.insert(name.to_string());
        }
        if !directory_seen {
            return Err(SlidraError::not_found(format!(
                "directory not found: {virtual_path}"
            )));
        }
        Ok(names.into_iter().collect())
    }

    fn put_upload(&self, file_name: &str, bytes: &[u8]) -> SlidraResult<UploadId> {
        validate_upload_file_name(file_name)?;
        let id = UploadId::generate();
        self.uploads.borrow_mut().insert(
            id.as_str().to_string(),
            (file_name.to_string(), bytes.to_vec()),
        );
        Ok(id)
    }

    fn read_upload(&self, id: &UploadId) -> SlidraResult<Vec<u8>> {
        self.uploads
            .borrow()
            .get(id.as_str())
            .map(|(_, bytes)| bytes.clone())
            .ok_or_else(|| SlidraError::not_found(format!("upload not found: {id}")))
    }

    fn upload_file_name(&self, id: &UploadId) -> SlidraResult<String> {
        self.uploads
            .borrow()
            .get(id.as_str())
            .map(|(name, _)| name.clone())
            .ok_or_else(|| SlidraError::not_found(format!("upload not found: {id}")))
    }

    fn prepare_scratch(&self) -> SlidraResult<()> {
        *self.scratch_prepared.borrow_mut() = true;
        Ok(())
    }

    fn remove_scratch(&self) -> SlidraResult<()> {
        *self.scratch_prepared.borrow_mut() = false;
        Ok(())
    }
}

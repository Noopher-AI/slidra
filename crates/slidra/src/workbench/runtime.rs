// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Process-local ownership of active workbenches.

use super::deck_list;
use super::local::LocalWorkbench;
use super::WorkbenchStore;
use crate::errors::{SlidraError, SlidraResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

struct Entry {
    workbench: LocalWorkbench,
    clipboard: Option<String>,
    command_lock: Arc<Mutex<()>>,
}

#[derive(Default)]
struct Runtime {
    entries: HashMap<String, Entry>,
}

fn state() -> &'static Mutex<Runtime> {
    static STATE: OnceLock<Mutex<Runtime>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Runtime::default()))
}

fn locked() -> std::sync::MutexGuard<'static, Runtime> {
    state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn open(deck_path: &Path) -> SlidraResult<String> {
    let workbench = LocalWorkbench::open(deck_path, b"{}")?;
    let id = workbench.id().as_str().to_string();
    deck_list::record_opened_deck(deck_path)?;
    locked().entries.insert(
        id.clone(),
        Entry {
            workbench,
            clipboard: None,
            command_lock: Arc::new(Mutex::new(())),
        },
    );
    Ok(id)
}

pub(crate) fn resolve_deck_path(id: &str) -> SlidraResult<PathBuf> {
    locked()
        .entries
        .get(id)
        .map(|entry| entry.workbench.deck_path_for_runtime().to_path_buf())
        .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))
}

pub(crate) fn find_by_path(path: &Path) -> Option<String> {
    let wanted = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    locked()
        .entries
        .iter()
        .filter(|(_, entry)| entry.workbench.deck_path_for_runtime() == wanted)
        .map(|(id, _)| id.clone())
        .min()
}

pub(crate) fn rename(id: &str, new_path: &Path) -> SlidraResult<()> {
    let mut runtime = locked();
    let entry = runtime
        .entries
        .get_mut(id)
        .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))?;
    entry.workbench.retarget_deck_for_runtime(new_path);
    deck_list::record_opened_deck(new_path)
}

pub(crate) fn close(id: &str) -> SlidraResult<()> {
    locked()
        .entries
        .remove(id)
        .map(drop)
        .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))
}

pub(crate) fn read_clipboard(id: &str) -> SlidraResult<String> {
    let runtime = locked();
    let entry = runtime
        .entries
        .get(id)
        .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))?;
    entry
        .clipboard
        .clone()
        .ok_or_else(|| SlidraError::invalid("clipboard is empty"))
}

pub(crate) fn write_clipboard(id: &str, contents: &str) -> SlidraResult<()> {
    let mut runtime = locked();
    let entry = runtime
        .entries
        .get_mut(id)
        .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))?;
    entry.clipboard = Some(contents.to_string());
    Ok(())
}

pub(crate) fn with_command_lock<T>(id: &str, body: impl FnOnce() -> T) -> SlidraResult<T> {
    let lock = {
        let runtime = locked();
        runtime
            .entries
            .get(id)
            .map(|entry| entry.command_lock.clone())
            .ok_or_else(|| SlidraError::not_found(format!("no presentation found for id: {id}")))?
    };
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(body())
}

#[cfg(test)]
pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn register_for_test(_home: &Path, id: &str, deck_path: &Path) {
    let mut workbench = LocalWorkbench::open(deck_path, b"{}").unwrap();
    workbench.set_id_for_test(id);
    locked().entries.insert(
        id.to_string(),
        Entry {
            workbench,
            clipboard: None,
            command_lock: Arc::new(Mutex::new(())),
        },
    );
}

#[cfg(test)]
pub(crate) fn clear_for_test() {
    locked().entries.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck(label: &str) -> PathBuf {
        crate::deck::build_test_deck(
            label,
            &[(
                "project.json",
                br#"{"formatVersion":5,"name":"X","canvas":{"width":1,"height":1},"slides":[],"fonts":[]}"#,
            )],
        )
    }

    #[test]
    fn unknown_workbench_is_not_found() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_for_test();
        assert!(matches!(
            resolve_deck_path("missing"),
            Err(SlidraError::NotFound(_))
        ));
    }

    #[test]
    fn open_lookup_and_close_are_one_session_lifecycle() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_for_test();
        let path = deck("runtime-lifecycle");
        let id = open(&path).unwrap();
        assert_eq!(
            resolve_deck_path(&id).unwrap(),
            path.canonicalize().unwrap()
        );
        close(&id).unwrap();
        assert!(resolve_deck_path(&id).is_err());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn opening_one_deck_twice_mints_two_workbench_ids() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_for_test();
        let path = deck("runtime-two-ids");
        assert_ne!(open(&path).unwrap(), open(&path).unwrap());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn clipboard_is_scoped_to_a_workbench_and_removed_on_close() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_for_test();
        let path = deck("runtime-clipboard");
        let id = open(&path).unwrap();
        assert_eq!(
            read_clipboard(&id).unwrap_err().message(),
            "clipboard is empty"
        );
        write_clipboard(&id, "payload").unwrap();
        assert_eq!(read_clipboard(&id).unwrap(), "payload");
        close(&id).unwrap();
        assert!(read_clipboard(&id).is_err());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn rename_updates_the_active_mapping() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_for_test();
        let path = deck("runtime-rename");
        let id = open(&path).unwrap();
        let renamed =
            path.with_file_name(format!("renamed-{}.slidra", crate::id::random_hex_suffix()));
        std::fs::rename(&path, &renamed).unwrap();
        rename(&id, &renamed).unwrap();
        assert_eq!(
            resolve_deck_path(&id).unwrap(),
            renamed.canonicalize().unwrap()
        );
        std::fs::remove_file(renamed).ok();
    }

    #[test]
    fn command_lock_serializes_mutations_for_one_workbench() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_for_test();
        let path = deck("runtime-lock");
        let id = open(&path).unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let first_order = order.clone();
        let first_id = id.clone();
        let first = std::thread::spawn(move || {
            with_command_lock(&first_id, || {
                first_order.lock().unwrap().push(1);
                std::thread::sleep(std::time::Duration::from_millis(30));
                first_order.lock().unwrap().push(2);
            })
            .unwrap();
        });
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second_order = order.clone();
        let second = std::thread::spawn(move || {
            with_command_lock(&id, || second_order.lock().unwrap().push(3)).unwrap();
        });
        first.join().unwrap();
        second.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec![1, 2, 3]);
        std::fs::remove_file(path).ok();
    }
}

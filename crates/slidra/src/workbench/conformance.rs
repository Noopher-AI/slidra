// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Shared `WorkbenchStore` contract, run once against `local::LocalWorkbench`
//! and once against `memory::MemoryWorkbench` — the same four scenarios,
//! same assertions, two backings. A test double that is not backed by a
//! filesystem passing the exact suite the real implementation passes is
//! what demonstrates no caller depends on paths (AC).
//!
//! Each scenario is a private `fn(&dyn WorkbenchStore)` so the assertions
//! are written once; the `local_*`/`memory_*` test pairs below only differ
//! in which store they build.

#[cfg(test)]
mod tests {
    use crate::errors::SlidraError;
    use crate::workbench::local::LocalWorkbench;
    use crate::workbench::memory::MemoryWorkbench;
    use crate::workbench::{UploadId, WorkbenchStore};

    fn deck_file_create_read_and_overwrite_round_trips(store: &dyn WorkbenchStore) {
        store.create_deck_file("notes/new.txt", b"first").unwrap();
        assert_eq!(store.read_deck_file("notes/new.txt").unwrap(), b"first");

        let err = store
            .create_deck_file("notes/new.txt", b"again")
            .unwrap_err();
        assert!(matches!(err, SlidraError::InvalidRequest(_)));

        store.write_deck_file("notes/new.txt", b"second").unwrap();
        assert_eq!(store.read_deck_file("notes/new.txt").unwrap(), b"second");
    }

    fn deck_file_operations_on_missing_path_error_without_returning_empty_bytes(
        store: &dyn WorkbenchStore,
    ) {
        let err = store.read_deck_file("nope.txt").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));

        let err = store.write_deck_file("nope.txt", b"x").unwrap_err();
        assert!(matches!(err, SlidraError::NotFound(_)));
    }

    fn upload_round_trips_and_same_filename_twice_yields_two_ids(store: &dyn WorkbenchStore) {
        let first = store.put_upload("report.pdf", b"one").unwrap();
        let second = store.put_upload("report.pdf", b"two").unwrap();

        assert_ne!(first, second);
        assert_eq!(store.read_upload(&first).unwrap(), b"one");
        assert_eq!(store.read_upload(&second).unwrap(), b"two");
        assert_eq!(store.upload_file_name(&first).unwrap(), "report.pdf");
        assert_eq!(store.upload_file_name(&second).unwrap(), "report.pdf");

        let unknown = UploadId::generate();
        assert!(matches!(
            store.read_upload(&unknown).unwrap_err(),
            SlidraError::NotFound(_)
        ));

        let err = store.put_upload("../escape", b"x").unwrap_err();
        assert!(matches!(err, SlidraError::InvalidRequest(_)));
    }

    fn scratch_prepare_and_remove_are_idempotent(store: &dyn WorkbenchStore) {
        store.prepare_scratch().unwrap();
        store.prepare_scratch().unwrap();
        store.remove_scratch().unwrap();
        store.remove_scratch().unwrap();
    }

    /// A7(b): after running the contract flow through `&dyn WorkbenchStore`,
    /// none of the strings the interface returned contains a fragment of the
    /// real backing directory, nor looks like an absolute path — so a caller
    /// holding only return values cannot derive a real path. A7(a) is a
    /// compile-time property of the trait (no `Path`/`PathBuf` in any return
    /// type) and A7(c) is covered by `local::tests`' id/directory-suffix
    /// guard; this is the runtime half.
    #[test]
    fn local_nothing_returned_through_the_trait_reveals_a_real_path() {
        let _guard = crate::workbench::lock_workbench_tests();
        let deck = crate::deck::build_test_deck("conformance-local-no-path", &[]);
        let store = LocalWorkbench::open(&deck, b"policy").unwrap();
        let root = store.root_for_test().to_path_buf();

        let mut returned = vec![store.id().to_string()];
        store.create_deck_file("notes/new.txt", b"first").unwrap();
        let upload = store.put_upload("report.pdf", b"one").unwrap();
        returned.push(upload.to_string());
        returned.push(store.upload_file_name(&upload).unwrap());
        returned.extend(store.list_deck_entries("").unwrap());
        returned.extend(store.list_deck_entries("notes").unwrap());

        let root_text = root.to_string_lossy().into_owned();
        let root_name = root
            .file_name()
            .expect("the workbench root always has a name")
            .to_string_lossy()
            .into_owned();
        let temp_text = std::env::temp_dir().to_string_lossy().into_owned();
        for value in &returned {
            assert!(
                !value.contains(&root_text) && !value.contains(&root_name),
                "{value:?} reveals the workbench directory"
            );
            assert!(
                !value.contains(&temp_text),
                "{value:?} reveals the temp location"
            );
            assert!(
                !value.starts_with('/'),
                "{value:?} looks like an absolute path"
            );
        }

        drop(store);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn local_deck_file_create_read_and_overwrite_round_trips() {
        let _guard = crate::workbench::lock_workbench_tests();
        let deck = crate::deck::build_test_deck("conformance-local-crud", &[]);
        let store = LocalWorkbench::open(&deck, b"policy").unwrap();
        deck_file_create_read_and_overwrite_round_trips(&store);
        drop(store);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn memory_deck_file_create_read_and_overwrite_round_trips() {
        let store = MemoryWorkbench::open(&[]);
        deck_file_create_read_and_overwrite_round_trips(&store);
    }

    #[test]
    fn local_deck_file_operations_on_missing_path_error_without_returning_empty_bytes() {
        let _guard = crate::workbench::lock_workbench_tests();
        let deck = crate::deck::build_test_deck("conformance-local-missing", &[]);
        let store = LocalWorkbench::open(&deck, b"policy").unwrap();
        deck_file_operations_on_missing_path_error_without_returning_empty_bytes(&store);
        drop(store);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn memory_deck_file_operations_on_missing_path_error_without_returning_empty_bytes() {
        let store = MemoryWorkbench::open(&[]);
        deck_file_operations_on_missing_path_error_without_returning_empty_bytes(&store);
    }

    #[test]
    fn local_upload_round_trips_and_same_filename_twice_yields_two_ids() {
        let _guard = crate::workbench::lock_workbench_tests();
        let deck = crate::deck::build_test_deck("conformance-local-upload", &[]);
        let store = LocalWorkbench::open(&deck, b"policy").unwrap();
        upload_round_trips_and_same_filename_twice_yields_two_ids(&store);
        drop(store);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn memory_upload_round_trips_and_same_filename_twice_yields_two_ids() {
        let store = MemoryWorkbench::open(&[]);
        upload_round_trips_and_same_filename_twice_yields_two_ids(&store);
    }

    #[test]
    fn local_scratch_prepare_and_remove_are_idempotent() {
        let _guard = crate::workbench::lock_workbench_tests();
        let deck = crate::deck::build_test_deck("conformance-local-scratch", &[]);
        let store = LocalWorkbench::open(&deck, b"policy").unwrap();
        scratch_prepare_and_remove_are_idempotent(&store);
        drop(store);
        std::fs::remove_file(&deck).ok();
    }

    #[test]
    fn memory_scratch_prepare_and_remove_are_idempotent() {
        let store = MemoryWorkbench::open(&[]);
        scratch_prepare_and_remove_are_idempotent(&store);
    }
}

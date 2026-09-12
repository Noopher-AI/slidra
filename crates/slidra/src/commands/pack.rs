//! `slidra pack <presentation-id> <path>`.

use crate::errors::SlidraError;
use crate::result::{CommandResult, FailureKind};
use crate::workspace::registry::RegistryEntry;
use crate::{argv, container, workspace};
use std::path::{Path, PathBuf};

pub fn run(args: &[String]) -> CommandResult {
    let id = match argv::require_id_positional(args, 0, "pack", "id") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let path = match argv::require_positional(args, 1, "pack", "path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match pack_presentation(&id, &path) {
        Ok(()) => CommandResult::success("已完成打包", Some(serde_json::json!({}))),
        Err(err) => CommandResult::failure(err.message().to_string(), failure_kind_for(&err)),
    }
}

fn pack_presentation(id: &str, output_path: &str) -> Result<(), SlidraError> {
    let home = workspace::resolve_home();
    let registry = workspace::registry::read_registry(&home)?;
    let Some(entry) = registry.get(id).cloned() else {
        return Err(SlidraError::not_found(format!(
            "找不到識別碼對應的簡報：{id}"
        )));
    };

    container::pack_directory(&entry.work_dir, Path::new(output_path))?;

    let is_same_as_source = entry
        .source_path
        .as_ref()
        .map(|source_path| {
            resolve_lexically(Path::new(output_path)) == resolve_lexically(source_path)
        })
        .unwrap_or(false);
    if is_same_as_source {
        let saved_at = workspace::registry::max_mtime_in_directory(&entry.work_dir)?;
        // Re-read inside the lock rather than reusing the map read above:
        // packing runs between the two, and anything another process
        // registered meanwhile must survive this write.
        workspace::registry::with_registry_lock(&home, || {
            let mut registry = workspace::registry::read_registry(&home)?;
            registry.insert(
                id.to_string(),
                RegistryEntry {
                    saved_at: Some(saved_at),
                    ..entry
                },
            );
            workspace::registry::write_registry(&home, &registry)
        })?;
    }
    Ok(())
}

/// Node's `path.resolve` semantics: absolute + lexically normalized against
/// the current working directory, WITHOUT touching the filesystem (no
/// symlink resolution, no existence requirement) — unlike
/// `Path::canonicalize`, which requires the path to exist. Used only to
/// compare `output_path` against a registry entry's `source_path` the same
/// way `packPresentation`'s `path.resolve(a) === path.resolve(b)` does.
fn resolve_lexically(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn failure_kind_for(err: &SlidraError) -> FailureKind {
    match err {
        SlidraError::NotFound(_) => FailureKind::NotFound,
        SlidraError::InvalidRequest(_) => FailureKind::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-pack-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_arguments_fail() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 pack 缺少參數：id");
    }

    #[test]
    fn unknown_id_is_not_found() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("unknown-id-home");
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let result = run(&["nope".to_string(), "/tmp/out.slidra".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::NotFound)
        );
        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn packing_to_the_same_path_updates_saved_at() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("same-path-home");
        let work = temp_dir("same-path-work");
        std::fs::write(work.join("project.json"), r#"{"formatVersion":1,"name":"X","canvas":{"width":1,"height":1},"slides":[],"fonts":[]}"#).unwrap();
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let output = temp_dir("same-path-output").join("out.slidra");
        let mut registry_map = std::collections::HashMap::new();
        registry_map.insert(
            "id1".to_string(),
            RegistryEntry {
                work_dir: work.clone(),
                source_path: Some(output.clone()),
                saved_at: Some(0.0),
            },
        );
        workspace::registry::write_registry(&home, &registry_map).unwrap();

        let result = run(&["id1".to_string(), output.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);
        assert!(output.exists());

        let updated_registry = workspace::registry::read_registry(&home).unwrap();
        assert!(updated_registry["id1"].saved_at.unwrap() > 0.0);

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn packing_to_a_different_path_leaves_saved_at_untouched() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("diff-path-home");
        let work = temp_dir("diff-path-work");
        std::fs::write(work.join("project.json"), r#"{"formatVersion":1,"name":"X","canvas":{"width":1,"height":1},"slides":[],"fonts":[]}"#).unwrap();
        unsafe {
            std::env::set_var("SLIDRA_HOME", &home);
        }
        let mut registry_map = std::collections::HashMap::new();
        registry_map.insert(
            "id1".to_string(),
            RegistryEntry {
                work_dir: work.clone(),
                source_path: Some(PathBuf::from("/some/other/path.slidra")),
                saved_at: Some(0.0),
            },
        );
        workspace::registry::write_registry(&home, &registry_map).unwrap();

        let output = temp_dir("diff-path-output").join("out.slidra");
        let result = run(&["id1".to_string(), output.to_string_lossy().into_owned()]);
        assert!(result.ok);

        let updated_registry = workspace::registry::read_registry(&home).unwrap();
        assert_eq!(updated_registry["id1"].saved_at, Some(0.0));

        unsafe {
            std::env::remove_var("SLIDRA_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&work).ok();
    }
}

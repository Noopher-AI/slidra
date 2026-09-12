//! `comotion open <path>`.

use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::workspace::registry::RegistryEntry;
use crate::{argv, container, id, workspace};
use std::path::Path;

pub fn run(args: &[String]) -> CommandResult {
    let path = match argv::require_positional(args, 0, "open", "path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match open_presentation(&path) {
        Ok(new_id) => CommandResult::success(
            format!("已開啟簡報，識別碼：{new_id}"),
            Some(serde_json::json!({ "id": new_id })),
        ),
        Err(err) => CommandResult::failure(err.message().to_string(), FailureKind::Failed),
    }
}

fn open_presentation(path: &str) -> Result<String, CoMotionError> {
    let home = workspace::resolve_home();
    let new_id = id::generate_opaque_id();
    let work_dir = workspace::registry::work_dir_for(&home, &new_id);

    container::unpack_container(Path::new(path), &work_dir)?;
    // unpack_container succeeded, so work_dir now holds real content on
    // disk. Every failure from here rolls it back — it must not become an
    // orphan directory nobody can reach.
    let registration = (|| -> Result<(), CoMotionError> {
        let saved_at = workspace::registry::max_mtime_in_directory(&work_dir)?;
        // Read-modify-write under the lock: a concurrent `open` reading the
        // same map and writing after us would drop this brand-new entry.
        workspace::registry::with_registry_lock(&home, || {
            let mut registry = workspace::registry::read_registry(&home)?;
            registry.insert(
                new_id.clone(),
                RegistryEntry {
                    work_dir: work_dir.clone(),
                    source_path: Some(Path::new(path).to_path_buf()),
                    saved_at: Some(saved_at),
                },
            );
            workspace::registry::write_registry(&home, &registry)
        })
    })();

    if let Err(err) = registration {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Err(err);
    }
    Ok(new_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::registry;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "comotion-test-open-{label}-{}",
            id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_path_argument_fails() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 open 缺少參數：path");
    }

    #[test]
    fn nonexistent_file_fails_not_not_found() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("nonexistent-home");
        unsafe {
            std::env::set_var("COMOTION_HOME", &home);
        }
        let result = run(&["/nonexistent/path/x.comot".to_string()]);
        assert!(!result.ok);
        assert_eq!(
            result.failure_kind,
            Some(crate::result::FailureKind::Failed)
        );
        unsafe {
            std::env::remove_var("COMOTION_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn opens_a_comot_and_registers_it_at_formatversion_1() {
        let _guard = registry::ENV_LOCK.lock().unwrap();
        let home = temp_dir("open-success-home");
        unsafe {
            std::env::set_var("COMOTION_HOME", &home);
        }

        let source = temp_dir("open-success-source");
        std::fs::create_dir_all(source.join("slides")).unwrap();
        std::fs::write(
            source.join("slides/001.svg"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>\n",
        )
        .unwrap();
        std::fs::write(
            source.join("project.json"),
            r#"{"formatVersion":1,"name":"T","canvas":{"width":1,"height":1},"slides":["slides/001.svg"]}"#,
        )
        .unwrap();
        let comot_path = temp_dir("open-success-comot").join("in.comot");
        crate::container::pack_directory(&source, &comot_path).unwrap();

        let result = run(&[comot_path.to_string_lossy().into_owned()]);
        assert!(result.ok, "expected success, got {}", result.message);
        let new_id = result.data.as_ref().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let work_dir = workspace::resolve_work_dir(&new_id).unwrap();
        let project: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(work_dir.join("project.json")).unwrap())
                .unwrap();
        assert_eq!(project["formatVersion"], 1);

        unsafe {
            std::env::remove_var("COMOTION_HOME");
        }
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&source).ok();
    }
}

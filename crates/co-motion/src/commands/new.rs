//! `co-motion new <path> [--name <name>]`.

use crate::errors::CoMotionError;
use crate::result::{CommandResult, FailureKind};
use crate::{argv, container, presentation};
use std::path::Path;

pub fn run(args: &[String]) -> CommandResult {
    let path = match argv::require_positional(args, 0, "new", "path") {
        Ok(v) => v,
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };
    let name = match argv::optional_flag(args, "--name") {
        Ok(Some(v)) => v,
        Ok(None) => "新簡報".to_string(),
        Err(msg) => return CommandResult::failure(msg, FailureKind::Failed),
    };

    match create_new_presentation(&path, &name) {
        Ok(()) => {
            CommandResult::success(format!("已建立簡報「{name}」"), Some(serde_json::json!({})))
        }
        Err(err) => CommandResult::failure(err.message().to_string(), FailureKind::Failed),
    }
}

fn create_new_presentation(output_path: &str, name: &str) -> Result<(), CoMotionError> {
    let files = presentation::build_minimal_presentation(name);
    let staging =
        std::env::temp_dir().join(format!("co-motion-new-{}", crate::id::random_hex_suffix()));
    std::fs::create_dir_all(&staging)
        .map_err(|_| CoMotionError::invalid(format!("無法寫入簡報檔案：{output_path}")))?;

    let write_result = (|| -> Result<(), CoMotionError> {
        for (relative_path, content) in &files {
            let dest = staging.join(relative_path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|_| {
                    CoMotionError::invalid(format!("無法寫入簡報檔案：{output_path}"))
                })?;
            }
            std::fs::write(&dest, content)
                .map_err(|_| CoMotionError::invalid(format!("無法寫入簡報檔案：{output_path}")))?;
        }
        std::fs::create_dir_all(staging.join("assets"))
            .map_err(|_| CoMotionError::invalid(format!("無法寫入簡報檔案：{output_path}")))?;
        std::fs::create_dir_all(staging.join("fonts"))
            .map_err(|_| CoMotionError::invalid(format!("無法寫入簡報檔案：{output_path}")))?;
        std::fs::create_dir_all(staging.join("slides"))
            .map_err(|_| CoMotionError::invalid(format!("無法寫入簡報檔案：{output_path}")))?;
        container::pack_directory(&staging, Path::new(output_path))
    })();

    let _ = std::fs::remove_dir_all(&staging);
    write_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_path_argument_fails() {
        let result = run(&[]);
        assert!(!result.ok);
        assert_eq!(result.message, "命令 new 缺少參數：path");
    }

    #[test]
    fn name_flag_missing_value_fails() {
        let result = run(&["/tmp/x.comot".to_string(), "--name".to_string()]);
        assert!(!result.ok);
        assert_eq!(result.message, "--name 缺少值");
    }

    #[test]
    fn creates_a_comot_file_with_default_name() {
        let path = std::env::temp_dir().join(format!(
            "co-motion-test-new-{}.comot",
            crate::id::random_hex_suffix()
        ));
        let result = run(&[path.to_string_lossy().into_owned()]);
        assert!(result.ok);
        assert_eq!(result.message, "已建立簡報「新簡報」");
        assert!(path.exists());
        std::fs::remove_file(&path).ok();
    }
}

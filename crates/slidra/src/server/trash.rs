// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

//! Moves a deck file to the OS trash instead of unlinking it — in-process
//! port of `packages/server/src/storage/trash.ts` ([S11.F9], #404 "Deck
//! lifecycle" AC4: a delete must be restorable by the operating system's
//! own means). No new dependency: Linux goes straight through the XDG home
//! trash spec (a `.trashinfo` sidecar plus a `rename` into `files/`);
//! macOS asks Finder to do it via `osascript`, the one way "Put Back"
//! keeps working. Every other platform is an explicit, unsupported error —
//! this crate's server targets macOS and Linux only, same as the TS
//! original.
//!
//! This file is the one deliberate, named exception to `tests/server_door
//! .rs`'s `server_and_cli_never_spawn_a_process` AC1 guard (see that
//! test's own doc comment): `osascript` is OS integration triggered by
//! `deck_store::remove_deck`, not a deck call dispatched through `/call`'s
//! argv executor, and no in-process API exists for "the same move
//! Finder's own Trash does" under this workspace's no-new-dependency
//! constraint.

use crate::errors::{SlidraError, SlidraResult};
use std::path::{Path, PathBuf};

pub fn move_to_trash(file_path: &Path) -> SlidraResult<()> {
    if cfg!(target_os = "linux") {
        move_to_xdg_trash(file_path)
    } else if cfg!(target_os = "macos") {
        move_to_finder_trash(file_path)
    } else {
        Err(SlidraError::invalid(format!(
            "moving a file to the trash is not supported on this platform: {}",
            std::env::consts::OS
        )))
    }
}

fn xdg_trash_home() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(value) if !value.is_empty() => PathBuf::from(value).join("Trash"),
        _ => crate::workspace::home_dir()
            .join(".local")
            .join("share")
            .join("Trash"),
    }
}

/// `YYYY-MM-DDThh:mm:ss` — the XDG Trash spec's `.trashinfo` `DeletionDate`
/// key format. No `chrono`/`time` crate in this workspace's dependency
/// budget, so this reads the wall clock via `SystemTime` and does the
/// civil-calendar math by hand. Deliberately UTC, not local time like the
/// TS original's `Date` methods: resolving the OS's configured local
/// timezone without a calendar crate needs `libc` FFI this workspace does
/// not depend on (the same "no `libc` crate in this workspace's dependency
/// budget" gap `workspace::home_dir`'s doc comment already flags for
/// `getpwuid`). `DeletionDate` is advisory metadata a file manager
/// displays and this codebase never reads back, so the gap only means a
/// trashed-file's displayed deletion time may read a few hours off from
/// wall-clock local time — never affects which file gets trashed, found,
/// or restored.
fn trash_info_deletion_date() -> String {
    let now = std::time::SystemTime::now();
    let unix_secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day, hour, minute, second) = civil_from_unix_seconds(unix_secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
}

/// Civil calendar (year, month, day, hour, minute, second) from a Unix
/// timestamp, proleptic Gregorian — Howard Hinnant's `civil_from_days`
/// algorithm, the same closed-form date math used elsewhere in this
/// codebase's dependency-free date handling.
fn civil_from_unix_seconds(total_seconds: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = total_seconds.div_euclid(86400);
    let time_of_day = total_seconds.rem_euclid(86400);
    let hour = (time_of_day / 3600) as u32;
    let minute = ((time_of_day % 3600) / 60) as u32;
    let second = (time_of_day % 60) as u32;

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { y + 1 } else { y };
    (year, month, day, hour, minute, second)
}

/// Claims a not-yet-used `<name>.trashinfo` in `info_dir` — `<base>`, then
/// `<base>-1`, `<base>-2`, … (extension preserved) — via exclusive-create,
/// so two concurrent trashes of same-named files never collide. Returns
/// the claimed name and the still-open file handle (the caller writes the
/// `.trashinfo` body through it before closing).
fn claim_trash_info_name(
    info_dir: &Path,
    base_name: &str,
) -> SlidraResult<(String, std::fs::File)> {
    let (stem, ext) = match base_name.rfind('.') {
        Some(idx) if idx > 0 => (&base_name[..idx], &base_name[idx..]),
        _ => (base_name, ""),
    };
    let mut suffix = 0u64;
    loop {
        let name = if suffix == 0 {
            base_name.to_string()
        } else {
            format!("{stem}-{suffix}{ext}")
        };
        let info_path = info_dir.join(format!("{name}.trashinfo"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&info_path)
        {
            Ok(handle) => return Ok((name, handle)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                suffix += 1;
                continue;
            }
            Err(_) => {
                return Err(SlidraError::invalid(format!(
                    "failed to claim a trash info entry: {}",
                    info_path.display()
                )));
            }
        }
    }
}

fn move_to_xdg_trash(file_path: &Path) -> SlidraResult<()> {
    use std::io::Write;

    let trash_home = xdg_trash_home();
    let files_dir = trash_home.join("files");
    let info_dir = trash_home.join("info");
    std::fs::create_dir_all(&files_dir).map_err(|_| {
        SlidraError::invalid(format!(
            "failed to create trash directory: {}",
            files_dir.display()
        ))
    })?;
    std::fs::create_dir_all(&info_dir).map_err(|_| {
        SlidraError::invalid(format!(
            "failed to create trash directory: {}",
            info_dir.display()
        ))
    })?;

    let base_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (name, mut handle) = claim_trash_info_name(&info_dir, &base_name)?;
    let info_path = info_dir.join(format!("{name}.trashinfo"));

    let absolute = std::path::absolute(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let content = format!(
        "[Trash Info]\nPath={}\nDeletionDate={}\n",
        percent_encode_path(&absolute.to_string_lossy()),
        trash_info_deletion_date()
    );
    let write_result = handle.write_all(content.as_bytes());
    drop(handle);
    if write_result.is_err() {
        let _ = std::fs::remove_file(&info_path);
        return Err(SlidraError::invalid(format!(
            "failed to write trash info entry: {}",
            info_path.display()
        )));
    }

    if let Err(err) = std::fs::rename(file_path, files_dir.join(&name)) {
        let _ = std::fs::remove_file(&info_path);
        if err.kind() == std::io::ErrorKind::CrossesDevices {
            return Err(SlidraError::invalid(format!(
                "cannot move to trash across filesystems: {}",
                file_path.display()
            )));
        }
        return Err(SlidraError::invalid(format!(
            "failed to move to trash: {}",
            file_path.display()
        )));
    }
    Ok(())
}

/// Percent-encodes exactly what `encodeURI` (the TS original's own
/// encoder) leaves untouched-vs-escaped for a POSIX path: everything except
/// the small "never escaped" set (`A-Za-z0-9`, `- _ . ! ~ * ' ( )`, plus
/// `encodeURI`'s own additional reserved-but-unescaped `; , / ? : @ & = + $ #`).
/// The `.trashinfo` `Path=` value only needs to be a valid URI reference
/// per the XDG Trash spec, and this set is exactly what makes a POSIX path
/// (mostly `/`-separated printable characters) round-trip unescaped except
/// for genuinely unsafe bytes (spaces, `%`, non-ASCII).
fn percent_encode_path(input: &str) -> String {
    const UNRESERVED: &str = "-_.!~*'()";
    const URI_RESERVED: &str = ";,/?:@&=+$#";
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || UNRESERVED.contains(c) || URI_RESERVED.contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `Application("Finder").delete()`'s AppleScript equivalent — this is what
/// makes Finder's "Put Back" work, unlike a bare `unlink` or a manual move
/// into `~/.Trash`.
fn move_to_finder_trash(file_path: &Path) -> SlidraResult<()> {
    let absolute = std::path::absolute(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let script = format!(
        "tell application \"Finder\" to delete POSIX file {:?}",
        absolute.to_string_lossy()
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => Err(SlidraError::invalid(format!(
            "failed to move to trash: {}",
            file_path.display()
        ))),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::workspace::registry::ENV_LOCK;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slidra-test-trash-{label}-{}",
            crate::id::random_hex_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_a_file_into_the_xdg_trash_and_writes_a_sidecar() {
        let _guard = ENV_LOCK.lock().unwrap();
        let data_home = temp_dir("xdg-data-home");
        let source_dir = temp_dir("xdg-source");
        let source = source_dir.join("deck.slidra");
        std::fs::write(&source, b"content").unwrap();

        unsafe {
            std::env::set_var("XDG_DATA_HOME", &data_home);
        }
        let result = move_to_trash(&source);
        unsafe {
            std::env::remove_var("XDG_DATA_HOME");
        }

        assert!(result.is_ok(), "expected success, got {result:?}");
        assert!(
            !source.exists(),
            "source must be gone from its original location"
        );
        let moved = data_home.join("Trash").join("files").join("deck.slidra");
        assert!(moved.exists(), "moved file must exist under files/");
        assert_eq!(std::fs::read(&moved).unwrap(), b"content");
        let info = data_home
            .join("Trash")
            .join("info")
            .join("deck.slidra.trashinfo");
        let info_content = std::fs::read_to_string(&info).unwrap();
        assert!(info_content.starts_with("[Trash Info]\n"));
        assert!(info_content.contains("DeletionDate="));

        std::fs::remove_dir_all(&data_home).ok();
        std::fs::remove_dir_all(&source_dir).ok();
    }

    #[test]
    fn a_name_collision_claims_a_numbered_trashinfo_entry_instead_of_overwriting() {
        let _guard = ENV_LOCK.lock().unwrap();
        let data_home = temp_dir("xdg-data-home-collide");
        let source_dir = temp_dir("xdg-source-collide");
        let first = source_dir.join("deck.slidra");
        let second_dir = temp_dir("xdg-source-collide-2");
        let second = second_dir.join("deck.slidra");
        std::fs::write(&first, b"first").unwrap();
        std::fs::write(&second, b"second").unwrap();

        unsafe {
            std::env::set_var("XDG_DATA_HOME", &data_home);
        }
        move_to_trash(&first).unwrap();
        move_to_trash(&second).unwrap();
        unsafe {
            std::env::remove_var("XDG_DATA_HOME");
        }

        let files_dir = data_home.join("Trash").join("files");
        assert!(files_dir.join("deck.slidra").exists());
        assert!(files_dir.join("deck-1.slidra").exists());
        assert_eq!(
            std::fs::read(files_dir.join("deck.slidra")).unwrap(),
            b"first"
        );
        assert_eq!(
            std::fs::read(files_dir.join("deck-1.slidra")).unwrap(),
            b"second"
        );

        std::fs::remove_dir_all(&data_home).ok();
        std::fs::remove_dir_all(&source_dir).ok();
        std::fs::remove_dir_all(&second_dir).ok();
    }

    #[test]
    fn defaults_to_local_share_trash_when_xdg_data_home_is_unset() {
        let home = xdg_trash_home();
        assert!(home.ends_with(".local/share/Trash"));
    }

    #[test]
    fn civil_date_matches_a_known_reference_point() {
        // 2024-01-15T10:30:00Z, a value hand-verified against `date -u -d @1705314600`.
        assert_eq!(
            civil_from_unix_seconds(1705314600),
            (2024, 1, 15, 10, 30, 0)
        );
    }
}

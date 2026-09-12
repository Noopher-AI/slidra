//! Shared error type for the Rust engine. The two variants here exist
//! purely so that `undo`/`redo` can map "no such presentation" to
//! `FailureKind::NotFound` (see result.rs) without string-matching the
//! message.

use std::fmt;

#[derive(Debug)]
pub enum CoMotionError {
    /// "找不到識別碼對應的簡報" and similar — maps to CommandResult's
    /// `FailureKind::NotFound`.
    NotFound(String),
    /// Everything else: malformed history, malformed project.json, bad
    /// argv, I/O failures that aren't "missing entity".
    InvalidRequest(String),
}

impl CoMotionError {
    pub fn not_found(message: impl Into<String>) -> Self {
        CoMotionError::NotFound(message.into())
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        CoMotionError::InvalidRequest(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            CoMotionError::NotFound(m) => m,
            CoMotionError::InvalidRequest(m) => m,
        }
    }
}

impl fmt::Display for CoMotionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CoMotionError {}

pub type CoMotionResult<T> = Result<T, CoMotionError>;

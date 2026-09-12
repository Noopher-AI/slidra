//! Shared error type for the Rust engine. TS distinguishes error kinds only
//! by message text (`SlidraError` in `packages/core/src/errors.ts` is a
//! plain `Error` subclass); the two variants here exist purely so that
//! `undo`/`redo` can map "no such presentation" to `FailureKind::NotFound`
//! (see result.rs) without string-matching the message.

use std::fmt;

#[derive(Debug)]
pub enum SlidraError {
    /// "找不到識別碼對應的簡報" and similar — maps to CommandResult's
    /// `FailureKind::NotFound`.
    NotFound(String),
    /// Everything else: malformed history, malformed project.json, bad
    /// argv, I/O failures that aren't "missing entity".
    InvalidRequest(String),
}

impl SlidraError {
    pub fn not_found(message: impl Into<String>) -> Self {
        SlidraError::NotFound(message.into())
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        SlidraError::InvalidRequest(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            SlidraError::NotFound(m) => m,
            SlidraError::InvalidRequest(m) => m,
        }
    }
}

impl fmt::Display for SlidraError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for SlidraError {}

pub type SlidraResult<T> = Result<T, SlidraError>;

//! Unified error type for all Tauri commands.
//!
//! `AppError` is `Serialize` so it can cross the IPC boundary. Sensitive
//! details (passwords, keys) must never be embedded in error messages —
//! see `ssh::client::redact` for the scrubbing utility.

use serde::{Serialize, Serializer};

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("vault is locked")]
    VaultLocked,

    #[error("vault not initialized — set a master password first")]
    VaultNotInitialized,

    #[error("invalid master password")]
    InvalidMasterPassword,

    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("terminal not found: {0}")]
    TerminalNotFound(String),

    #[error("server not found: {0}")]
    ServerNotFound(String),

    #[error("project not found: {0}")]
    ProjectNotFound(String),

    #[error("host key mismatch — expected {expected}, got {actual}")]
    HostKeyMismatch { expected: String, actual: String },

    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("sftp error: {0}")]
    Sftp(String),

    #[error("crypto error: {0}")]
    Crypto(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("rsync failed (exit {code}): {message}")]
    RsyncFailed { code: i32, message: String },

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("another command is running on this session: {0}")]
    CommandInFlight(String),

    #[error("feature unavailable: {0}")]
    FeatureUnavailable(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// --- Convenience conversions ---

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(format!("json: {e}"))
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

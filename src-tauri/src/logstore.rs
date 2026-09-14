//! Plaintext JSONL stores for terminal history + MCP activity, kept as
//! files next to `vault.enc` so the user can read/manage them directly.
//! (Deliberately unencrypted — the user opted out of securing these.)
//!
//! Each file is JSON-Lines: one JSON object per line. Files are small
//! (history capped per server, activity capped globally) so we just read
//! the whole file and rewrite it on change.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::models::{McpActivityEntry, TerminalHistoryEntry};

pub const HISTORY_FILE: &str = "terminal-history.jsonl";
pub const ACTIVITY_FILE: &str = "mcp-activity.jsonl";

/// Directory that holds the log files — the same folder as `vault.enc`.
fn log_dir(app: &AppHandle) -> PathBuf {
    crate::settings::resolve_vault_path(app)
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn history_path(app: &AppHandle) -> PathBuf {
    log_dir(app).join(HISTORY_FILE)
}

pub fn activity_path(app: &AppHandle) -> PathBuf {
    log_dir(app).join(ACTIVITY_FILE)
}

fn read_lines<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Vec<T> {
    match std::fs::read_to_string(path) {
        Ok(s) => s
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<T>(l).ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn write_lines<T: serde::Serialize>(path: &PathBuf, items: &[T]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = String::new();
    for it in items {
        out.push_str(&serde_json::to_string(it).unwrap_or_default());
        out.push('\n');
    }
    std::fs::write(path, out)
}

// --- terminal history ---

pub fn read_history(app: &AppHandle) -> Vec<TerminalHistoryEntry> {
    read_lines(&history_path(app))
}

pub fn write_history(app: &AppHandle, items: &[TerminalHistoryEntry]) -> std::io::Result<()> {
    write_lines(&history_path(app), items)
}

// --- MCP activity ---

pub fn read_activity(app: &AppHandle) -> Vec<McpActivityEntry> {
    read_lines(&activity_path(app))
}

pub fn write_activity(app: &AppHandle, items: &[McpActivityEntry]) -> std::io::Result<()> {
    write_lines(&activity_path(app), items)
}

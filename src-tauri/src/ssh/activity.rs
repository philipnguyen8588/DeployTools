//! Generic "activity log" events emitted to the frontend.
//!
//! The frontend subscribes to `activity://session/{id}` for per-tab logs
//! and `activity://all` for the global firehose. Each line carries a
//! `source` (sftp / rsync / docker / …) and an optional `tag` for
//! sub-filtering (e.g. which service the log line belongs to).

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Success,
    Warn,
    Error,
}

#[derive(Serialize, Clone)]
pub struct ActivityLine {
    pub time_ms: u128,
    pub level: Level,
    pub source: String,
    pub message: String,
    pub session_id: Option<String>,
    /// Free-form sub-identifier (e.g. docker service name, snippet id).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Emit a single activity line. Call this for one-off log messages
/// (SFTP done, session opened, etc.).
pub fn emit(
    app: &AppHandle,
    level: Level,
    source: &str,
    message: impl Into<String>,
    session_id: Option<&str>,
    tag: Option<&str>,
) {
    let line = ActivityLine {
        time_ms: now_ms(),
        level,
        source: source.to_string(),
        message: message.into(),
        session_id: session_id.map(|s| s.to_string()),
        tag: tag.map(|s| s.to_string()),
    };
    let _ = app.emit("activity://all", line.clone());
    if let Some(sid) = session_id {
        let _ = app.emit(&format!("activity://session/{sid}"), line);
    }
}

/// Emit many lines as a single IPC event. Used by log-follow streams
/// that can produce hundreds of lines per second — React re-renders
/// cheaply when we hand it a batch instead of N individual events.
pub fn emit_batch(
    app: &AppHandle,
    source: &str,
    tag: Option<&str>,
    lines: &[(Level, String)],
    session_id: Option<&str>,
) {
    if lines.is_empty() {
        return;
    }
    let t = now_ms();
    let batch: Vec<ActivityLine> = lines
        .iter()
        .map(|(level, message)| ActivityLine {
            time_ms: t,
            level: *level,
            source: source.to_string(),
            message: message.clone(),
            session_id: session_id.map(|s| s.to_string()),
            tag: tag.map(|s| s.to_string()),
        })
        .collect();
    let _ = app.emit("activity://all-batch", batch.clone());
    if let Some(sid) = session_id {
        let _ = app.emit(&format!("activity://session/{sid}/batch"), batch);
    }
}

pub fn info(app: &AppHandle, source: &str, msg: impl Into<String>, session_id: Option<&str>) {
    emit(app, Level::Info, source, msg, session_id, None);
}

pub fn success(app: &AppHandle, source: &str, msg: impl Into<String>, session_id: Option<&str>) {
    emit(app, Level::Success, source, msg, session_id, None);
}

pub fn warn(app: &AppHandle, source: &str, msg: impl Into<String>, session_id: Option<&str>) {
    emit(app, Level::Warn, source, msg, session_id, None);
}

pub fn error(app: &AppHandle, source: &str, msg: impl Into<String>, session_id: Option<&str>) {
    emit(app, Level::Error, source, msg, session_id, None);
}

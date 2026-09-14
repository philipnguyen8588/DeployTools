//! Terminal command history — per-server log of every command run in the
//! integrated terminal (by the user) or via the MCP `run_command` tool (by
//! an AI agent). Stored as a plaintext JSONL file next to `vault.enc`
//! (`terminal-history.jsonl`) so it can be managed outside the app.

use std::collections::HashMap;

use tauri::State;
use uuid::Uuid;

use crate::errors::AppResult;
use crate::logstore;
use crate::models::{HistorySource, TerminalHistoryEntry};
use crate::state::AppState;

/// Hard cap per server. When exceeded, the oldest entries are dropped.
pub const HISTORY_CAP: usize = 500;

/// Most recent N entries for a server, newest first.
#[tauri::command]
pub async fn history_list(
    server_id: Uuid,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> AppResult<Vec<TerminalHistoryEntry>> {
    let lim = limit.unwrap_or(HISTORY_CAP);
    let mut list: Vec<TerminalHistoryEntry> = logstore::read_history(&state.app)
        .into_iter()
        .filter(|e| e.server_id == server_id)
        .collect();
    list.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
    list.truncate(lim);
    Ok(list)
}

/// Append a command (user by default). Duplicates collapse when they match
/// the most-recent entry for the same server + source.
#[tauri::command]
pub async fn history_add(
    server_id: Uuid,
    command: String,
    source: Option<HistorySource>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    add(state.inner(), server_id, command, source.unwrap_or_default()).await
}

/// Backend helper — used by the `history_add` command (user commands) and
/// the MCP layer (agent `run_command`, tagged `Mcp`).
pub async fn add(
    state: &AppState,
    server_id: Uuid,
    command: String,
    source: HistorySource,
) -> AppResult<()> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let app = state.app.clone();
    let mut items = logstore::read_history(&app);

    // Collapse repeats: if the most recent entry for this server matches
    // (same command AND source), just bump its timestamp.
    if let Some(last) = items.iter_mut().rev().find(|e| e.server_id == server_id) {
        if last.command == trimmed && last.source == source {
            last.time_ms = now;
            let _ = logstore::write_history(&app, &items);
            return Ok(());
        }
    }

    items.push(TerminalHistoryEntry {
        id: Uuid::new_v4(),
        server_id,
        command: trimmed,
        time_ms: now,
        source,
    });
    enforce_cap(&mut items);
    let _ = logstore::write_history(&app, &items);
    Ok(())
}

/// Keep only the newest `HISTORY_CAP` entries per server.
fn enforce_cap(items: &mut Vec<TerminalHistoryEntry>) {
    items.sort_by(|a, b| a.time_ms.cmp(&b.time_ms)); // oldest first
    let mut total: HashMap<Uuid, usize> = HashMap::new();
    for e in items.iter() {
        *total.entry(e.server_id).or_default() += 1;
    }
    let mut seen: HashMap<Uuid, usize> = HashMap::new();
    items.retain(|e| {
        let t = total[&e.server_id];
        let idx = seen.entry(e.server_id).or_default();
        let keep = t - *idx <= HISTORY_CAP;
        *idx += 1;
        keep
    });
}

/// Clear all history for a server.
#[tauri::command]
pub async fn history_clear(server_id: Uuid, state: State<'_, AppState>) -> AppResult<()> {
    let mut items = logstore::read_history(&state.app);
    items.retain(|e| e.server_id != server_id);
    let _ = logstore::write_history(&state.app, &items);
    Ok(())
}

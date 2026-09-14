//! Terminal command history — per-server log of every command the
//! user pressed Enter on inside the integrated terminal. Stored in
//! the encrypted vault so it's only readable while the vault is
//! unlocked.

use tauri::State;
use uuid::Uuid;

use crate::errors::AppResult;
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
    let mut list: Vec<_> = state
        .vault
        .read(|d| {
            d.terminal_history
                .iter()
                .filter(|e| e.server_id == server_id)
                .cloned()
                .collect::<Vec<_>>()
        })
        .await?;
    list.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
    list.truncate(lim);
    Ok(list)
}

/// Append a command. Duplicates are collapsed when they match the
/// most-recent entry for the same server — keeps the list tidy when
/// the user retypes the same line.
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
/// by the MCP layer (agent `run_command`, tagged `Mcp`).
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
    state
        .vault
        .write(|d| {
            // Collapse repeats: if the most recent entry for this server
            // matches (same command AND source), just bump its timestamp.
            if let Some(last) = d
                .terminal_history
                .iter_mut()
                .rev()
                .find(|e| e.server_id == server_id)
            {
                if last.command == trimmed && last.source == source {
                    last.time_ms = now;
                    return;
                }
            }
            d.terminal_history.push(TerminalHistoryEntry {
                id: Uuid::new_v4(),
                server_id,
                command: trimmed,
                time_ms: now,
                source,
            });
            // Enforce per-server cap.
            let mut count = 0usize;
            let mut keep = vec![true; d.terminal_history.len()];
            // Walk from newest to oldest; drop beyond HISTORY_CAP.
            let mut indices: Vec<_> = d
                .terminal_history
                .iter()
                .enumerate()
                .filter(|(_, e)| e.server_id == server_id)
                .map(|(i, _)| i)
                .collect();
            indices.sort_by(|a, b| d.terminal_history[*b].time_ms.cmp(&d.terminal_history[*a].time_ms));
            for idx in indices {
                if count >= HISTORY_CAP {
                    keep[idx] = false;
                }
                count += 1;
            }
            let mut i = 0;
            d.terminal_history.retain(|_| {
                let k = keep[i];
                i += 1;
                k
            });
        })
        .await
}

/// Clear all history for a server.
#[tauri::command]
pub async fn history_clear(
    server_id: Uuid,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .vault
        .write(|d| {
            d.terminal_history.retain(|e| e.server_id != server_id);
        })
        .await
}

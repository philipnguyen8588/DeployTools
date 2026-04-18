//! Terminal IPC — open / write / resize / close.

use tauri::State;

use crate::errors::AppResult;
use crate::ssh::terminal;
use crate::state::AppState;

#[tauri::command]
pub async fn term_open(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let session = state.sessions.get(&session_id)?;
    terminal::open(session, cols, rows).await
}

#[tauri::command]
pub async fn term_write(
    session_id: String,
    terminal_id: String,
    data: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    terminal::write(&session, &terminal_id, data.into_bytes())
}

#[tauri::command]
pub async fn term_resize(
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    terminal::resize(&session, &terminal_id, cols, rows)
}

#[tauri::command]
pub async fn term_close(
    session_id: String,
    terminal_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    terminal::close(&session, &terminal_id)
}

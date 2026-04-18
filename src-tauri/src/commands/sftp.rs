//! SFTP IPC commands for the remote file browser.

use std::path::PathBuf;

use tauri::State;

use crate::errors::AppResult;
use crate::ssh::sftp::{self, RemoteEntry};
use crate::state::AppState;

#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteEntry>> {
    sftp::validate_remote_path(&path)?;
    let session = state.sessions.get(&session_id)?;
    sftp::list(&session, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&path)?;
    let session = state.sessions.get(&session_id)?;
    sftp::mkdir(&session, &path).await
}

#[tauri::command]
pub async fn sftp_rm(
    session_id: String,
    path: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&path)?;
    let session = state.sessions.get(&session_id)?;
    sftp::remove(&session, &path, recursive).await
}

#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&from)?;
    sftp::validate_remote_path(&to)?;
    let session = state.sessions.get(&session_id)?;
    sftp::rename(&session, &from, &to).await
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: PathBuf,
    remote_path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&remote_path)?;
    let session = state.sessions.get(&session_id)?;
    sftp::upload(&session, &local_path, &remote_path).await
}

#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: PathBuf,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&remote_path)?;
    let session = state.sessions.get(&session_id)?;
    sftp::download(&session, &remote_path, &local_path).await
}

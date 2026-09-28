//! File-browser commands. Named `sftp_*` for historical reasons — each
//! one dispatches to either the SSH/SFTP or the FTP implementation
//! based on which pool the session id lives in.

use std::path::PathBuf;

use tauri::State;

use crate::errors::{AppError, AppResult};
use crate::ssh::sftp::{self, RemoteEntry};
use crate::state::AppState;

enum Pool {
    Ssh(std::sync::Arc<crate::ssh::session_pool::SshSession>),
    Ftp(std::sync::Arc<crate::ftp::FtpSession>),
}

fn pick(state: &AppState, session_id: &str) -> AppResult<Pool> {
    if let Ok(s) = state.sessions.get(session_id) {
        return Ok(Pool::Ssh(s));
    }
    if let Some(s) = state.ftp_sessions.get(session_id) {
        return Ok(Pool::Ftp(s.clone()));
    }
    Err(AppError::SessionNotFound(session_id.to_string()))
}

#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteEntry>> {
    sftp::validate_remote_path(&path)?;
    match pick(&state, &session_id)? {
        Pool::Ssh(session) => sftp::list(&session, &path).await,
        Pool::Ftp(session) => {
            let entries = crate::ftp::list(&session, &path).await?;
            // map the FTP variant into the SFTP-shaped wire type
            Ok(entries
                .into_iter()
                .map(|e| RemoteEntry {
                    name: e.name,
                    full_path: e.full_path,
                    is_dir: e.is_dir,
                    is_symlink: e.is_symlink,
                    size: e.size,
                    mtime: e.mtime,
                    mode: e.mode,
                })
                .collect())
        }
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&path)?;
    match pick(&state, &session_id)? {
        Pool::Ssh(session) => sftp::mkdir(&session, &path).await,
        Pool::Ftp(session) => crate::ftp::mkdir(&session, &path).await,
    }
}

#[tauri::command]
pub async fn sftp_rm(
    session_id: String,
    path: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&path)?;
    match pick(&state, &session_id)? {
        Pool::Ssh(session) => sftp::remove(&session, &path, recursive).await,
        Pool::Ftp(session) => crate::ftp::remove(&session, &path, recursive).await,
    }
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
    match pick(&state, &session_id)? {
        Pool::Ssh(session) => sftp::rename(&session, &from, &to).await,
        Pool::Ftp(session) => crate::ftp::rename(&session, &from, &to).await,
    }
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: PathBuf,
    remote_path: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&remote_path)?;
    match pick(&state, &session_id)? {
        Pool::Ssh(session) => sftp::upload(&session, &local_path, &remote_path).await,
        Pool::Ftp(session) => {
            crate::ftp::upload(
                &session,
                &state.app,
                &session_id,
                &local_path,
                &remote_path,
            )
            .await
        }
    }
}

/// Read a remote file into memory for the read-only preview dialog.
/// Dispatches to SFTP or FTP; 1 MiB cap + binary sniff happen in
/// `preview_util` so the behavior matches the local preview exactly.
#[tauri::command]
pub async fn sftp_read_text(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> AppResult<super::preview_util::TextFileContent> {
    use super::preview_util;

    sftp::validate_remote_path(&path)?;
    let read = match pick(&state, &session_id)? {
        Pool::Ssh(session) => {
            sftp::read_capped(&session, &path, preview_util::MAX_TEXT_BYTES).await
        }
        Pool::Ftp(session) => {
            crate::ftp::read_capped(&session, &path, preview_util::MAX_TEXT_BYTES).await
        }
    };
    match read {
        Ok(r) => {
            crate::ssh::activity::info(
                &state.app,
                "preview",
                format!("preview {path}"),
                Some(&session_id),
            );
            Ok(preview_util::classify(r))
        }
        Err(e) => {
            crate::ssh::activity::warn(
                &state.app,
                "preview",
                format!("preview failed for {path}: {e}"),
                Some(&session_id),
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: PathBuf,
    state: State<'_, AppState>,
) -> AppResult<()> {
    sftp::validate_remote_path(&remote_path)?;
    match pick(&state, &session_id)? {
        Pool::Ssh(session) => sftp::download(&session, &remote_path, &local_path).await,
        Pool::Ftp(session) => {
            crate::ftp::download(
                &session,
                &state.app,
                &session_id,
                &remote_path,
                &local_path,
            )
            .await
        }
    }
}

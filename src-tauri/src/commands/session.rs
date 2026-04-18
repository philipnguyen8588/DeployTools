//! Open / close / list SSH sessions (one per UI tab).

use std::sync::Arc;
use std::time::SystemTime;

use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::{Project, Server};
use crate::ssh::client;
use crate::ssh::session_pool::{SessionSummary, SshSession};
use crate::state::AppState;

/// Open a new SSH session. Exactly one of `server_id` must be given;
/// `project_id` is optional and used to auto-`cd` terminals.
#[tauri::command]
pub async fn open_session(
    server_id: Uuid,
    project_id: Option<Uuid>,
    state: State<'_, AppState>,
) -> AppResult<SessionSummary> {
    // Look up server + optional project from vault.
    let (server, project): (Option<Server>, Option<Project>) = state
        .vault
        .read(|d| {
            let s = d.servers.iter().find(|s| s.id == server_id).cloned();
            let p = project_id
                .and_then(|pid| d.projects.iter().find(|p| p.id == pid).cloned());
            (s, p)
        })
        .await?;
    let server = server.ok_or_else(|| AppError::ServerNotFound(server_id.to_string()))?;

    let ssh = client::connect(&server).await?;
    let fp = ssh.fingerprint.clone();

    // Pin fingerprint on first connect.
    if server.host_key_fingerprint.is_none() {
        state
            .vault
            .write(|data| {
                if let Some(s) = data.servers.iter_mut().find(|s| s.id == server_id) {
                    s.host_key_fingerprint = Some(fp.clone());
                }
            })
            .await?;
    }

    let id = Uuid::new_v4().to_string();
    let session = Arc::new(SshSession {
        id: id.clone(),
        server_id,
        project,
        handle: Arc::new(Mutex::new(ssh.handle)),
        fingerprint: fp,
        terminals: dashmap::DashMap::new(),
        opened_at: SystemTime::now(),
        app: state.app.clone(),
        capabilities: tokio::sync::RwLock::new(None),
    });

    state.sessions.insert(session.clone());

    Ok(SessionSummary {
        id: session.id.clone(),
        server_id: session.server_id,
        project_id: session.project.as_ref().map(|p| p.id),
        terminal_count: 0,
        fingerprint: session.fingerprint.clone(),
        opened_at: session.opened_at,
    })
}

#[tauri::command]
pub async fn close_session(session_id: String, state: State<'_, AppState>) -> AppResult<()> {
    if let Some(session) = state.sessions.remove(&session_id) {
        // Close all terminals.
        for kv in session.terminals.iter() {
            let _ = kv.value().tx.send(crate::ssh::session_pool::TerminalCommand::Close);
        }
        // Disconnect cleanly.
        let mut handle = session.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionSummary>> {
    Ok(state.sessions.list())
}

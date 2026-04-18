//! Open / close / list sessions. Backs both SSH and FTP — `open_session`
//! dispatches by `Server.protocol` and places the resulting session in
//! the matching pool on `AppState`.

use std::sync::Arc;
use std::time::SystemTime;

use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::{Project, Protocol, Server};
use crate::ssh::client;
use crate::ssh::session_pool::{SessionSummary, SshSession};
use crate::state::AppState;

/// Open a remote session (SSH or FTP/FTPS) for the given server.
#[tauri::command]
pub async fn open_session(
    server_id: Uuid,
    project_id: Option<Uuid>,
    state: State<'_, AppState>,
) -> AppResult<SessionSummary> {
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
    let id = Uuid::new_v4().to_string();

    match server.protocol {
        Protocol::Ssh => {
            let ssh = client::connect(&server).await?;
            let fp = ssh.fingerprint.clone();
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
            let session = Arc::new(SshSession {
                id: id.clone(),
                server_id,
                project,
                handle: Arc::new(Mutex::new(ssh.handle)),
                fingerprint: fp.clone(),
                terminals: dashmap::DashMap::new(),
                opened_at: SystemTime::now(),
                app: state.app.clone(),
                capabilities: tokio::sync::RwLock::new(None),
            });
            state.sessions.insert(session.clone());
            Ok(SessionSummary {
                id,
                server_id,
                project_id: session.project.as_ref().map(|p| p.id),
                terminal_count: 0,
                fingerprint: fp,
                opened_at: session.opened_at,
                protocol: Protocol::Ssh,
            })
        }
        Protocol::Ftp | Protocol::Ftps => {
            let ftp = crate::ftp::FtpSession::connect(&server).await?;
            state.ftp_sessions.insert(id.clone(), Arc::new(ftp));
            Ok(SessionSummary {
                id,
                server_id,
                project_id: project.as_ref().map(|p| p.id),
                terminal_count: 0,
                fingerprint: String::new(),
                opened_at: SystemTime::now(),
                protocol: server.protocol,
            })
        }
    }
}

#[tauri::command]
pub async fn close_session(session_id: String, state: State<'_, AppState>) -> AppResult<()> {
    // Try SSH first, then FTP.
    if let Some(session) = state.sessions.remove(&session_id) {
        for kv in session.terminals.iter() {
            let _ = kv.value().tx.send(crate::ssh::session_pool::TerminalCommand::Close);
        }
        let mut handle = session.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        return Ok(());
    }
    if let Some((_, ftp)) = state.ftp_sessions.remove(&session_id) {
        if let Ok(ftp_owned) = Arc::try_unwrap(ftp) {
            ftp_owned.quit().await;
        }
        // if there are outstanding Arc refs, they'll clean up on drop.
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionSummary>> {
    Ok(state.sessions.list())
}

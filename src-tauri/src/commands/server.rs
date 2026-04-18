//! Server (SSH profile) CRUD + `test_connection`.

use tauri::State;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::{Server, ServerSummary};
use crate::ssh::client;
use crate::state::AppState;

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> AppResult<Vec<ServerSummary>> {
    state
        .vault
        .read(|d| d.servers.iter().map(ServerSummary::from).collect())
        .await
}

/// Fetch the FULL server record (including decrypted auth material) so
/// the Edit dialog can prefill the form. Only usable when the vault is
/// unlocked — secrets travel over local Tauri IPC, never to disk or network.
#[tauri::command]
pub async fn get_server(id: Uuid, state: State<'_, AppState>) -> AppResult<Server> {
    let server = state
        .vault
        .read(|d| d.servers.iter().find(|s| s.id == id).cloned())
        .await?
        .ok_or_else(|| AppError::ServerNotFound(id.to_string()))?;
    Ok(server)
}

/// Create or update a server. If the incoming `id` is `Uuid::nil()` a
/// new one is generated.
#[tauri::command]
pub async fn save_server(mut server: Server, state: State<'_, AppState>) -> AppResult<Server> {
    if server.id.is_nil() {
        server.id = Uuid::new_v4();
    }
    state
        .vault
        .write(|data| {
            if let Some(existing) = data.servers.iter_mut().find(|s| s.id == server.id) {
                *existing = server.clone();
            } else {
                data.servers.push(server.clone());
            }
        })
        .await?;
    Ok(server)
}

#[tauri::command]
pub async fn delete_server(id: Uuid, state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(|data| {
            data.servers.retain(|s| s.id != id);
            data.projects.retain(|p| p.server_id != id);
        })
        .await
}

/// Try to connect using the given config WITHOUT saving it to the
/// vault. Used by the "Test" button in the Add/Edit server dialog so
/// users can verify credentials before committing them.
///
/// Skips host-key pinning (always accepts first-seen) so the test
/// doesn't accidentally lock the user out of a real edit later.
#[tauri::command]
pub async fn test_connection_config(server: Server) -> AppResult<String> {
    // Blank the pinned fingerprint so `client::connect` doesn't reject
    // a server whose key happens to differ from an older pinned one
    // during an edit flow.
    let mut probe = server;
    probe.host_key_fingerprint = None;
    match probe.protocol {
        crate::models::Protocol::Ssh => {
            let client = client::connect(&probe).await?;
            let fp = client.fingerprint.clone();
            let mut handle = client.handle;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(fp)
        }
        crate::models::Protocol::Ftp | crate::models::Protocol::Ftps => {
            let ftp = crate::ftp::FtpSession::connect(&probe).await?;
            ftp.quit().await;
            Ok(format!("{:?}", probe.protocol).to_uppercase() + " OK")
        }
    }
}

/// Try to connect using the server's config. On success, pin the host
/// key fingerprint (if not already pinned). Returns the observed fingerprint.
#[tauri::command]
pub async fn test_connection(id: Uuid, state: State<'_, AppState>) -> AppResult<String> {
    let server: Server = state
        .vault
        .read(|d| d.servers.iter().find(|s| s.id == id).cloned())
        .await?
        .ok_or_else(|| AppError::ServerNotFound(id.to_string()))?;

    match server.protocol {
        crate::models::Protocol::Ssh => {
            let client = client::connect(&server).await?;
            let fp = client.fingerprint.clone();
            if server.host_key_fingerprint.is_none() {
                state
                    .vault
                    .write(|data| {
                        if let Some(s) = data.servers.iter_mut().find(|s| s.id == id) {
                            s.host_key_fingerprint = Some(fp.clone());
                        }
                    })
                    .await?;
            }
            let mut handle = client.handle;
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(fp)
        }
        crate::models::Protocol::Ftp | crate::models::Protocol::Ftps => {
            let ftp = crate::ftp::FtpSession::connect(&server).await?;
            ftp.quit().await;
            Ok(format!("{:?}", server.protocol).to_uppercase() + " OK")
        }
    }
}

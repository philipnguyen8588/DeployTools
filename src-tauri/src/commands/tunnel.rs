//! SSH local port forwarding (-L).
//!
//! `start_tunnel` binds a local TCP listener on `127.0.0.1:<local_port>`
//! and, for every inbound connection, opens a `direct-tcpip` channel over
//! the existing SSH session to `<remote_host>:<remote_port>`, then splices
//! bytes both ways. This reuses the already-authenticated session handle —
//! no extra SSH handshake per tunnel.

use std::sync::Arc;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::TunnelDef;
use crate::ssh::activity;
use crate::ssh::session_pool::SshSession;
use crate::state::AppState;

/// A live tunnel — one local listener forwarding to a remote endpoint.
#[derive(Serialize, Clone)]
pub struct TunnelInfo {
    pub id: String,
    pub session_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// Registry value: the tunnel metadata + a shutdown signal that both the
/// accept loop and every connection task listen on.
pub struct TunnelHandle {
    pub info: TunnelInfo,
    pub shutdown: watch::Sender<bool>,
}

#[tauri::command]
pub async fn start_tunnel(
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> AppResult<TunnelInfo> {
    let session = state.sessions.get(&session_id)?;

    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| AppError::Other(format!("bind 127.0.0.1:{local_port}: {e}")))?;

    let id = Uuid::new_v4().to_string();
    let info = TunnelInfo {
        id: id.clone(),
        session_id: session_id.clone(),
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
    };

    let (tx, rx) = watch::channel(false);

    activity::info(
        &state.app,
        "tunnel",
        format!("↔ tunnel up: 127.0.0.1:{local_port} → {remote_host}:{remote_port}"),
        Some(&session_id),
    );

    let session_ref = session.clone();
    let info_task = info.clone();
    let app = state.app.clone();
    tokio::spawn(async move {
        accept_loop(listener, session_ref, info_task, rx, app).await;
    });

    state
        .tunnels
        .insert(id.clone(), TunnelHandle { info: info.clone(), shutdown: tx });

    Ok(info)
}

#[tauri::command]
pub async fn stop_tunnel(tunnel_id: String, state: State<'_, AppState>) -> AppResult<()> {
    if let Some((_, h)) = state.tunnels.remove(&tunnel_id) {
        let _ = h.shutdown.send(true);
        activity::info(
            &state.app,
            "tunnel",
            format!(
                "tunnel down: 127.0.0.1:{} → {}:{}",
                h.info.local_port, h.info.remote_host, h.info.remote_port
            ),
            Some(&h.info.session_id),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn list_tunnels(
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<TunnelInfo>> {
    let mut out: Vec<TunnelInfo> = state
        .tunnels
        .iter()
        .filter(|kv| {
            session_id
                .as_ref()
                .map_or(true, |sid| &kv.value().info.session_id == sid)
        })
        .map(|kv| kv.value().info.clone())
        .collect();
    out.sort_by_key(|t| t.local_port);
    Ok(out)
}

// ----- Saved tunnels (persisted per server, in the vault) -----

/// List the saved tunnel definitions for a server.
#[tauri::command]
pub async fn list_saved_tunnels(
    server_id: Uuid,
    state: State<'_, AppState>,
) -> AppResult<Vec<TunnelDef>> {
    state
        .vault
        .read(|d| {
            d.servers
                .iter()
                .find(|s| s.id == server_id)
                .map(|s| s.tunnels.clone())
                .unwrap_or_default()
        })
        .await
}

/// Save a tunnel definition on a server (idempotent — a duplicate
/// local/host/port triple is not added twice).
#[tauri::command]
pub async fn save_tunnel(
    server_id: Uuid,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let def = TunnelDef {
        local_port,
        remote_host,
        remote_port,
    };
    state
        .vault
        .write(|d| {
            if let Some(s) = d.servers.iter_mut().find(|s| s.id == server_id) {
                if !s.tunnels.contains(&def) {
                    s.tunnels.push(def.clone());
                    s.tunnels.sort_by_key(|t| t.local_port);
                }
            }
        })
        .await?;
    Ok(())
}

/// Remove a saved tunnel definition from a server.
#[tauri::command]
pub async fn delete_saved_tunnel(
    server_id: Uuid,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let def = TunnelDef {
        local_port,
        remote_host,
        remote_port,
    };
    state
        .vault
        .write(|d| {
            if let Some(s) = d.servers.iter_mut().find(|s| s.id == server_id) {
                s.tunnels.retain(|t| t != &def);
            }
        })
        .await?;
    Ok(())
}

/// Accept connections until the shutdown signal fires or the listener dies.
async fn accept_loop(
    listener: TcpListener,
    session: Arc<SshSession>,
    info: TunnelInfo,
    mut shutdown: watch::Receiver<bool>,
    app: tauri::AppHandle,
) {
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            res = listener.accept() => {
                match res {
                    Ok((stream, _addr)) => {
                        let session = session.clone();
                        let remote_host = info.remote_host.clone();
                        let remote_port = info.remote_port;
                        let sh = shutdown.clone();
                        let app = app.clone();
                        let sid = info.session_id.clone();
                        tokio::spawn(async move {
                            if let Err(e) =
                                handle_conn(stream, session, remote_host, remote_port, sh).await
                            {
                                activity::warn(
                                    &app,
                                    "tunnel",
                                    format!("connection error: {e}"),
                                    Some(&sid),
                                );
                            }
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

/// Splice one accepted TCP connection to a fresh direct-tcpip channel.
async fn handle_conn(
    stream: TcpStream,
    session: Arc<SshSession>,
    remote_host: String,
    remote_port: u16,
    mut shutdown: watch::Receiver<bool>,
) -> AppResult<()> {
    // Open the forwarding channel, then release the handle lock so other
    // channels (terminals, SFTP, other tunnel connections) can proceed.
    let mut channel = {
        let handle = session.handle.lock().await;
        handle
            .channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| AppError::Ssh(format!("direct-tcpip: {e}")))?
    };

    let (mut read_half, mut write_half) = stream.into_split();
    let mut buf = vec![0u8; 32 * 1024];

    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            // local → remote
            n = read_half.read(&mut buf) => {
                match n {
                    Ok(0) => {
                        let _ = channel.eof().await;
                        break;
                    }
                    Ok(n) => {
                        if channel.data(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // remote → local
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if write_half.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

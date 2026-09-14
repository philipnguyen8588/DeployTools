//! Embedded MCP server so external AI agents (Claude Code, …) can drive
//! the app: connect to projects, upload git changes, sync, run commands.
//!
//! Transport: MCP Streamable-HTTP on `127.0.0.1:<port>`, single `POST
//! /mcp` endpoint, bearer-token auth. It reuses the running app's unlocked
//! vault + live SSH sessions via the AppHandle (see `tools.rs`).

pub mod policy;
pub mod protocol;
pub mod tools;

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::watch;

use crate::errors::AppResult;
use crate::state::AppState;

/// Default MCP server port (bound on 127.0.0.1 only).
pub const DEFAULT_MCP_PORT: u16 = 8765;

/// Resolved MCP configuration, read from the (unlocked) vault.
pub struct McpCfg {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub cmd_mode: String,
    pub cmd_denylist: Vec<String>,
}

/// Read the MCP config from the vault, applying defaults. Requires the
/// vault to be unlocked.
pub async fn read_cfg(state: &AppState) -> AppResult<McpCfg> {
    let (enabled, port, token, mode, denylist) = state
        .vault
        .read(|d| {
            (
                d.mcp_enabled.unwrap_or(true),
                d.mcp_port.unwrap_or(DEFAULT_MCP_PORT),
                d.mcp_token.clone().unwrap_or_default(),
                d.mcp_cmd_mode.clone(),
                d.mcp_cmd_denylist.clone(),
            )
        })
        .await?;
    Ok(McpCfg {
        enabled,
        port,
        token,
        cmd_mode: mode
            .filter(|m| matches!(m.as_str(), "off" | "deny" | "disabled"))
            .unwrap_or_else(|| "deny".to_string()),
        cmd_denylist: denylist.unwrap_or_else(policy::default_denied_programs),
    })
}

/// Return the vault-stored MCP token, generating + persisting one if
/// absent. Requires the vault to be unlocked.
pub async fn ensure_token(state: &AppState) -> AppResult<String> {
    if let Some(t) = state.vault.read(|d| d.mcp_token.clone()).await? {
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let bytes: [u8; 24] = rand::random();
    let token = hex::encode(bytes);
    let t2 = token.clone();
    state
        .vault
        .write(move |d| {
            d.mcp_token = Some(t2);
        })
        .await?;
    Ok(token)
}

/// (Re)start the MCP server from the vault config. Stops any running
/// instance first. No-op when disabled. Requires the vault unlocked.
pub async fn start(state: &AppState) -> AppResult<()> {
    stop(state);
    let token = ensure_token(state).await?;
    let cfg = read_cfg(state).await?;
    if cfg.enabled {
        let tx = spawn(state.app.clone(), cfg.port, token);
        *state.mcp_shutdown.lock().unwrap() = Some(tx);
    }
    Ok(())
}

/// Stop the MCP server if running.
pub fn stop(state: &AppState) {
    if let Some(tx) = state.mcp_shutdown.lock().unwrap().take() {
        let _ = tx.send(true);
    }
}

/// Shared state handed to every request handler.
#[derive(Clone)]
pub struct McpState {
    pub app: AppHandle,
    pub token: Arc<String>,
}

/// Start the MCP HTTP server on a background task. Returns a shutdown
/// sender — send `true` (or drop it) to stop the server gracefully.
pub fn spawn(app: AppHandle, port: u16, token: String) -> watch::Sender<bool> {
    let (tx, mut rx) = watch::channel(false);
    let state = McpState {
        app,
        token: Arc::new(token),
    };

    // Use Tauri's managed runtime — `setup` (and this fn) may run outside
    // a Tokio runtime context, where `tokio::spawn` would panic.
    tauri::async_runtime::spawn(async move {
        // Retry the bind a few times: after a lock→unlock or toggle the
        // previous listener may still be releasing the port.
        let listener = {
            let mut attempt = 0;
            loop {
                match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                    Ok(l) => break l,
                    Err(e) if attempt < 5 => {
                        attempt += 1;
                        tracing::warn!(target: "mcp", "bind 127.0.0.1:{port} failed (try {attempt}): {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                    Err(e) => {
                        tracing::error!(target: "mcp", "failed to bind 127.0.0.1:{port}: {e}");
                        return;
                    }
                }
            }
        };
        tracing::info!(target: "mcp", "MCP server listening on http://127.0.0.1:{port}/mcp");

        let router = axum::Router::new()
            .route("/mcp", axum::routing::post(protocol::handle))
            .with_state(state);

        let shutdown = async move {
            let _ = rx.changed().await;
        };

        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
        {
            tracing::error!(target: "mcp", "MCP server error: {e}");
        }
        tracing::info!(target: "mcp", "MCP server stopped");
    });

    tx
}

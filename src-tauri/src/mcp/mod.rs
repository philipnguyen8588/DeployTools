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
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(target: "mcp", "failed to bind 127.0.0.1:{port}: {e}");
                return;
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

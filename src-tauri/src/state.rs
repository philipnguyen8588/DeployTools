//! Global app state shared across all Tauri commands.

use std::sync::Arc;

use dashmap::DashMap;
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::ftp::FtpSession;
use crate::ssh::session_pool::{SessionId, SessionPool};
use crate::vault::Vault;

/// What kind of command is currently occupying a session. Used to
/// decide whether to reject a new request or allow it to coexist.
#[derive(Debug, Clone)]
pub enum InflightKind {
    /// Mutates state on the remote (docker up/down, service restart,
    /// snippet run, …). At most one per session.
    Mutating(String),
    /// Read-only, long-lived stream (docker logs -f). Any number allowed
    /// as long as the `(session, tag)` tuple is unique.
    Follow(String),
}

pub struct AppState {
    pub app: AppHandle,
    pub vault: Arc<Vault>,
    pub sessions: Arc<SessionPool>,

    /// Parallel pool for FTP/FTPS sessions — same `SessionId` keyspace
    /// so the frontend doesn't have to think about which pool the
    /// session lives in. Docker/terminal/service commands error out
    /// when they find the id here instead of in `sessions`.
    pub ftp_sessions: Arc<DashMap<SessionId, Arc<FtpSession>>>,

    /// Mutating command currently running on a session, if any.
    pub inflight: Arc<DashMap<SessionId, InflightKind>>,

    /// Cancellation senders for follow-mode streams, keyed by the same
    /// (session, tag) pair frontend uses for filter chips.
    pub follow_cancellers: Arc<DashMap<(SessionId, String), oneshot::Sender<()>>>,

    /// Active SSH local-forward tunnels, keyed by tunnel id.
    pub tunnels: Arc<DashMap<String, crate::commands::tunnel::TunnelHandle>>,

    /// Cancellation flags for in-flight deploy jobs (sync / folder upload /
    /// batch download), keyed by a frontend-generated job id. Set to true
    /// by `cancel_deploy` and polled inside the transfer loops.
    pub deploy_cancels: Arc<DashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        // Vault location resolved by `settings::resolve_vault_path` —
        // defaults to `<exe-dir>/vault.enc`, user-configurable via the
        // Settings dialog, with a legacy `%APPDATA%` fallback.
        let vault_path = crate::settings::resolve_vault_path(&app);
        tracing::info!(target: "vault", "using vault at {}", vault_path.display());

        Self {
            app,
            vault: Arc::new(Vault::new(vault_path)),
            sessions: Arc::new(SessionPool::new()),
            ftp_sessions: Arc::new(DashMap::new()),
            inflight: Arc::new(DashMap::new()),
            follow_cancellers: Arc::new(DashMap::new()),
            tunnels: Arc::new(DashMap::new()),
            deploy_cancels: Arc::new(DashMap::new()),
        }
    }

    /// Acquire an inflight slot for a session. Returns a `InflightGuard`
    /// that releases on drop. Returns `Err(CommandInFlight)` if the
    /// session already has a mutating command running.
    pub fn acquire_mutating(
        &self,
        session_id: &str,
        what: String,
    ) -> crate::errors::AppResult<InflightGuard> {
        if self.inflight.contains_key(session_id) {
            return Err(crate::errors::AppError::CommandInFlight(
                self.inflight
                    .get(session_id)
                    .map(|k| match k.value() {
                        InflightKind::Mutating(s) => s.clone(),
                        InflightKind::Follow(s) => s.clone(),
                    })
                    .unwrap_or_default(),
            ));
        }
        self.inflight
            .insert(session_id.to_string(), InflightKind::Mutating(what));
        Ok(InflightGuard {
            map: self.inflight.clone(),
            session_id: session_id.to_string(),
        })
    }
}

/// RAII guard releasing the inflight slot on drop.
pub struct InflightGuard {
    map: Arc<DashMap<SessionId, InflightKind>>,
    session_id: SessionId,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.map.remove(&self.session_id);
    }
}

/// Trait impl needed by `app.path()` in the rsync runner and a few other
/// spots — re-export `Manager` there instead of everywhere.
pub use tauri::Manager as _Manager;

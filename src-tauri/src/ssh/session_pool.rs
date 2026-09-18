//! Session pool — one SSH `Handle` per open "tab" in the UI.
//!
//! The frontend is allowed to have many concurrent sessions, including
//! multiple sessions to the same server (mirroring JetBrains' "New SSH
//! Session" UX). Each session owns:
//!   - 1 russh `Handle<ClientHandler>` (the TCP+SSH transport)
//!   - 1 shared SFTP subsystem (lazily opened)
//!   - N terminal channels keyed by `TerminalId`

use std::sync::Arc;
use std::time::SystemTime;

use dashmap::DashMap;
use russh::client::Handle;
use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::Project;
use crate::ssh::capabilities::SessionCapabilities;
use crate::ssh::client::{ClientHandler, SshClient};

pub type SessionId = String;
pub type TerminalId = String;

/// One open session. Each terminal inside it has its own bi-directional
/// writer — the reader task is spawned inside `terminal::open`.
pub struct SshSession {
    pub id: SessionId,
    pub server_id: Uuid,
    /// Snapshot of the `Project` this session was opened for (used for
    /// auto-cd). Commands that care about freshness — e.g. Docker, which
    /// needs the latest `compose_file` override — MUST re-read from the
    /// vault rather than trust this value.
    pub project: Option<Project>,
    pub handle: Arc<Mutex<Handle<ClientHandler>>>,
    pub fingerprint: String,
    /// Keep-alive for the jump-host chain, if this session was opened
    /// through a bastion. The target's transport (`handle`) is a channel
    /// on the jump host's connection, so it must outlive nothing here but
    /// must not be dropped early — holding it keeps the tunnel open.
    /// `None` for direct connections. Never read; presence is the point.
    pub _jump: Option<Box<SshClient>>,
    pub terminals: DashMap<TerminalId, TerminalSlot>,
    pub opened_at: SystemTime,
    pub app: AppHandle,
    /// Lazily populated on first docker/service action; reused for the
    /// remainder of the session's lifetime.
    pub capabilities: RwLock<Option<SessionCapabilities>>,
}

/// Writer side of a running terminal. The reader task owns the channel
/// and pushes data to the frontend via Tauri events.
pub struct TerminalSlot {
    pub terminal_id: TerminalId,
    /// mpsc sender into the shell channel — receives data the user typed.
    pub tx: tokio::sync::mpsc::UnboundedSender<TerminalCommand>,
}

pub enum TerminalCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// The pool itself. Thread-safe, concurrent-friendly (DashMap).
pub struct SessionPool {
    sessions: DashMap<SessionId, Arc<SshSession>>,
}

impl SessionPool {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub fn insert(&self, session: Arc<SshSession>) {
        self.sessions.insert(session.id.clone(), session);
    }

    pub fn get(&self, id: &str) -> AppResult<Arc<SshSession>> {
        self.sessions
            .get(id)
            .map(|s| s.clone())
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    pub fn remove(&self, id: &str) -> Option<Arc<SshSession>> {
        self.sessions.remove(id).map(|(_, v)| v)
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        self.sessions
            .iter()
            .map(|kv| {
                let s = kv.value();
                SessionSummary {
                    id: s.id.clone(),
                    server_id: s.server_id,
                    project_id: s.project.as_ref().map(|p| p.id),
                    terminal_count: s.terminals.len(),
                    fingerprint: s.fingerprint.clone(),
                    opened_at: s.opened_at,
                    protocol: crate::models::Protocol::Ssh,
                }
            })
            .collect()
    }
}

impl Default for SessionPool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(serde::Serialize, Clone)]
pub struct SessionSummary {
    pub id: SessionId,
    pub server_id: Uuid,
    pub project_id: Option<Uuid>,
    pub terminal_count: usize,
    pub fingerprint: String,
    #[serde(with = "systime_serde")]
    pub opened_at: SystemTime,
    pub protocol: crate::models::Protocol,
}

mod systime_serde {
    use serde::Serializer;
    use std::time::{SystemTime, UNIX_EPOCH};
    pub fn serialize<S: Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
        let millis = t.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        s.serialize_u128(millis)
    }
}

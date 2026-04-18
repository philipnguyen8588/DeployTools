//! Per-session capability probe.
//!
//! The first time a user invokes a Docker or Service action on a session,
//! we quickly check what the remote supports and cache the answers for
//! the session's lifetime. The UI reads from this cache to gate buttons
//! and surface actionable errors before the user clicks.

use std::sync::Arc;

use serde::Serialize;

use crate::ssh::exec;
use crate::ssh::session_pool::SshSession;

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionCapabilities {
    /// `docker compose version --short` exits 0.
    pub compose_v2: Option<bool>,
    /// `sudo -n true` exits 0 — we can run `sudo` without a password prompt.
    pub passwordless_sudo: Option<bool>,
    /// `command -v systemctl` exits 0.
    pub has_systemctl: Option<bool>,
    /// `id -u` returns 0.
    pub is_root: Option<bool>,
    /// Raw docker compose version string, if detected.
    pub compose_version: Option<String>,
}

/// Run all four probes concurrently and fill in `SessionCapabilities`.
/// Individual failures are captured as `Some(false)` — never propagated.
pub async fn probe(session: Arc<SshSession>) -> SessionCapabilities {
    let s1 = session.clone();
    let s2 = session.clone();
    let s3 = session.clone();
    let s4 = session.clone();

    // Bind the argv vectors locally so their borrows outlive `tokio::join!`.
    let cmd_compose: Vec<String> =
        vec!["sh".into(), "-c".into(), "docker compose version --short".into()];
    let cmd_sudo: Vec<String> = vec!["sh".into(), "-c".into(), "sudo -n true".into()];
    let cmd_systemd: Vec<String> =
        vec!["sh".into(), "-c".into(), "command -v systemctl".into()];
    let cmd_root: Vec<String> = vec!["sh".into(), "-c".into(), "id -u".into()];

    let (compose, sudo, systemd, root) = tokio::join!(
        exec::run_capturing(s1, None, &cmd_compose, 4 * 1024),
        exec::run_capturing(s2, None, &cmd_sudo, 1024),
        exec::run_capturing(s3, None, &cmd_systemd, 1024),
        exec::run_capturing(s4, None, &cmd_root, 64),
    );

    let (compose_ok, compose_ver) = match compose {
        Ok((stdout, _, 0)) => {
            let v = stdout.trim().to_string();
            (true, if v.is_empty() { None } else { Some(v) })
        }
        _ => (false, None),
    };

    SessionCapabilities {
        compose_v2: Some(compose_ok),
        compose_version: compose_ver,
        passwordless_sudo: Some(matches!(sudo, Ok((_, _, 0)))),
        has_systemctl: Some(matches!(systemd, Ok((_, _, 0)))),
        is_root: Some(match root {
            Ok((stdout, _, 0)) => stdout.trim() == "0",
            _ => false,
        }),
    }
}

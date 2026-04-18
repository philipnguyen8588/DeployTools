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
    /// Docker Compose V1 (`docker-compose`, hyphenated) is installed.
    /// We don't support V1 actions, but we surface this so the UI can
    /// tell the user "upgrade to V2" rather than "not installed".
    pub compose_v1: Option<bool>,
    /// `sudo -n true` exits 0 — we can run `sudo` without a password prompt.
    pub passwordless_sudo: Option<bool>,
    /// `command -v systemctl` exits 0.
    pub has_systemctl: Option<bool>,
    /// `id -u` returns 0.
    pub is_root: Option<bool>,
    /// Raw docker compose version string, if detected.
    pub compose_version: Option<String>,
    /// Captured stderr from the probe — exposed in the UI so users can
    /// diagnose "command not found" / permission issues without having
    /// to open a manual terminal.
    pub probe_stderr: Option<String>,
}

/// Run all four probes concurrently and fill in `SessionCapabilities`.
/// Individual failures are captured as `Some(false)` — never propagated.
pub async fn probe(session: Arc<SshSession>) -> SessionCapabilities {
    let s1 = session.clone();
    let s2 = session.clone();
    let s3 = session.clone();
    let s4 = session.clone();

    // Compose probe: try V2 first, fall back to V1. Emit `__V1__`
    // marker so we can tell the two apart from stdout alone. Redirect
    // stderr of the failing branch so it doesn't pollute detection.
    let compose_script = r#"
if command -v docker >/dev/null 2>&1; then
  if docker compose version --short 2>/dev/null; then
    exit 0
  fi
fi
if command -v docker-compose >/dev/null 2>&1; then
  docker-compose version --short 2>/dev/null && echo '__V1__'
  exit 0
fi
echo "PATH=$PATH" >&2
echo "docker: $(command -v docker 2>&1 || echo 'not found')" >&2
echo "docker-compose: $(command -v docker-compose 2>&1 || echo 'not found')" >&2
exit 1
"#;
    let cmd_compose: Vec<String> =
        vec!["sh".into(), "-c".into(), compose_script.into()];
    let cmd_sudo: Vec<String> = vec!["sh".into(), "-c".into(), "sudo -n true".into()];
    let cmd_systemd: Vec<String> =
        vec!["sh".into(), "-c".into(), "command -v systemctl".into()];
    let cmd_root: Vec<String> = vec!["sh".into(), "-c".into(), "id -u".into()];

    let (compose, sudo, systemd, root) = tokio::join!(
        exec::run_capturing(s1, None, &cmd_compose, 8 * 1024),
        exec::run_capturing(s2, None, &cmd_sudo, 1024),
        exec::run_capturing(s3, None, &cmd_systemd, 1024),
        exec::run_capturing(s4, None, &cmd_root, 64),
    );

    // Compose parse — stdout form `<version>\n` means V2,
    // `<version>\n__V1__\n` means V1 fallback.
    let (compose_v2_ok, compose_v1_ok, compose_ver, probe_stderr) = match &compose {
        Ok((stdout, stderr, _)) => {
            let s = stdout.trim();
            if s.is_empty() {
                (false, false, None, Some(stderr.trim().to_string()))
            } else if s.contains("__V1__") {
                let ver = s
                    .lines()
                    .next()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty() && l != "__V1__");
                (false, true, ver, None)
            } else {
                let ver = s.lines().next().map(|l| l.trim().to_string());
                (true, false, ver, None)
            }
        }
        _ => (false, false, None, Some("probe failed".into())),
    };
    let systemctl_ok = match &systemd {
        Ok((stdout, _, _)) => !stdout.trim().is_empty(),
        _ => false,
    };

    SessionCapabilities {
        compose_v2: Some(compose_v2_ok),
        compose_v1: Some(compose_v1_ok),
        compose_version: compose_ver,
        probe_stderr: probe_stderr.filter(|s| !s.is_empty()),
        passwordless_sudo: Some(matches!(sudo, Ok((_, _, 0)))),
        has_systemctl: Some(systemctl_ok),
        is_root: Some(match &root {
            Ok((stdout, _, _)) => stdout.trim() == "0",
            _ => false,
        }),
    }
}

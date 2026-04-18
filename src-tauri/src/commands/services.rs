//! systemd service management over SSH.
//!
//! We shell out to `systemctl` — with a PTY when the server requires a
//! TTY for `sudo`. The user is never asked for a sudo password in-app;
//! we fail loudly if passwordless sudo isn't configured.

use serde::Serialize;
use tauri::State;

use crate::errors::{AppError, AppResult};
use crate::ssh::exec::{self, ExecOpts};
use crate::state::AppState;

#[derive(Serialize, Clone)]
pub struct ServiceEntry {
    pub unit: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
}

/// List running services via `systemctl list-units --type=service
/// --state=running --no-pager`. Falls back to plain output parsing on
/// distros whose systemd doesn't support `-o json`.
#[tauri::command]
pub async fn service_list(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<ServiceEntry>> {
    let session = state.sessions.get(&session_id)?;

    // Try JSON output first (systemd ≥ 230).
    let argv_json = vec![
        "sh".into(),
        "-c".into(),
        "systemctl list-units --type=service --state=running --no-pager -o json 2>/dev/null".into(),
    ];
    let (stdout, _stderr, code) =
        exec::run_capturing(session.clone(), None, &argv_json, 512 * 1024).await?;
    if code == 0 && !stdout.trim().is_empty() {
        if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
            let list = items
                .into_iter()
                .map(|v| ServiceEntry {
                    unit: v.get("unit").and_then(|x| x.as_str()).unwrap_or("").into(),
                    load: v.get("load").and_then(|x| x.as_str()).unwrap_or("").into(),
                    active: v.get("active").and_then(|x| x.as_str()).unwrap_or("").into(),
                    sub: v.get("sub").and_then(|x| x.as_str()).unwrap_or("").into(),
                    description: v
                        .get("description")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .into(),
                })
                .collect();
            return Ok(list);
        }
    }

    // Fallback: parse the pretty table.
    let argv = vec![
        "sh".into(),
        "-c".into(),
        "systemctl list-units --type=service --state=running --no-pager --plain --no-legend".into(),
    ];
    let (stdout, _, _) =
        exec::run_capturing(session.clone(), None, &argv, 512 * 1024).await?;
    Ok(stdout
        .lines()
        .filter_map(parse_table_row)
        .collect())
}

fn parse_table_row(line: &str) -> Option<ServiceEntry> {
    // Format: UNIT LOAD ACTIVE SUB DESCRIPTION…
    // We split on whitespace for the first four columns and keep the rest as description.
    let mut parts = line.splitn(5, char::is_whitespace).map(str::trim);
    let unit = parts.next()?.to_string();
    let load = parts.next()?.to_string();
    let active = parts.next()?.to_string();
    let sub = parts.next()?.to_string();
    let description = parts.next().unwrap_or("").to_string();
    if unit.is_empty() || !unit.ends_with(".service") {
        return None;
    }
    Some(ServiceEntry {
        unit,
        load,
        active,
        sub,
        description,
    })
}

/// Apply a systemctl action. Uses `sudo` + PTY (some distros require a
/// TTY even with NOPASSWD). If the session's capability probe has flagged
/// `passwordless_sudo = false`, we reject with an actionable error.
#[tauri::command]
pub async fn service_action(
    session_id: String,
    name: String,
    action: String,
    state: State<'_, AppState>,
) -> AppResult<i32> {
    const ACTIONS: &[&str] = &["start", "stop", "restart", "reload", "status"];
    if !ACTIONS.contains(&action.as_str()) {
        return Err(AppError::Other(format!("unknown action: {action}")));
    }

    let session = state.sessions.get(&session_id)?;

    // Lazily populate capabilities on first call.
    {
        let mut slot = session.capabilities.write().await;
        if slot.is_none() {
            *slot = Some(crate::ssh::capabilities::probe(session.clone()).await);
        }
    }
    let caps = session.capabilities.read().await.clone().unwrap_or_default();

    if !caps.has_systemctl.unwrap_or(false) {
        return Err(AppError::FeatureUnavailable(
            "systemctl not found on the remote host".into(),
        ));
    }

    let is_root = caps.is_root.unwrap_or(false);
    if !is_root && !caps.passwordless_sudo.unwrap_or(false) {
        return Err(AppError::FeatureUnavailable(
            "passwordless sudo required — see 'Copy sudoers snippet' in the UI".into(),
        ));
    }

    // Reject concurrent mutators (except for `status`, which is read-only).
    let _guard = if action != "status" {
        Some(
            state
                .acquire_mutating(&session_id, format!("systemctl {action} {name}"))?,
        )
    } else {
        None
    };

    // Command assembly — sudo only when needed.
    let sudo = if is_root { "" } else { "sudo " };
    let cmd = format!(
        "{sudo}SYSTEMD_COLORS=0 systemctl {} {} --no-pager",
        shell_quote(&action),
        shell_quote(&name),
    );
    let argv = vec!["sh".into(), "-c".into(), cmd];

    let result = exec::run_streaming(
        session.clone(),
        None,
        &argv,
        "service",
        ExecOpts {
            pty: true,
            tag: Some(name.clone()),
            ..Default::default()
        },
        None,
    )
    .await?;
    Ok(result.exit)
}

fn shell_quote(s: &str) -> String {
    crate::ssh::quote::shell_single_quote(s)
}

//! Spawn the bundled rsync binary and stream its output to the frontend.
//!
//! On Windows we ship cwRsync under `src-tauri/binaries/rsync-x86_64-pc-windows-msvc.exe`
//! (see `tauri.conf.json` → `bundle.resources`). If the bundled binary is
//! missing we fall back to `rsync` on PATH (useful in dev or on macOS/Linux).
//!
//! IMPORTANT: all arguments (flags, paths, excludes) are passed as a
//! `Vec<String>` — never formatted into a single shell string. This is
//! our primary defense against command injection.

use std::path::PathBuf;
use std::process::Stdio;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::errors::{AppError, AppResult};
use crate::models::{AuthMethod, Project, Server};

/// Resolve the rsync binary path using this priority:
///   1. Binary bundled inside the app resource dir.
///   2. Binary next to the DeployTools executable (for dev builds).
///   3. Well-known install paths: Git for Windows, msys2, Cygwin.
///   4. Last resort: `rsync` on PATH.
///
/// Returns an error only if nothing is executable anywhere; in practice
/// we still return "rsync" as a literal so the user sees the system-level
/// error ("program not found") if they really have none of these.
fn resolve_rsync(app: &AppHandle) -> AppResult<PathBuf> {
    let bin_name = if cfg!(windows) {
        "rsync-x86_64-pc-windows-msvc.exe"
    } else if cfg!(target_os = "macos") {
        "rsync-aarch64-apple-darwin"
    } else {
        "rsync-x86_64-unknown-linux-gnu"
    };

    // 1. Packaged resource dir — populated by `tauri.conf.json` bundle.resources.
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("binaries").join(bin_name);
        if p.exists() {
            return Ok(p);
        }
    }

    // 2. Dev: the `src-tauri/binaries/` folder next to the running exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // target/debug/deploy-tools.exe → walk up to repo root
            for ascend in 0..5 {
                let mut candidate = dir.to_path_buf();
                for _ in 0..ascend {
                    candidate = match candidate.parent() {
                        Some(p) => p.to_path_buf(),
                        None => break,
                    };
                }
                let p = candidate.join("binaries").join(bin_name);
                if p.exists() {
                    return Ok(p);
                }
                let p2 = candidate.join("src-tauri/binaries").join(bin_name);
                if p2.exists() {
                    return Ok(p2);
                }
            }
        }
    }

    // 3. Platform-specific well-known install locations.
    #[cfg(windows)]
    {
        let candidates = [
            r"C:\Program Files\Git\usr\bin\rsync.exe",
            r"C:\Program Files (x86)\Git\usr\bin\rsync.exe",
            r"C:\msys64\usr\bin\rsync.exe",
            r"C:\cygwin64\bin\rsync.exe",
            r"C:\cwRsync\rsync.exe",
            r"C:\Program Files\cwRsync\rsync.exe",
        ];
        for c in candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                tracing::info!(target: "rsync", "using {}", p.display());
                return Ok(p);
            }
        }
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        for c in ["/usr/local/bin/rsync", "/opt/homebrew/bin/rsync", "/usr/bin/rsync"] {
            let p = PathBuf::from(c);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 4. PATH fallback.
    Ok(PathBuf::from("rsync"))
}

pub struct RsyncOptions<'a> {
    pub project: &'a Project,
    pub server: &'a Server,
    /// If true, pass `--dry-run`.
    pub dry_run: bool,
}

/// Run rsync. Returns exit code (0 on success). Streams output via
/// `rsync-log://{project_id}` events as `LogLine` payloads.
pub async fn run(app: &AppHandle, opts: RsyncOptions<'_>) -> AppResult<i32> {
    let rsync = resolve_rsync(app)?;
    let RsyncOptions {
        project,
        server,
        dry_run,
    } = opts;

    let event = format!("rsync-log://{}", project.id);

    // --- Build SSH transport arg for rsync's -e ---
    // cwRsync on Windows does NOT bundle ssh; we rely on OpenSSH which
    // ships with Windows 10/11.  Users can override by editing project.rsync_flags.
    let mut ssh_cmd = String::from("ssh");
    ssh_cmd.push_str(&format!(" -p {}", server.port));
    ssh_cmd.push_str(" -o BatchMode=yes");
    ssh_cmd.push_str(" -o StrictHostKeyChecking=accept-new");
    match &server.auth {
        AuthMethod::PrivateKey { key_path, .. } => {
            ssh_cmd.push_str(&format!(" -i \"{}\"", key_path.to_string_lossy()));
        }
        AuthMethod::Password { .. } => {
            // rsync over ssh with password auth requires an external
            // agent (sshpass). We surface this at the UI layer so the
            // user is nudged toward key-auth, which is the safer option.
            emit_log(
                app,
                &event,
                LogLevel::Warn,
                "password auth with rsync requires sshpass; consider using a key",
            );
        }
    }

    // --- Assemble argv ---
    let mut args: Vec<String> = Vec::new();
    // Split user-configured flags (default "-avz --delete") safely on whitespace.
    args.extend(
        project
            .rsync_flags
            .split_whitespace()
            .map(|s| s.to_string()),
    );
    if dry_run {
        args.push("--dry-run".to_string());
    }
    args.push("-e".into());
    args.push(ssh_cmd);

    for pat in &project.excludes {
        args.push(format!("--exclude={}", pat));
    }

    // Source / destination. Trailing `/` on source means "contents of".
    let src = {
        let mut s = project.local_path.to_string_lossy().to_string();
        if !s.ends_with(['/', '\\']) {
            s.push('/');
        }
        s
    };
    let dst = format!(
        "{}@{}:{}",
        server.user,
        server.host,
        ensure_trailing_slash(&project.remote_path)
    );
    args.push(src);
    args.push(dst);

    emit_log(
        app,
        &event,
        LogLevel::Info,
        &format!("$ {} {}", rsync.to_string_lossy(), redact_args(&args).join(" ")),
    );

    // --- Spawn ---
    let mut cmd = Command::new(&rsync);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("spawn rsync: {e}")))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let event_out = event.clone();
    let event_err = event.clone();

    let out_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_log(&app_out, &event_out, LogLevel::Info, &line);
        }
    });
    let err_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            emit_log(&app_err, &event_err, LogLevel::Error, &line);
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Other(format!("wait rsync: {e}")))?;
    let _ = out_task.await;
    let _ = err_task.await;

    let code = status.code().unwrap_or(-1);
    if code == 0 {
        emit_log(app, &event, LogLevel::Info, "✓ rsync completed successfully");
        Ok(0)
    } else {
        Err(AppError::RsyncFailed {
            code,
            message: format!("rsync exited with status {code}"),
        })
    }
}

fn ensure_trailing_slash(s: &str) -> String {
    if s.ends_with('/') {
        s.to_string()
    } else {
        format!("{s}/")
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(serde::Serialize, Clone)]
struct LogLine {
    level: LogLevel,
    line: String,
}

fn emit_log(app: &AppHandle, event: &str, level: LogLevel, line: &str) {
    let _ = app.emit(
        event,
        LogLine {
            level,
            line: crate::ssh::client::redact(line),
        },
    );
    tracing::debug!(target: "rsync", %line);
}

/// Redact any path that looks secret from the argv we log back to the UI.
/// Currently a no-op since we never log passwords, but kept as a hook.
fn redact_args(args: &[String]) -> Vec<String> {
    args.iter().map(|a| crate::ssh::client::redact(a)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trailing_slash() {
        assert_eq!(ensure_trailing_slash("/var/www"), "/var/www/");
        assert_eq!(ensure_trailing_slash("/var/www/"), "/var/www/");
    }
}

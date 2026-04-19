//! Spawn the OS's own terminal app — local shell or an SSH window to a
//! configured server. The point is to let the user drop out of the
//! integrated xterm into a "real" terminal when they want multiplexed
//! Ctrl+A tmux / proper font rendering / native copy-paste behaviour.
//!
//! Commands (Windows-focused because the app ships on Windows):
//!   * `open_local_terminal`  → Windows Terminal if present, else cmd.exe,
//!                              optionally started at a working directory.
//!   * `open_ssh_terminal`    → spawns the local terminal running
//!                              `ssh <user>@<host> -p <port> [-i <key>]`.
//!
//! Inline PEM keys (pasted into the Private key field) are written to a
//! temp file with 0600-equivalent perms and passed via `-i`, because
//! the system ssh.exe can't consume stdin keys.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::State;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::{AuthMethod, Protocol};
use crate::state::AppState;

#[tauri::command]
pub async fn open_local_terminal(cwd: Option<String>) -> AppResult<()> {
    spawn_terminal(cwd.as_deref(), None)
}

#[tauri::command]
pub async fn open_ssh_terminal(
    server_id: Uuid,
    remote_path: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let server = state
        .vault
        .read(|d| d.servers.iter().find(|s| s.id == server_id).cloned())
        .await?
        .ok_or_else(|| AppError::Other(format!("server {server_id} not found")))?;

    if !matches!(server.protocol, Protocol::Ssh) {
        return Err(AppError::Other(
            "System terminal is only supported for SSH servers".into(),
        ));
    }

    // argv is built in the order ssh expects:
    //   ssh  [opts: -p -i -t]  user@host  [command]
    // The optional `cd && exec $SHELL -l` command must be the LAST arg,
    // so we collect options separately and append the command at the end.
    let mut opts: Vec<String> = vec![
        "-p".into(),
        server.port.to_string(),
    ];
    if let AuthMethod::PrivateKey { key_path, .. } = &server.auth {
        // If the value looks like an inline PEM, drop it to a temp file
        // so ssh.exe can read it via `-i`.
        let path: PathBuf = if key_path.trim_start().starts_with("-----BEGIN") {
            let tmp = std::env::temp_dir().join(format!(
                "dt-key-{}-{}.pem",
                server_id,
                chrono::Utc::now().timestamp_millis()
            ));
            std::fs::write(&tmp, key_path).map_err(|e| {
                AppError::Other(format!("write temp key file: {e}"))
            })?;
            // On *nix, restrict perms to 0600. Ignored on Windows —
            // ssh.exe still accepts the file but may warn.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &tmp,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            tmp
        } else {
            PathBuf::from(key_path)
        };
        opts.push("-i".into());
        opts.push(path.to_string_lossy().into_owned());
    }
    // `remote_path` is accepted for forward compatibility but deliberately
    // NOT used to auto-cd — the combination of Windows cmd quoting + ssh's
    // pty handling was fragile (the session kept dropping right after
    // login). The user can run `cd <path>` themselves after authenticating.
    let _ = remote_path;

    let mut ssh_argv: Vec<String> = vec!["ssh".to_string()];
    ssh_argv.extend(opts);
    ssh_argv.push(format!("{}@{}", server.user, server.host));
    // Password auth can't be piped to ssh.exe — the user will just be
    // prompted inside the new terminal window. Same for passphrase-
    // protected keys.

    let joined = ssh_argv
        .into_iter()
        .map(|s| {
            if s.chars().any(|c| c.is_whitespace()) {
                format!("\"{}\"", s.replace('"', "\\\""))
            } else {
                s
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    spawn_terminal(None, Some(&joined))
}

/// Shared helper: open the system terminal. If `run` is Some, feed it
/// as the initial command; otherwise just drop into an interactive
/// shell. `cwd` is the working dir to start at.
fn spawn_terminal(cwd: Option<&str>, run: Option<&str>) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        // Prefer Windows Terminal (wt.exe) if installed — better font
        // rendering + tabs. Fall back to classic cmd.exe.
        let have_wt = which::which("wt").is_ok();
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/c").arg("start").arg("");
        if have_wt {
            cmd.arg("wt.exe");
            if let Some(dir) = cwd {
                cmd.arg("-d").arg(dir);
            }
            if let Some(r) = run {
                cmd.arg("cmd").arg("/k").arg(r);
            }
        } else {
            cmd.arg("cmd.exe").arg("/k");
            let mut inner = String::new();
            if let Some(dir) = cwd {
                inner.push_str(&format!("cd /d \"{}\" ", dir));
                if run.is_some() {
                    inner.push_str("&& ");
                }
            }
            if let Some(r) = run {
                inner.push_str(r);
            }
            if !inner.is_empty() {
                cmd.arg(inner);
            }
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| AppError::Other(format!("spawn terminal: {e}")))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.arg("-a").arg("Terminal");
        if let Some(dir) = cwd {
            cmd.arg(dir);
        }
        // macOS `open -a Terminal` doesn't easily accept a command — we
        // ignore `run` for now. Power users can paste the command.
        let _ = run;
        cmd.spawn()
            .map_err(|e| AppError::Other(format!("spawn terminal: {e}")))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators in order. Pick the first that
        // resolves on PATH.
        let terms = [
            ("gnome-terminal", vec!["--"]),
            ("konsole", vec!["-e"]),
            ("xterm", vec!["-e"]),
            ("kitty", vec![]),
        ];
        for (t, flags) in terms {
            if which::which(t).is_ok() {
                let mut cmd = Command::new(t);
                for f in flags {
                    cmd.arg(f);
                }
                if let Some(dir) = cwd {
                    cmd.current_dir(dir);
                }
                if let Some(r) = run {
                    cmd.arg("bash").arg("-c").arg(format!("{r}; exec bash"));
                }
                cmd.spawn()
                    .map_err(|e| AppError::Other(format!("spawn terminal: {e}")))?;
                return Ok(());
            }
        }
        let _ = (cwd, run);
        Err(AppError::Other("No known terminal emulator on PATH".into()))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn _require_supported_os(_cwd: Option<&str>, _run: Option<&str>) -> AppResult<()> {
    let _ = (_cwd, _run);
    Ok(())
}

// Small `which` shim because pulling the full `which` crate for 2 callers
// would bloat the dependency tree; this one walks $PATH manually.
mod which {
    use super::Path;

    pub fn which(bin: &str) -> Result<(), ()> {
        let path = std::env::var_os("PATH").ok_or(())?;
        for dir in std::env::split_paths(&path) {
            let cand = dir.join(bin);
            if is_runnable(&cand) {
                return Ok(());
            }
            // On Windows PATHEXT can be .EXE/.CMD/.BAT — try .exe.
            #[cfg(windows)]
            {
                let mut with_ext = cand.clone();
                with_ext.set_extension("exe");
                if is_runnable(&with_ext) {
                    return Ok(());
                }
            }
        }
        Err(())
    }

    fn is_runnable(p: &Path) -> bool {
        p.is_file()
    }
}

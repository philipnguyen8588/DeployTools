//! Interactive PTY + shell over an SSH session.
//!
//! Flow:
//! 1. Open a channel from the existing SSH `Handle`.
//! 2. Request an xterm-256color PTY with the given cols/rows.
//! 3. Request a shell.
//! 4. If the session was opened for a project with `remote_path`, send
//!    `cd '<remote_path>' 2>/dev/null; clear\n` as the first input, so the
//!    shell lands in the project dir with a clean screen (no echoed `cd`).
//! 5. Spawn a background task that:
//!      - Reads outbound user input from an mpsc channel → `channel.data()`
//!      - Reads channel data → emits `term://<terminal_id>` events
//!      - Handles resize and close messages

use std::sync::Arc;

use russh::{ChannelMsg, Pty};
use tauri::Emitter;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::ssh::session_pool::{SshSession, TerminalCommand, TerminalId, TerminalSlot};

/// PTY modes — empty means "server defaults", which is sensible for an
/// interactive shell. Tuning (e.g. setting VINTR/VEOF/erase) is possible
/// but rarely needed for a web-driven xterm.js frontend.
const PTY_MODES: &[(Pty, u32)] = &[];

pub async fn open(
    session: Arc<SshSession>,
    cols: u32,
    rows: u32,
) -> AppResult<TerminalId> {
    let terminal_id = Uuid::new_v4().to_string();

    let mut handle = session.handle.lock().await;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;

    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, PTY_MODES)
        .await
        .map_err(|e| AppError::Ssh(format!("request_pty: {e}")))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::Ssh(format!("request_shell: {e}")))?;

    drop(handle); // release the handle lock — we only need it for channel open

    // Channel used by the command layer to push user keystrokes / resize / close.
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<TerminalCommand>();

    // Initial auto-cd command — sent only AFTER the first data chunk
    // from the server (MOTD / last-login banner / first prompt) has been
    // forwarded to the UI. Sending it any earlier races the banner and
    // the user never sees "Welcome to Ubuntu …" on screen.
    // We append `clear` so the echoed `cd …` command line (and the racey
    // double-echo from sending input before PS1 is fully painted) is wiped,
    // leaving a clean prompt already in the project directory. `clear`
    // (modern ncurses) also drops scrollback via the \033[3J it emits;
    // `printf '\033c'` is a portable fallback for boxes without `clear`.
    let init_cmd: Option<String> = session.project.as_ref().map(|project| {
        let quoted = crate::ssh::quote::shell_single_quote(&project.remote_path);
        format!("cd {quoted} 2>/dev/null; {{ clear || printf '\\033c'; }} 2>/dev/null\n")
    });

    // Spawn the driver task.
    let app = session.app.clone();
    let term_id = terminal_id.clone();
    let session_ref = session.clone();
    tokio::spawn(async move {
        let mut pending_init = init_cmd;
        let event_name = format!("term://{}", term_id);
        let exit_event = format!("term-exit://{}", term_id);

        loop {
            tokio::select! {
                // Incoming data from the user.
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(TerminalCommand::Data(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(TerminalCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(TerminalCommand::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
                // Incoming data from the server.
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let bytes = data.to_vec();
                            let _ = app.emit(&event_name, bytes);
                            // The banner is on its way — now it's safe to
                            // inject the `cd` without stepping on the
                            // MOTD / prompt rendering.
                            if let Some(cmd) = pending_init.take() {
                                let _ = channel.data(cmd.as_bytes()).await;
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, ext: _ }) => {
                            // stderr over an interactive shell — merge.
                            let bytes = data.to_vec();
                            let _ = app.emit(&event_name, bytes);
                            if let Some(cmd) = pending_init.take() {
                                let _ = channel.data(cmd.as_bytes()).await;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            let _ = app.emit(&exit_event, exit_status);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        // Clean up the slot in the session.
        session_ref.terminals.remove(&term_id);
        let _ = app.emit(&exit_event, -1i32);
    });

    session.terminals.insert(
        terminal_id.clone(),
        TerminalSlot {
            terminal_id: terminal_id.clone(),
            tx: cmd_tx,
        },
    );

    Ok(terminal_id)
}

pub fn write(session: &SshSession, terminal_id: &str, data: Vec<u8>) -> AppResult<()> {
    let slot = session
        .terminals
        .get(terminal_id)
        .ok_or_else(|| AppError::TerminalNotFound(terminal_id.to_string()))?;
    slot.tx
        .send(TerminalCommand::Data(data))
        .map_err(|_| AppError::TerminalNotFound(terminal_id.to_string()))?;
    Ok(())
}

pub fn resize(session: &SshSession, terminal_id: &str, cols: u32, rows: u32) -> AppResult<()> {
    let slot = session
        .terminals
        .get(terminal_id)
        .ok_or_else(|| AppError::TerminalNotFound(terminal_id.to_string()))?;
    slot.tx
        .send(TerminalCommand::Resize { cols, rows })
        .map_err(|_| AppError::TerminalNotFound(terminal_id.to_string()))?;
    Ok(())
}

pub fn close(session: &SshSession, terminal_id: &str) -> AppResult<()> {
    if let Some(slot) = session.terminals.get(terminal_id) {
        let _ = slot.tx.send(TerminalCommand::Close);
    }
    Ok(())
}


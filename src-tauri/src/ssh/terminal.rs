//! Interactive PTY + shell over an SSH session.
//!
//! Flow:
//! 1. Open a channel from the existing SSH `Handle`.
//! 2. Request an xterm-256color PTY with the given cols/rows.
//! 3. Request a shell.
//! 4. If the session was opened for a project with `remote_path`, send
//!    `cd '<remote_path>' 2>/dev/null; printf '\033[A\033[2K\r'\n` as the
//!    first input — the shell lands in the project dir and the printf
//!    erases the echoed `cd` line, while the server MOTD above survives.
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
    // To hide the echoed `cd …` line WITHOUT wiping the MOTD (a previous
    // version ran `clear`, which nuked the whole screen including the
    // login message), we append a printf that moves the cursor up one row
    // and erases just that line — the fresh prompt then paints over the
    // spot where the echo was. If the echoed command happens to wrap on a
    // very narrow terminal only its last row is erased; cosmetic only.
    let init_cmd: Option<String> = session.project.as_ref().map(|project| {
        let quoted = crate::ssh::quote::shell_single_quote(&project.remote_path);
        format!("cd {quoted} 2>/dev/null; printf '\\033[A\\033[2K\\r'\n")
    });

    // Spawn the driver task.
    let app = session.app.clone();
    let term_id = terminal_id.clone();
    let session_ref = session.clone();
    tokio::spawn(async move {
        let mut pending_init = init_cmd;
        // The auto-cd is injected only after the server has been QUIET for
        // 300 ms following its first output. Injecting right after the
        // first chunk (previous behavior) raced the login MOTD: the tty
        // driver echoed the cd line mid-MOTD and the erase sequence then
        // wiped the wrong line. Quiescence means the MOTD is fully
        // painted and the shell is sitting at its prompt, so the cd
        // echoes exactly once, at the prompt, where the printf erases it.
        let mut init_deadline: Option<tokio::time::Instant> = None;
        let event_name = format!("term://{}", term_id);
        let exit_event = format!("term-exit://{}", term_id);

        // Output coalescing + flood shedding. Line-buffered producers
        // (`docker compose logs -f`, verbose builds) generate hundreds of
        // tiny Data messages per second; forwarding each as its own Tauri
        // event floods the webview IPC (every payload is JSON-serialized)
        // and freezes the UI. Buffer server output and flush at most once
        // per 16 ms (one frame). Each flush forwards at most the NEWEST
        // ~256 KiB (see flush_output) — xterm's scrollback is 2000 lines,
        // so anything older would scroll straight out of the buffer
        // anyway; shedding it keeps even a multi-MB/s burst harmless.
        // After an idle period the interval has a tick "banked", so a
        // lone keystroke echo still flushes immediately — no felt latency.
        let mut out_buf: Vec<u8> = Vec::new();
        let mut flush =
            tokio::time::interval(std::time::Duration::from_millis(16));
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
                            out_buf.extend_from_slice(&data);
                            // Every output chunk pushes the quiet-period
                            // deadline back; the auto-cd fires only once
                            // the stream settles (see init_deadline note).
                            if pending_init.is_some() {
                                init_deadline = Some(
                                    tokio::time::Instant::now()
                                        + std::time::Duration::from_millis(300),
                                );
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, ext: _ }) => {
                            // stderr over an interactive shell — merge.
                            out_buf.extend_from_slice(&data);
                            if pending_init.is_some() {
                                init_deadline = Some(
                                    tokio::time::Instant::now()
                                        + std::time::Duration::from_millis(300),
                                );
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            // Drain buffered output first so the frontend
                            // sees all data before the exit notification.
                            flush_output(&app, &event_name, &mut out_buf);
                            let _ = app.emit(&exit_event, exit_status);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
                // Frame-paced flush of buffered output. The branch is
                // disabled while the buffer is empty so an idle terminal
                // never wakes the task.
                _ = flush.tick(), if !out_buf.is_empty() => {
                    flush_output(&app, &event_name, &mut out_buf);
                }
                // Server went quiet after login output → inject the
                // auto-cd now, at a settled prompt.
                _ = tokio::time::sleep_until(init_deadline.unwrap_or_else(tokio::time::Instant::now)),
                    if init_deadline.is_some() && pending_init.is_some() => {
                    init_deadline = None;
                    if let Some(cmd) = pending_init.take() {
                        let _ = channel.data(cmd.as_bytes()).await;
                    }
                }
            }
        }

        // Clean up the slot in the session. Drain any tail output first.
        flush_output(&app, &event_name, &mut out_buf);
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

/// Emit buffered terminal output to the frontend, shedding all but the
/// newest `KEEP_MAX` bytes when a flood outpaces the display.
///
/// Rationale: xterm keeps 2000 lines of scrollback (~250 KiB of text) —
/// bytes older than that scroll straight out of its buffer, so pushing
/// them across the IPC and through the parser is pure waste, and during a
/// `docker compose logs -f` burst it is exactly that waste that used to
/// freeze the webview. The cut lands on a newline boundary when one is
/// near so escape sequences / UTF-8 rarely split, and a dim notice line
/// tells the user how much was skipped.
fn flush_output(app: &tauri::AppHandle, event: &str, buf: &mut Vec<u8>) {
    // Cap per-frame output at ~64 KiB. At the 16 ms flush cadence that is
    // ~3.75 MiB/s reaching xterm — comfortably within what the WebGL
    // renderer paints smoothly, so a `docker compose logs -f` history
    // dump scrolls fast instead of freezing the UI. Follow-mode traffic
    // is far below this, so live logs are never delayed.
    const KEEP_MAX: usize = 64 * 1024;
    if buf.is_empty() {
        return;
    }
    if buf.len() > KEEP_MAX {
        let mut cut = buf.len() - KEEP_MAX;
        // Prefer starting the kept tail at a line boundary.
        if let Some(nl) = buf[cut..(cut + 4096).min(buf.len())]
            .iter()
            .position(|&b| b == b'\n')
        {
            cut += nl + 1;
        }
        let skipped_kib = cut / 1024;
        let mut shed = format!(
            "\r\n\x1b[90m[{skipped_kib} KiB skipped — output arriving faster than the display]\x1b[0m\r\n"
        )
        .into_bytes();
        shed.extend_from_slice(&buf[cut..]);
        *buf = shed;
    }
    let _ = app.emit(event, std::mem::take(buf));
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


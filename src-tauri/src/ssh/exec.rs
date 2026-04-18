//! Remote command execution over a single russh exec channel.
//!
//! This is the shared primitive behind snippet_run, service_action,
//! docker_compose_* and the capability probe. It is **not** a Tauri
//! command — domain commands build their argv and call in here, so the
//! frontend never gets to inject arbitrary shell.
//!
//! Three flavours:
//! - [`run_streaming`] — long-lived, line-by-line emitting activity events
//! - [`run_capturing`] — short, collect stdout/stderr into memory
//! - [`run_with_pty`]  — allocate a PTY (needed for `sudo` on TTY-requiring distros)

use std::sync::Arc;

use russh::ChannelMsg;
use tokio::sync::oneshot;

use crate::errors::{AppError, AppResult};
use crate::ssh::activity::{self, Level};
use crate::ssh::client::redact;
use crate::ssh::quote::cd_and;
use crate::ssh::session_pool::SshSession;

/// Exit code from the remote side. `-1` is used when the channel closed
/// without an explicit status (e.g. the transport dropped).
pub type ExitCode = i32;

pub struct StreamedResult {
    pub exit: ExitCode,
}

/// Options for a single exec invocation.
#[derive(Default)]
pub struct ExecOpts {
    /// Allocate a PTY — needed for `sudo` on distros with `Defaults requiretty`.
    pub pty: bool,
    /// Batch stdout/stderr lines into 50ms buckets to avoid flooding the
    /// frontend with IPC events (used for log follow).
    pub batch: bool,
    /// When set, activity events include this key → makes per-service
    /// filtering possible on the frontend.
    pub tag: Option<String>,
}

/// Run `argv` on the remote (inside `working_dir` if given), streaming
/// each stdout/stderr line as an activity event with `source = source`.
/// Returns the exit code.
pub async fn run_streaming(
    session: Arc<SshSession>,
    working_dir: Option<&str>,
    argv: &[String],
    source: &'static str,
    opts: ExecOpts,
    cancel: Option<oneshot::Receiver<()>>,
) -> AppResult<StreamedResult> {
    let command = match working_dir {
        Some(dir) => cd_and(dir, argv),
        None => crate::ssh::quote::quote_argv(argv),
    };

    let (mut channel, _) = open_channel(&session, &command, opts.pty).await?;

    // Announce the command to the activity log (redacted).
    let argv_str = argv.join(" ");
    activity::info(
        &session.app,
        source,
        format!("$ {}", redact(&argv_str)),
        Some(&session.id),
    );

    // Optional batched emitter for chatty streams.
    let mut buf: Vec<(Level, String)> = Vec::new();
    let mut last_flush = std::time::Instant::now();
    let flush_interval = std::time::Duration::from_millis(50);

    let mut cancel = cancel;
    let mut exit: ExitCode = -1;

    loop {
        // Check for external cancellation between channel reads.
        if let Some(rx) = cancel.as_mut() {
            match rx.try_recv() {
                Ok(_) | Err(oneshot::error::TryRecvError::Closed) => {
                    let _ = channel.eof().await;
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }
        }

        let msg_fut = channel.wait();
        let msg = if opts.batch {
            // Wake every 50ms to flush, even if no new data.
            match tokio::time::timeout(flush_interval, msg_fut).await {
                Ok(m) => m,
                Err(_) => {
                    flush_batch(&session, source, opts.tag.as_deref(), &mut buf);
                    last_flush = std::time::Instant::now();
                    continue;
                }
            }
        } else {
            msg_fut.await
        };

        match msg {
            Some(ChannelMsg::Data { data }) => {
                for line in split_lines(&data) {
                    push_or_emit(
                        &session,
                        source,
                        opts.tag.as_deref(),
                        Level::Info,
                        line,
                        opts.batch,
                        &mut buf,
                        &mut last_flush,
                        flush_interval,
                    );
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                // stderr
                for line in split_lines(&data) {
                    push_or_emit(
                        &session,
                        source,
                        opts.tag.as_deref(),
                        Level::Warn,
                        line,
                        opts.batch,
                        &mut buf,
                        &mut last_flush,
                        flush_interval,
                    );
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit = exit_status as i32;
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }

    // Drain any trailing batched lines.
    if !buf.is_empty() {
        flush_batch(&session, source, opts.tag.as_deref(), &mut buf);
    }

    Ok(StreamedResult { exit })
}

/// Run a short command and capture stdout/stderr into memory. Used by
/// the capability probe and any other "just tell me the output" callers.
/// `limit` caps either stream to avoid runaway allocations.
pub async fn run_capturing(
    session: Arc<SshSession>,
    working_dir: Option<&str>,
    argv: &[String],
    limit: usize,
) -> AppResult<(String, String, ExitCode)> {
    let command = match working_dir {
        Some(dir) => cd_and(dir, argv),
        None => crate::ssh::quote::quote_argv(argv),
    };
    let (mut channel, _) = open_channel(&session, &command, false).await?;

    let mut stdout = Vec::<u8>::new();
    let mut stderr = Vec::<u8>::new();
    let mut exit: ExitCode = -1;

    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                if stdout.len() < limit {
                    stdout.extend_from_slice(&data[..data.len().min(limit - stdout.len())]);
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                if stderr.len() < limit {
                    stderr.extend_from_slice(&data[..data.len().min(limit - stderr.len())]);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit = exit_status as i32;
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }

    Ok((
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
        exit,
    ))
}

/// Same as [`run_streaming`] but always allocates a PTY. Use for `sudo`.
pub async fn run_with_pty(
    session: Arc<SshSession>,
    working_dir: Option<&str>,
    argv: &[String],
    source: &'static str,
) -> AppResult<StreamedResult> {
    run_streaming(
        session,
        working_dir,
        argv,
        source,
        ExecOpts {
            pty: true,
            ..Default::default()
        },
        None,
    )
    .await
}

// --- internals ---

/// PATH preamble prepended to every remote command. SSH exec channels
/// don't source the user's login profile, so their `PATH` is whatever
/// sshd hands out (often `/usr/bin:/bin` only). That misses common
/// install locations for docker (`/usr/local/bin`) and Homebrew
/// (`/home/linuxbrew/.linuxbrew/bin`). Prepend a sane default plus the
/// user's `$HOME/.local/bin` and keep whatever the server provided.
const PATH_PREAMBLE: &str = concat!(
    "export PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:",
    "/sbin:/bin:$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:${PATH}\"; "
);

async fn open_channel(
    session: &Arc<SshSession>,
    command: &str,
    pty: bool,
) -> AppResult<(russh::Channel<russh::client::Msg>, ())> {
    let mut handle = session.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;
    drop(handle);

    if pty {
        channel
            .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| AppError::Ssh(format!("request_pty: {e}")))?;
    }
    let full = format!("{PATH_PREAMBLE}{command}");
    channel
        .exec(true, full)
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;
    Ok((channel, ()))
}

fn split_lines(data: &[u8]) -> Vec<String> {
    // Split on \n — keep CR since it's common in PTY output and harmless.
    String::from_utf8_lossy(data)
        .split_inclusive('\n')
        .filter(|l| !l.is_empty())
        .map(|l| l.trim_end_matches('\n').trim_end_matches('\r').to_string())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn push_or_emit(
    session: &Arc<SshSession>,
    source: &'static str,
    tag: Option<&str>,
    level: Level,
    line: String,
    batch: bool,
    buf: &mut Vec<(Level, String)>,
    last_flush: &mut std::time::Instant,
    interval: std::time::Duration,
) {
    if batch {
        buf.push((level, line));
        if last_flush.elapsed() >= interval {
            flush_batch(session, source, tag, buf);
            *last_flush = std::time::Instant::now();
        }
    } else {
        activity::emit(&session.app, level, source, line, Some(&session.id), tag);
    }
}

fn flush_batch(
    session: &Arc<SshSession>,
    source: &'static str,
    tag: Option<&str>,
    buf: &mut Vec<(Level, String)>,
) {
    if buf.is_empty() {
        return;
    }
    let drained: Vec<(Level, String)> = std::mem::take(buf);
    activity::emit_batch(&session.app, source, tag, &drained, Some(&session.id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_handles_multiple_newlines() {
        let out = split_lines(b"a\nb\nc\n");
        assert_eq!(out, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn split_lines_strips_crlf() {
        let out = split_lines(b"windows\r\nline\r\n");
        assert_eq!(out, vec!["windows".to_string(), "line".to_string()]);
    }

    #[test]
    fn split_lines_drops_trailing_empty() {
        let out = split_lines(b"one\ntwo");
        assert_eq!(out, vec!["one".to_string(), "two".to_string()]);
    }
}

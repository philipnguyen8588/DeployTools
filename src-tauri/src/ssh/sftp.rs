//! SFTP subsystem wrapper used by the remote file browser and by
//! single-file deploy.
//!
//! All paths are POSIX-style (server side). We normalize and reject
//! traversal attempts (`..` components, null bytes) in the commands
//! layer before calling into this module.

use std::path::Path;
use std::sync::Arc;

use futures::stream::{FuturesUnordered, StreamExt};
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

/// SFTP write chunk size. 255 KiB is the largest OpenSSH accepts in one
/// WRITE packet by default (`limits@openssh.com` write_len), so this is
/// the biggest safe chunk.
const UPLOAD_CHUNK: usize = 255 * 1024;
/// How many WRITE requests to keep in flight at once. Pipelining fills the
/// SSH channel's send window instead of stalling one-RTT per chunk, which
/// is the whole point — a single-request-at-a-time upload caps out around
/// chunk/RTT (~1 MB/s on a 50 ms link) regardless of bandwidth.
const UPLOAD_INFLIGHT: usize = 16;

use crate::errors::{AppError, AppResult};
use crate::ssh::activity;
use crate::ssh::session_pool::SshSession;

/// One item that failed during a batch transfer (upload or download).
#[derive(serde::Serialize, Clone)]
pub struct FailedItem {
    /// The path that failed (remote path — the thing the user asked to
    /// transfer).
    pub path: String,
    /// Human-readable error message.
    pub error: String,
}

/// Outcome of a fault-tolerant batch transfer: how many landed, which
/// failed (skipped), and whether it stopped early due to cancellation.
#[derive(serde::Serialize, Clone, Default)]
pub struct BatchStats {
    pub ok: u32,
    pub failed: Vec<FailedItem>,
    pub cancelled: bool,
}

/// Directory / file entry returned from `list`.
#[derive(serde::Serialize, Clone)]
pub struct RemoteEntry {
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix mtime in seconds.
    pub mtime: Option<u64>,
    /// Octal mode, e.g. "0755". Present when available.
    pub mode: Option<String>,
}

/// Open (or reuse) the SFTP subsystem for this session. Each call gets
/// a fresh SFTP channel — russh-sftp is cheap to open and avoids
/// locking contention across concurrent file operations.
pub async fn open_sftp(session: &SshSession) -> AppResult<Arc<Mutex<SftpSession>>> {
    let mut handle = session.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("sftp channel: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("request sftp: {e}")))?;
    drop(handle);
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::Sftp(format!("sftp init: {e}")))?;
    Ok(Arc::new(Mutex::new(sftp)))
}

pub async fn list(session: &SshSession, path: &str) -> AppResult<Vec<RemoteEntry>> {
    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;

    let entries = sftp
        .read_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("read_dir {path}: {e}")))?;

    let base = path.trim_end_matches('/');
    let mut out = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs: FileAttributes = entry.metadata();
        let full = format!("{base}/{name}");
        out.push(RemoteEntry {
            name,
            full_path: full,
            is_dir: attrs.is_dir(),
            is_symlink: attrs.is_symlink(),
            size: attrs.size.unwrap_or(0),
            mtime: attrs.mtime.map(|m| m as u64),
            mode: attrs.permissions.map(|p| format!("{:04o}", p & 0o7777)),
        });
    }
    // Directories first, then alpha.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

pub async fn mkdir(session: &SshSession, path: &str) -> AppResult<()> {
    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;
    // Emulate `mkdir -p` by walking components.
    let mut acc = String::new();
    for comp in path.trim_start_matches('/').split('/') {
        if comp.is_empty() {
            continue;
        }
        if !acc.is_empty() || path.starts_with('/') {
            acc.push('/');
        }
        acc.push_str(comp);
        // Ignore "already exists" errors.
        let _ = sftp.create_dir(&acc).await;
    }
    activity::info(
        &session.app,
        "sftp",
        format!("mkdir -p {path}"),
        Some(&session.id),
    );
    Ok(())
}

pub async fn remove(session: &SshSession, path: &str, recursive: bool) -> AppResult<()> {
    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;
    let meta = sftp
        .metadata(path)
        .await
        .map_err(|e| AppError::Sftp(format!("stat {path}: {e}")))?;
    if meta.is_dir() {
        if !recursive {
            return Err(AppError::Sftp(format!("{path} is a directory")));
        }
        remove_dir_recursive(&sftp, path).await?;
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|e| AppError::Sftp(format!("remove {path}: {e}")))?;
    }
    activity::success(
        &session.app,
        "sftp",
        format!("removed {path}"),
        Some(&session.id),
    );
    Ok(())
}

async fn remove_dir_recursive(sftp: &SftpSession, path: &str) -> AppResult<()> {
    // Non-recursive async function can't easily recurse without boxing —
    // use an explicit stack.
    let mut stack = vec![path.to_string()];
    let mut to_rm_dirs = Vec::<String>::new();
    while let Some(dir) = stack.pop() {
        to_rm_dirs.push(dir.clone());
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| AppError::Sftp(format!("read_dir {dir}: {e}")))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full = format!("{}/{name}", dir.trim_end_matches('/'));
            let attrs: FileAttributes = entry.metadata();
            if attrs.is_dir() {
                stack.push(full);
            } else {
                sftp.remove_file(&full)
                    .await
                    .map_err(|e| AppError::Sftp(format!("remove {full}: {e}")))?;
            }
        }
    }
    // Remove directories bottom-up.
    for dir in to_rm_dirs.into_iter().rev() {
        sftp.remove_dir(&dir)
            .await
            .map_err(|e| AppError::Sftp(format!("rmdir {dir}: {e}")))?;
    }
    Ok(())
}

/// Remove many remote paths over a SINGLE SFTP channel — the batch
/// counterpart of `remove()`, used by the sync delete phase. Items are
/// `(full_path, is_dir)` processed in slice order (the caller sorts
/// deep-first), trusting the caller's `is_dir` instead of a per-path
/// `stat` round-trip. Per-item failures are reported through `on_item`
/// with an error message and do NOT abort the batch (sync's
/// warn-and-continue semantics). Returns the number successfully removed.
pub async fn remove_batch(
    session: &SshSession,
    items: &[(String, bool)],
    mut on_item: impl FnMut(u32, &str, Option<&str>),
    should_cancel: impl Fn() -> bool,
) -> AppResult<u32> {
    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;
    let mut deleted = 0u32;
    for (path, is_dir) in items {
        if should_cancel() {
            break;
        }
        let res: AppResult<()> = if *is_dir {
            remove_dir_recursive(&sftp, path).await
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|e| AppError::Sftp(format!("remove {path}: {e}")))
        };
        match res {
            Ok(()) => {
                deleted += 1;
                on_item(deleted, path, None);
            }
            Err(e) => {
                let msg = e.to_string();
                on_item(deleted, path, Some(&msg));
            }
        }
    }
    activity::success(
        &session.app,
        "sftp",
        format!("removed {deleted}/{} paths", items.len()),
        Some(&session.id),
    );
    Ok(deleted)
}

pub async fn rename(session: &SshSession, from: &str, to: &str) -> AppResult<()> {
    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;
    sftp.rename(from, to)
        .await
        .map_err(|e| AppError::Sftp(format!("rename: {e}")))?;
    activity::success(
        &session.app,
        "sftp",
        format!("renamed {from} -> {to}"),
        Some(&session.id),
    );
    Ok(())
}

/// Open a low-level `RawSftpSession` on a fresh SFTP channel. Uploads use
/// this instead of the high-level `SftpSession` so they can pipeline many
/// `write` requests concurrently (the high-level `File` AsyncWrite issues
/// one WRITE at a time and awaits its ACK — the slow path).
async fn open_raw_sftp(session: &SshSession) -> AppResult<RawSftpSession> {
    let handle = session.handle.lock().await;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("sftp channel: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("request sftp: {e}")))?;
    drop(handle);
    let raw = RawSftpSession::new(channel.into_stream());
    raw.init()
        .await
        .map_err(|e| AppError::Sftp(format!("sftp init: {e}")))?;
    Ok(raw)
}

/// `mkdir -p` over a raw session. Best-effort — "already exists" errors are
/// ignored (SFTP has no MKDIR-if-not-exists).
async fn mkdir_raw(raw: &RawSftpSession, path: &str) {
    let mut acc = String::new();
    for comp in path.trim_start_matches('/').split('/') {
        if comp.is_empty() {
            continue;
        }
        if !acc.is_empty() || path.starts_with('/') {
            acc.push('/');
        }
        acc.push_str(comp);
        let _ = raw.mkdir(acc.clone(), FileAttributes::default()).await;
    }
}

/// Read up to `buf.len()` bytes, looping over short reads so every chunk
/// but the last is a full `UPLOAD_CHUNK` (fewer, larger WRITE packets).
async fn fill(f: &mut tokio::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = f.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Upload one file over an already-open raw session, pipelining up to
/// `UPLOAD_INFLIGHT` WRITE requests. The caller must ensure the parent
/// directory exists (see `upload` / `upload_batch`).
async fn upload_raw(
    raw: &RawSftpSession,
    session: &SshSession,
    local_path: &Path,
    remote_path: &str,
) -> AppResult<()> {
    let total = tokio::fs::metadata(local_path).await?.len();
    let handle = raw
        .open(
            remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            FileAttributes::default(),
        )
        .await
        .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?
        .handle;

    activity::info(
        &session.app,
        "sftp",
        format!("↑ upload {} → {remote_path} ({total} bytes)", local_path.display()),
        Some(&session.id),
    );

    let mut local = tokio::fs::File::open(local_path).await?;
    let progress_event = format!("sftp-progress://{}", session.id);
    let mut offset: u64 = 0;
    let mut written: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut done_reading = false;
    let mut inflight = FuturesUnordered::new();

    // Any pipelined write error must still let us close the handle.
    let result: AppResult<()> = async {
        while !done_reading || !inflight.is_empty() {
            // Top up the pipeline.
            while inflight.len() < UPLOAD_INFLIGHT && !done_reading {
                let mut buf = vec![0u8; UPLOAD_CHUNK];
                let n = fill(&mut local, &mut buf).await?;
                if n == 0 {
                    done_reading = true;
                    break;
                }
                buf.truncate(n);
                let off = offset;
                offset += n as u64;
                let h = handle.clone();
                inflight.push(async move {
                    raw.write(h, off, buf)
                        .await
                        .map(|_| n as u64)
                        .map_err(|e| AppError::Sftp(format!("write: {e}")))
                });
            }
            if let Some(res) = inflight.next().await {
                written += res?;
                if written - last_emit >= 1024 * 1024
                    || (done_reading && inflight.is_empty())
                {
                    last_emit = written;
                    let _ = session.app.emit(
                        &progress_event,
                        ProgressEvent {
                            phase: "upload",
                            path: remote_path.to_string(),
                            written,
                            total,
                        },
                    );
                }
            }
        }
        Ok(())
    }
    .await;

    // Close deterministically (awaited) so the write is committed before we
    // return — best-effort on the error path.
    let close = raw
        .close(handle)
        .await
        .map_err(|e| AppError::Sftp(format!("close: {e}")));
    result?;
    close?;

    activity::success(
        &session.app,
        "sftp",
        format!("✓ uploaded {remote_path}"),
        Some(&session.id),
    );
    Ok(())
}

/// Upload a local file to a remote path. Creates parent dirs if needed.
/// Emits `sftp-progress://{session_id}` events while copying. Opens a
/// dedicated raw session for the transfer.
pub async fn upload(
    session: &SshSession,
    local_path: &Path,
    remote_path: &str,
) -> AppResult<()> {
    let raw = open_raw_sftp(session).await?;
    if let Some(parent) = parent_of(remote_path) {
        if !parent.is_empty() && parent != "/" {
            mkdir_raw(&raw, parent).await;
        }
    }
    upload_raw(&raw, session, local_path, remote_path).await
}

/// Upload many files over a SINGLE raw session (one channel + one SFTP
/// handshake for the whole batch, instead of per file).
///
/// **Fault-tolerant:** a file that fails (permission denied, unreadable
/// local file, …) is logged as a red activity line, recorded in
/// `BatchStats.failed`, and SKIPPED — the batch continues. Only a failure
/// to open the SFTP channel itself (dead session) aborts with `Err`.
///
/// `on_file` is called with the running SUCCESS count after each
/// successful upload; return `true` from `should_cancel` to stop early.
pub async fn upload_batch(
    session: &SshSession,
    files: &[(std::path::PathBuf, String)],
    mut on_file: impl FnMut(u32, &str),
    should_cancel: impl Fn() -> bool,
) -> AppResult<BatchStats> {
    let raw = open_raw_sftp(session).await?;

    // Pre-create every unique parent directory once (shallow → deep so
    // ancestors come first), instead of `mkdir -p` per file.
    let mut dirs: Vec<&str> = files
        .iter()
        .filter_map(|(_, remote)| parent_of(remote))
        .filter(|p| !p.is_empty() && *p != "/")
        .collect();
    dirs.sort_unstable();
    dirs.dedup();
    for d in dirs {
        mkdir_raw(&raw, d).await;
    }

    let mut stats = BatchStats::default();
    for (local, remote) in files {
        if should_cancel() {
            stats.cancelled = true;
            break;
        }
        match upload_raw(&raw, session, local, remote).await {
            Ok(()) => {
                stats.ok += 1;
                on_file(stats.ok, remote);
            }
            Err(e) => {
                let msg = e.to_string();
                activity::error(
                    &session.app,
                    "sftp",
                    format!("✗ upload {remote}: {msg}"),
                    Some(&session.id),
                );
                stats.failed.push(FailedItem {
                    path: remote.clone(),
                    error: msg,
                });
            }
        }
    }

    if !stats.failed.is_empty() {
        let list = stats
            .failed
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        activity::error(
            &session.app,
            "sftp",
            format!("✗ {} file(s) failed to upload: {list}", stats.failed.len()),
            Some(&session.id),
        );
    }
    Ok(stats)
}

pub async fn download(
    session: &SshSession,
    remote_path: &str,
    local_path: &Path,
) -> AppResult<()> {
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;

    let mut remote = sftp
        .open_with_flags(remote_path, OpenFlags::READ)
        .await
        .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
    let total = sftp
        .metadata(remote_path)
        .await
        .ok()
        .and_then(|a| a.size)
        .unwrap_or(0);

    let mut local = tokio::fs::File::create(local_path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut read_total: u64 = 0;

    activity::info(
        &session.app,
        "sftp",
        format!(
            "↓ download {remote_path} → {} ({} bytes)",
            local_path.display(),
            total
        ),
        Some(&session.id),
    );

    let progress_event = format!("sftp-progress://{}", session.id);
    loop {
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Sftp(format!("read: {e}")))?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await?;
        read_total += n as u64;
        let _ = session.app.emit(
            &progress_event,
            ProgressEvent {
                phase: "download",
                path: remote_path.to_string(),
                written: read_total,
                total,
            },
        );
    }
    local.flush().await?;
    activity::success(
        &session.app,
        "sftp",
        format!("✓ downloaded {remote_path}"),
        Some(&session.id),
    );
    Ok(())
}

/// Download a remote path (file OR directory) to an exact local target.
///
/// For a file, `local_target` is the destination file path. For a
/// directory, `local_target` is the destination directory — the tree is
/// recreated underneath it.
///
/// **Fault-tolerant:** a file that can't be read/written (permission,
/// stat failure, …) is logged as a red activity line and SKIPPED — the
/// rest of the tree continues. Returns `(written, failed)` counts. Only a
/// failure to open the SFTP channel itself (dead session) aborts `Err`.
pub fn download_tree<'a>(
    session: &'a SshSession,
    remote_path: &'a str,
    local_target: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<(u32, u32)>> + Send + 'a>> {
    Box::pin(async move {
        // Determine whether the remote path is a directory. A stat failure
        // (permission, vanished) counts as one skipped item, not a fatal.
        let is_dir = {
            let sftp = open_sftp(session).await?;
            let sftp = sftp.lock().await;
            match sftp.metadata(remote_path).await {
                Ok(attrs) => attrs.is_dir(),
                Err(e) => {
                    activity::error(
                        &session.app,
                        "sftp",
                        format!("✗ download {remote_path}: stat: {e}"),
                        Some(&session.id),
                    );
                    return Ok((0, 1));
                }
            }
        };

        if !is_dir {
            return match download(session, remote_path, local_target).await {
                Ok(()) => Ok((1, 0)),
                Err(e) => {
                    activity::error(
                        &session.app,
                        "sftp",
                        format!("✗ download {remote_path}: {e}"),
                        Some(&session.id),
                    );
                    Ok((0, 1))
                }
            };
        }

        if let Err(e) = tokio::fs::create_dir_all(local_target).await {
            activity::error(
                &session.app,
                "sftp",
                format!("✗ download {remote_path}: mkdir local: {e}"),
                Some(&session.id),
            );
            return Ok((0, 1));
        }

        // Read the directory listing (fresh channel, dropped before recursion).
        let children: Vec<(String, bool)> = {
            let sftp = open_sftp(session).await?;
            let sftp = sftp.lock().await;
            match sftp.read_dir(remote_path).await {
                Ok(entries) => entries
                    .into_iter()
                    .filter_map(|entry| {
                        let name = entry.file_name();
                        if name == "." || name == ".." {
                            return None;
                        }
                        Some((name, entry.metadata().is_dir()))
                    })
                    .collect(),
                Err(e) => {
                    activity::error(
                        &session.app,
                        "sftp",
                        format!("✗ download {remote_path}: read_dir: {e}"),
                        Some(&session.id),
                    );
                    return Ok((0, 1));
                }
            }
        };

        let mut written = 0u32;
        let mut failed = 0u32;
        for (name, _child_is_dir) in children {
            let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), name);
            let child_local = local_target.join(&name);
            let (w, f) = download_tree(session, &child_remote, &child_local).await?;
            written += w;
            failed += f;
        }
        Ok((written, failed))
    })
}

#[derive(serde::Serialize, Clone)]
pub struct ProgressEvent {
    pub phase: &'static str,
    pub path: String,
    pub written: u64,
    pub total: u64,
}

fn parent_of(p: &str) -> Option<&str> {
    let trimmed = p.trim_end_matches('/');
    trimmed.rsplit_once('/').map(|(a, _)| a)
}

/// Reject absolute paths containing `..` segments or null bytes.
/// Callers must invoke this on any user-supplied remote path.
pub fn validate_remote_path(p: &str) -> AppResult<()> {
    if p.contains('\0') {
        return Err(AppError::InvalidPath("null byte".into()));
    }
    for seg in p.split('/') {
        if seg == ".." {
            return Err(AppError::InvalidPath(format!(
                "path traversal not allowed: {p}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal() {
        assert!(validate_remote_path("/var/www/../etc/passwd").is_err());
        assert!(validate_remote_path("/var/www/ok").is_ok());
    }
    #[test]
    fn parent_of_works() {
        assert_eq!(parent_of("/a/b/c.txt"), Some("/a/b"));
        assert_eq!(parent_of("/a/b/"), Some("/a"));
    }
}

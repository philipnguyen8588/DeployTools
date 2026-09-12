//! SFTP subsystem wrapper used by the remote file browser and by
//! single-file deploy.
//!
//! All paths are POSIX-style (server side). We normalize and reject
//! traversal attempts (`..` components, null bytes) in the commands
//! layer before calling into this module.

use std::path::Path;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::errors::{AppError, AppResult};
use crate::ssh::activity;
use crate::ssh::session_pool::SshSession;

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

/// Upload a local file to a remote path. Creates parent dirs if needed.
/// Emits `sftp-progress://{session_id}` events while copying.
pub async fn upload(
    session: &SshSession,
    local_path: &Path,
    remote_path: &str,
) -> AppResult<()> {
    // Ensure parent dir exists.
    if let Some(parent) = parent_of(remote_path) {
        if !parent.is_empty() && parent != "/" {
            mkdir(session, parent).await?;
        }
    }

    let sftp = open_sftp(session).await?;
    let sftp = sftp.lock().await;

    let mut remote = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;

    let total = tokio::fs::metadata(local_path).await?.len();
    let mut local = tokio::fs::File::open(local_path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;

    activity::info(
        &session.app,
        "sftp",
        format!(
            "↑ upload {} → {remote_path} ({} bytes)",
            local_path.display(),
            total
        ),
        Some(&session.id),
    );

    let progress_event = format!("sftp-progress://{}", session.id);
    loop {
        let n = local.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Sftp(format!("write: {e}")))?;
        written += n as u64;
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
    remote
        .flush()
        .await
        .map_err(|e| AppError::Sftp(format!("flush: {e}")))?;
    activity::success(
        &session.app,
        "sftp",
        format!("✓ uploaded {remote_path}"),
        Some(&session.id),
    );
    Ok(())
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
/// recreated underneath it. Returns the number of files downloaded.
pub fn download_tree<'a>(
    session: &'a SshSession,
    remote_path: &'a str,
    local_target: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<u32>> + Send + 'a>> {
    Box::pin(async move {
        // Determine whether the remote path is a directory.
        let is_dir = {
            let sftp = open_sftp(session).await?;
            let sftp = sftp.lock().await;
            match sftp.metadata(remote_path).await {
                Ok(attrs) => attrs.is_dir(),
                Err(e) => {
                    return Err(AppError::Sftp(format!("stat {remote_path}: {e}")));
                }
            }
        };

        if !is_dir {
            download(session, remote_path, local_target).await?;
            return Ok(1);
        }

        tokio::fs::create_dir_all(local_target).await?;

        // Read the directory listing (fresh channel, dropped before recursion).
        let children: Vec<(String, bool)> = {
            let sftp = open_sftp(session).await?;
            let sftp = sftp.lock().await;
            let entries = sftp
                .read_dir(remote_path)
                .await
                .map_err(|e| AppError::Sftp(format!("read_dir {remote_path}: {e}")))?;
            entries
                .into_iter()
                .filter_map(|entry| {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        return None;
                    }
                    Some((name, entry.metadata().is_dir()))
                })
                .collect()
        };

        let mut count = 0u32;
        for (name, _child_is_dir) in children {
            let child_remote = format!("{}/{}", remote_path.trim_end_matches('/'), name);
            let child_local = local_target.join(&name);
            count += download_tree(session, &child_remote, &child_local).await?;
        }
        Ok(count)
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

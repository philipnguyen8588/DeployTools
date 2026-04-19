//! FTP client wrapper used when a `Server.protocol` is FTP.
//!
//! We use `suppaftp` in its async flavour. FTPS support is deferred —
//! the UI still accepts `Protocol::Ftps` but we currently refuse the
//! session at connect time. Adding it later only requires wiring a
//! rustls/native-tls connector into [`FtpSession::connect`].

use std::path::Path;
use std::time::Duration;

// NOTE: suppaftp's async data streams implement `futures::io::Async{Read,Write}`,
// NOT tokio's. We pull `futures_util::AsyncReadExt/WriteExt` for those
// reads/writes, and use tokio's extension traits for local-file I/O.
use futures_util::{AsyncReadExt as FutRead, AsyncWriteExt as FutWrite};
use serde::Serialize;
use suppaftp::{list::File, list::PosixPexQuery, AsyncFtpStream};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::errors::{AppError, AppResult};
use crate::models::{AuthMethod, Protocol, Server};
use crate::ssh::activity;

/// An open FTP control connection, guarded by a mutex because the
/// underlying protocol is single-threaded.
pub struct FtpSession {
    pub stream: tokio::sync::Mutex<AsyncFtpStream>,
}

impl FtpSession {
    pub async fn connect(server: &Server) -> AppResult<Self> {
        if matches!(server.protocol, Protocol::Ftps) {
            return Err(AppError::FeatureUnavailable(
                "FTPS not yet supported — use plain FTP for now".into(),
            ));
        }
        let addr = format!("{}:{}", server.host, server.port);
        let connect = tokio::time::timeout(
            Duration::from_secs(15),
            AsyncFtpStream::connect(&addr),
        )
        .await
        .map_err(|_| AppError::Other(format!("ftp connect: timed out on {addr}")))?;
        let mut stream =
            connect.map_err(|e| AppError::Other(format!("ftp connect: {e}")))?;

        let password = match &server.auth {
            AuthMethod::Password { password } => password.clone(),
            AuthMethod::PrivateKey { .. } => {
                return Err(AppError::Other(
                    "FTP does not support key-based authentication".into(),
                ));
            }
        };
        // Anonymous FTP: empty user → "anonymous" + (empty password OK).
        // Many public FTP hosts only accept literal "anonymous" / "ftp".
        let user = if server.user.is_empty() {
            "anonymous"
        } else {
            server.user.as_str()
        };
        stream
            .login(user, password.expose())
            .await
            .map_err(|e| AppError::Other(format!("ftp login: {e}")))?;
        // Binary transfer mode — mandatory for reliable non-text uploads.
        let _ = stream
            .transfer_type(suppaftp::types::FileType::Binary)
            .await;

        Ok(FtpSession {
            stream: tokio::sync::Mutex::new(stream),
        })
    }

    pub async fn quit(self) {
        if let Ok(mut s) = self.stream.try_lock() {
            let _ = s.quit().await;
        }
    }
}

/// Wire type — shape mirrors `ssh::sftp::RemoteEntry` so the sftp
/// commands layer can translate one to the other without field work.
#[derive(Serialize, Clone)]
pub struct RemoteEntry {
    pub name: String,
    pub full_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    pub mode: Option<String>,
}

pub async fn list(session: &FtpSession, path: &str) -> AppResult<Vec<RemoteEntry>> {
    let mut s = session.stream.lock().await;
    s.cwd(path)
        .await
        .map_err(|e| AppError::Other(format!("ftp cwd {path}: {e}")))?;
    let raw = s
        .list(None)
        .await
        .map_err(|e| AppError::Other(format!("ftp list: {e}")))?;

    let base = path.trim_end_matches('/');
    let mut out = Vec::new();
    for line in raw {
        let f = match File::from_posix_line(&line) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if f.name() == "." || f.name() == ".." {
            continue;
        }
        let full = format!("{base}/{}", f.name());
        out.push(RemoteEntry {
            name: f.name().to_string(),
            full_path: full,
            is_dir: f.is_directory(),
            is_symlink: f.is_symlink(),
            size: f.size() as u64,
            mtime: Some(
                f.modified()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            ),
            mode: Some(format_mode(&f)),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

fn format_mode(f: &File) -> String {
    // Render a 9-char POSIX mode string: user/group/world × r/w/x.
    let bit = |ok: bool, ch: char| -> char {
        if ok {
            ch
        } else {
            '-'
        }
    };
    [PosixPexQuery::Owner, PosixPexQuery::Group, PosixPexQuery::Others]
        .into_iter()
        .flat_map(|who| {
            [
                bit(f.can_read(who), 'r'),
                bit(f.can_write(who), 'w'),
                bit(f.can_execute(who), 'x'),
            ]
        })
        .collect()
}

pub async fn mkdir(session: &FtpSession, path: &str) -> AppResult<()> {
    let mut s = session.stream.lock().await;
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
        let _ = s.mkdir(&acc).await;
    }
    Ok(())
}

pub async fn remove(session: &FtpSession, path: &str, recursive: bool) -> AppResult<()> {
    let mut s = session.stream.lock().await;
    if recursive {
        // Best-effort recursion: NLST + rm each child + RMD.
        if let Ok(children) = s.nlst(Some(path)).await {
            for child in children {
                let child_path = if child.starts_with('/') {
                    child
                } else {
                    format!("{}/{child}", path.trim_end_matches('/'))
                };
                if child_path == path
                    || child_path.ends_with("/.")
                    || child_path.ends_with("/..")
                {
                    continue;
                }
                let _ = s.rm(&child_path).await;
                let _ = s.rmdir(&child_path).await;
            }
        }
    }
    if s.rmdir(path).await.is_err() {
        s.rm(path)
            .await
            .map_err(|e| AppError::Other(format!("ftp rm {path}: {e}")))?;
    }
    Ok(())
}

pub async fn rename(session: &FtpSession, from: &str, to: &str) -> AppResult<()> {
    let mut s = session.stream.lock().await;
    s.rename(from, to)
        .await
        .map_err(|e| AppError::Other(format!("ftp rename: {e}")))?;
    Ok(())
}

pub async fn upload(
    session: &FtpSession,
    app: &tauri::AppHandle,
    session_id: &str,
    local_path: &Path,
    remote_path: &str,
) -> AppResult<()> {
    let total = tokio::fs::metadata(local_path).await?.len();
    let mut f = tokio::fs::File::open(local_path).await?;

    activity::info(
        app,
        "ftp",
        format!(
            "↑ upload {} → {remote_path} ({} bytes)",
            local_path.display(),
            total
        ),
        Some(session_id),
    );

    let mut s = session.stream.lock().await;
    let mut data = s
        .put_with_stream(remote_path)
        .await
        .map_err(|e| AppError::Other(format!("ftp STOR: {e}")))?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    let progress_event = format!("sftp-progress://{}", session_id);
    loop {
        // tokio::fs::File implements tokio::io::AsyncReadExt::read
        let n = AsyncReadExt::read(&mut f, &mut buf).await?;
        if n == 0 {
            break;
        }
        // data stream implements futures::AsyncWriteExt::write_all
        FutWrite::write_all(&mut data, &buf[..n])
            .await
            .map_err(|e| AppError::Other(format!("ftp write: {e}")))?;
        written += n as u64;
        let _ = app.emit(
            &progress_event,
            crate::ssh::sftp::ProgressEvent {
                phase: "upload",
                path: remote_path.to_string(),
                written,
                total,
            },
        );
    }
    s.finalize_put_stream(data)
        .await
        .map_err(|e| AppError::Other(format!("ftp finalize: {e}")))?;

    activity::success(
        app,
        "ftp",
        format!("✓ uploaded {remote_path}"),
        Some(session_id),
    );
    Ok(())
}

pub async fn download(
    session: &FtpSession,
    app: &tauri::AppHandle,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
) -> AppResult<()> {
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut s = session.stream.lock().await;
    let total = s.size(remote_path).await.unwrap_or(0) as u64;
    let mut data = s
        .retr_as_stream(remote_path)
        .await
        .map_err(|e| AppError::Other(format!("ftp RETR: {e}")))?;

    activity::info(
        app,
        "ftp",
        format!(
            "↓ download {remote_path} → {} ({} bytes)",
            local_path.display(),
            total
        ),
        Some(session_id),
    );

    let mut f = tokio::fs::File::create(local_path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut read_total: u64 = 0;
    let progress_event = format!("sftp-progress://{}", session_id);
    loop {
        let n = FutRead::read(&mut data, &mut buf)
            .await
            .map_err(|e| AppError::Other(format!("ftp read: {e}")))?;
        if n == 0 {
            break;
        }
        AsyncWriteExt::write_all(&mut f, &buf[..n]).await?;
        read_total += n as u64;
        let _ = app.emit(
            &progress_event,
            crate::ssh::sftp::ProgressEvent {
                phase: "download",
                path: remote_path.to_string(),
                written: read_total,
                total,
            },
        );
    }
    f.flush().await?;
    s.finalize_retr_stream(data)
        .await
        .map_err(|e| AppError::Other(format!("ftp finalize read: {e}")))?;
    activity::success(
        app,
        "ftp",
        format!("✓ downloaded {remote_path}"),
        Some(session_id),
    );
    Ok(())
}

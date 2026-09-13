//! Deploy commands — single file (SFTP) and full project (rsync).

use std::path::{Path, PathBuf};

use globset::{Glob, GlobSetBuilder};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::{Project, Server};
use crate::rsync::runner::{self, RsyncOptions};
use crate::ssh::{client, sftp, session_pool::SshSession};
use crate::state::AppState;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::Mutex;

/// Clock-skew tolerance (seconds) when comparing local vs remote mtimes
/// during sync. A same-size file is re-uploaded only if the local copy is
/// newer than the remote by more than this margin.
const MTIME_TOLERANCE_SECS: u64 = 2;

/// Deploy a single file via SFTP.
///
/// `relative_path` is relative to `project.local_path`. The corresponding
/// remote path is `project.remote_path` joined with the same relative bits.
#[tauri::command]
pub async fn deploy_file(
    project_id: Uuid,
    relative_path: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let (project, server) = resolve_project_server(&state, project_id).await?;

    // Resolve local absolute path and guard against escapes.
    let local_full = project.local_path.join(&relative_path);
    let canon_local = tokio::fs::canonicalize(&local_full).await?;
    let canon_base = tokio::fs::canonicalize(&project.local_path).await?;
    if !canon_local.starts_with(&canon_base) {
        return Err(AppError::InvalidPath(format!(
            "path escapes project root: {}",
            relative_path
        )));
    }

    let remote_rel = relative_path.replace('\\', "/");
    let remote_full = join_remote(&project.remote_path, &remote_rel);
    sftp::validate_remote_path(&remote_full)?;

    // Reuse an existing session if one was passed, otherwise open a
    // short-lived one just for this upload.
    let session = match session_id {
        Some(id) => state.sessions.get(&id)?,
        None => open_ephemeral(&state, &server, Some(project.clone())).await?,
    };

    sftp::upload(&session, &local_full, &remote_full).await
}

/// Recursively upload a local directory to its mirrored remote path.
///
/// Walks the local tree (respecting the project's exclude globs),
/// creates any missing remote directories, and uploads each file via
/// SFTP. Progress + per-file success/error is emitted as activity events.
#[tauri::command]
pub async fn deploy_folder(
    project_id: Uuid,
    relative_path: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<u32> {
    let (project, server) = resolve_project_server(&state, project_id).await?;

    // Validate local root lies inside project.local_path
    let local_root = project.local_path.join(&relative_path);
    let canon_local_root = tokio::fs::canonicalize(&local_root).await?;
    let canon_base = tokio::fs::canonicalize(&project.local_path).await?;
    if !canon_local_root.starts_with(&canon_base) {
        return Err(AppError::InvalidPath(format!(
            "path escapes project root: {relative_path}"
        )));
    }

    // Compile excludes
    let globs = build_globset(&project.excludes)?;

    // Walk the local tree to build a file list (relative paths).
    let mut files: Vec<String> = Vec::new();
    walk_local_files(
        &canon_local_root,
        &canon_local_root,
        &globs,
        &mut files,
    )
    .await?;

    // Resolve remote base for this sub-tree.
    let rel_trimmed = relative_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    let remote_root = if rel_trimmed.is_empty() {
        project.remote_path.trim_end_matches('/').to_string()
    } else {
        join_remote(&project.remote_path, &rel_trimmed)
    };
    crate::ssh::sftp::validate_remote_path(&remote_root)?;

    // Reuse existing session or open a short-lived one.
    let session = match session_id {
        Some(id) => state.sessions.get(&id)?,
        None => open_ephemeral(&state, &server, Some(project.clone())).await?,
    };

    crate::ssh::activity::info(
        &state.app,
        "sftp",
        format!(
            "↑ upload folder {} → {remote_root} ({} files)",
            canon_local_root.display(),
            files.len()
        ),
        Some(&session.id),
    );

    // Upload each file, creating parent dirs as needed (mkdir -p is cheap).
    let mut uploaded: u32 = 0;
    for rel in &files {
        let local_full = canon_local_root.join(rel);
        let remote_full = if remote_root.is_empty() {
            rel.clone()
        } else {
            format!("{}/{}", remote_root.trim_end_matches('/'), rel)
        };
        if let Err(e) = crate::ssh::sftp::upload(&session, &local_full, &remote_full).await {
            crate::ssh::activity::error(
                &state.app,
                "sftp",
                format!("✗ {remote_full}: {e}"),
                Some(&session.id),
            );
            return Err(e);
        }
        uploaded += 1;
    }

    crate::ssh::activity::success(
        &state.app,
        "sftp",
        format!("✓ folder upload done ({uploaded} files → {remote_root})"),
        Some(&session.id),
    );

    Ok(uploaded)
}

/// Walk a local directory, collecting relative file paths (files only),
/// honoring the exclude glob set.
fn walk_local_files<'a>(
    root: &'a Path,
    current: &'a Path,
    globs: &'a globset::GlobSet,
    out: &'a mut Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        let mut rd = tokio::fs::read_dir(current).await?;
        while let Some(e) = rd.next_entry().await? {
            let path = e.path();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let name_match = path
                .file_name()
                .map(|n| globs.is_match(n))
                .unwrap_or(false);
            if globs.is_match(&rel) || name_match {
                continue;
            }
            let md = e.metadata().await?;
            if md.is_dir() {
                walk_local_files(root, &path, globs, out).await?;
            } else if md.is_file() {
                out.push(rel);
            }
        }
        Ok(())
    })
}

/// Result of a batch download.
#[derive(Serialize, Clone)]
pub struct DownloadStats {
    /// Total files written locally.
    pub downloaded: u32,
    /// Top-level paths skipped because they lie outside the project's
    /// remote base (so they have no mapped local destination).
    pub skipped: u32,
}

/// Download one or more remote paths straight into the project's mapped
/// local folder (mirror of `project.local_path`). Each remote path is
/// resolved relative to `project.remote_path`; anything outside that base
/// is skipped and counted. Files + directories are supported (recursive).
#[tauri::command]
pub async fn download_to_mapped(
    project_id: Uuid,
    session_id: String,
    remote_paths: Vec<String>,
    state: State<'_, AppState>,
) -> AppResult<DownloadStats> {
    let (project, _) = resolve_project_server(&state, project_id).await?;
    let session = state.sessions.get(&session_id)?;

    let base = project.remote_path.trim_end_matches('/').to_string();
    let mut downloaded = 0u32;
    let mut skipped = 0u32;

    for remote in &remote_paths {
        crate::ssh::sftp::validate_remote_path(remote)?;
        let trimmed = remote.trim_end_matches('/');

        // Path relative to the project's remote base.
        let rel = if trimmed == base {
            String::new()
        } else if let Some(stripped) = trimmed.strip_prefix(&format!("{base}/")) {
            stripped.to_string()
        } else {
            skipped += 1;
            crate::ssh::activity::warn(
                &state.app,
                "sftp",
                format!("skip (outside mapped folder): {remote}"),
                Some(&session.id),
            );
            continue;
        };

        // `rel` is derived from a validated remote path (no `..`), so the
        // join always stays within project.local_path.
        let local_target = if rel.is_empty() {
            project.local_path.clone()
        } else {
            project.local_path.join(&rel)
        };

        downloaded += crate::ssh::sftp::download_tree(&session, remote, &local_target).await?;
    }

    Ok(DownloadStats {
        downloaded,
        skipped,
    })
}

/// Download a single remote path (file or directory) into a chosen local
/// directory, preserving the remote basename. Returns files written.
#[tauri::command]
pub async fn download_to(
    session_id: String,
    remote_path: String,
    local_dir: String,
    state: State<'_, AppState>,
) -> AppResult<u32> {
    crate::ssh::sftp::validate_remote_path(&remote_path)?;
    let session = state.sessions.get(&session_id)?;
    let base = remote_basename(&remote_path);
    let target = Path::new(&local_dir).join(base);
    crate::ssh::sftp::download_tree(&session, &remote_path, &target).await
}

/// Native SFTP sync — a pure-Rust "rsync-lite" that works without any
/// external binary. Compares local and remote trees by size + mtime and
/// uploads only what changed. Optionally deletes remote files that no
/// longer exist locally (`delete_extraneous`).
///
/// This is what the Deploy button uses by default on systems without
/// rsync installed.
#[tauri::command]
pub async fn deploy_sync(
    project_id: Uuid,
    session_id: Option<String>,
    delete_extraneous: bool,
    state: State<'_, AppState>,
) -> AppResult<SyncStats> {
    let (project, server) = resolve_project_server(&state, project_id).await?;

    // Compile excludes
    let globs = build_globset(&project.excludes)?;

    let canon_root = tokio::fs::canonicalize(&project.local_path).await?;

    // Session
    let session = match session_id {
        Some(id) => state.sessions.get(&id)?,
        None => open_ephemeral(&state, &server, Some(project.clone())).await?,
    };
    let sid = session.id.clone();

    crate::ssh::activity::info(
        &state.app,
        "sync",
        format!(
            "scanning {} ↔ {} …",
            canon_root.display(),
            project.remote_path
        ),
        Some(&sid),
    );

    // Walk local
    let mut local_map: std::collections::HashMap<String, WalkEntry> = Default::default();
    walk_local(&canon_root, &canon_root, &globs, &mut local_map).await?;

    // Walk remote
    let remote_root = project.remote_path.trim_end_matches('/').to_string();
    crate::ssh::sftp::validate_remote_path(&remote_root)?;
    let mut remote_map: std::collections::HashMap<String, WalkEntry> = Default::default();
    {
        let sftp_sess = crate::ssh::sftp::open_sftp(&session).await?;
        let sftp = sftp_sess.lock().await;
        walk_remote(&sftp, &remote_root, "", &mut remote_map).await?;
    }

    // Decide actions
    let mut to_upload: Vec<String> = Vec::new();
    let mut dirs_to_ensure: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();

    for (rel, lentry) in &local_map {
        if lentry.is_dir {
            dirs_to_ensure.insert(rel.clone());
            continue;
        }
        let r = remote_map.get(rel);
        let needs_upload = match r {
            None => true,
            Some(r) if r.is_dir => true, // file vs dir mismatch — replace
            Some(r) => {
                // Different size → definitely changed. Same size → only
                // re-upload if the local copy is clearly NEWER than the
                // remote, which catches size-preserving edits. A small
                // tolerance absorbs clock skew between the two machines
                // (remote mtime is set to the server's upload time).
                if r.size != lentry.size {
                    true
                } else {
                    match (lentry.mtime, r.mtime) {
                        (Some(lm), Some(rm)) => lm > rm.saturating_add(MTIME_TOLERANCE_SECS),
                        _ => false,
                    }
                }
            }
        };
        if needs_upload {
            to_upload.push(rel.clone());
        }
    }

    let mut to_delete: Vec<(String, bool)> = Vec::new();
    if delete_extraneous {
        for (rel, r) in &remote_map {
            if !local_map.contains_key(rel) {
                // Be safe: never touch excluded patterns on the remote.
                // `path_excluded` matches nested segments too, so a bare
                // `__pycache__` / `*.pyc` protects files at any depth.
                if path_excluded(&globs, rel) {
                    continue;
                }
                to_delete.push((rel.clone(), r.is_dir));
            }
        }
        // Sort deep-first so we remove files before their parent dirs.
        to_delete.sort_by(|a, b| b.0.split('/').count().cmp(&a.0.split('/').count()));
    }

    crate::ssh::activity::info(
        &state.app,
        "sync",
        format!(
            "plan: {} upload, {} delete, {} unchanged",
            to_upload.len(),
            to_delete.len(),
            local_map.len() - to_upload.len()
        ),
        Some(&sid),
    );

    // Execute upload
    let mut uploaded = 0u32;
    for rel in &to_upload {
        let local_full = canon_root.join(rel);
        let remote_full = format!("{}/{}", remote_root, rel);
        if let Err(e) = crate::ssh::sftp::upload(&session, &local_full, &remote_full).await {
            crate::ssh::activity::error(
                &state.app,
                "sync",
                format!("✗ upload {remote_full}: {e}"),
                Some(&sid),
            );
            return Err(e);
        }
        uploaded += 1;
    }

    // Execute delete
    let mut deleted = 0u32;
    for (rel, is_dir) in &to_delete {
        let remote_full = format!("{}/{}", remote_root, rel);
        if let Err(e) = crate::ssh::sftp::remove(&session, &remote_full, *is_dir).await {
            crate::ssh::activity::warn(
                &state.app,
                "sync",
                format!("could not delete {remote_full}: {e}"),
                Some(&sid),
            );
        } else {
            deleted += 1;
        }
    }

    crate::ssh::activity::success(
        &state.app,
        "sync",
        format!(
            "✓ sync done — {uploaded} uploaded, {deleted} deleted, {} unchanged",
            local_map.len() - uploaded as usize
        ),
        Some(&sid),
    );

    Ok(SyncStats {
        uploaded,
        deleted,
        unchanged: (local_map.len() as u32).saturating_sub(uploaded),
    })
}

#[derive(Serialize, Clone)]
pub struct SyncStats {
    pub uploaded: u32,
    pub deleted: u32,
    pub unchanged: u32,
}

/// Run rsync for a project. Streams progress via `rsync-log://{project_id}`.
#[tauri::command]
pub async fn deploy_rsync(
    project_id: Uuid,
    dry_run: bool,
    state: State<'_, AppState>,
) -> AppResult<i32> {
    let (project, server) = resolve_project_server(&state, project_id).await?;
    runner::run(
        &state.app,
        RsyncOptions {
            project: &project,
            server: &server,
            dry_run,
        },
    )
    .await
}

#[derive(Serialize, Clone)]
pub struct LocalEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix mtime in seconds, if known.
    pub mtime: Option<u64>,
    /// True if this entry matches an exclude pattern.
    pub excluded: bool,
}

/// Result of `compare_file` — both sides + a unified diff string.
#[derive(Serialize, Clone)]
pub struct FileComparison {
    pub local_exists: bool,
    pub remote_exists: bool,
    pub local_size: u64,
    pub remote_size: u64,
    pub local_mtime: Option<u64>,
    pub remote_mtime: Option<u64>,
    pub identical: bool,
    pub is_binary: bool,
    /// Present only for text files up to 1 MiB each.
    pub local_text: Option<String>,
    pub remote_text: Option<String>,
    /// Unified diff string — empty if either side is binary or too large.
    pub unified_diff: String,
}

/// Compare a local file (relative to project.local_path) against its
/// remote counterpart on the given session. Returns both texts and a
/// unified diff suitable for side-by-side rendering.
#[tauri::command]
pub async fn compare_file(
    project_id: Uuid,
    relative_path: String,
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<FileComparison> {
    use crate::ssh::sftp;
    use similar::{ChangeTag, TextDiff};
    use tokio::io::AsyncReadExt;

    const MAX_TEXT_BYTES: u64 = 1024 * 1024; // 1 MiB

    let (project, _) = resolve_project_server(&state, project_id).await?;
    let session = state.sessions.get(&session_id)?;

    // Local side
    let local_full = project.local_path.join(&relative_path);
    let canon_local = tokio::fs::canonicalize(&local_full).await.ok();
    let canon_base = tokio::fs::canonicalize(&project.local_path).await?;
    if let Some(cl) = &canon_local {
        if !cl.starts_with(&canon_base) {
            return Err(AppError::InvalidPath(format!(
                "path escapes project root: {relative_path}"
            )));
        }
    }
    let (local_bytes, local_size, local_mtime, local_exists) = match canon_local {
        Some(p) if p.is_file() => {
            let md = tokio::fs::metadata(&p).await?;
            let size = md.len();
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            let bytes = if size <= MAX_TEXT_BYTES {
                let mut f = tokio::fs::File::open(&p).await?;
                let mut buf = Vec::with_capacity(size as usize);
                f.read_to_end(&mut buf).await?;
                Some(buf)
            } else {
                None
            };
            (bytes, size, mtime, true)
        }
        _ => (None, 0u64, None, false),
    };

    // Remote side.
    // IMPORTANT: `relative_path` may come from two sources:
    //   (a) LocalFileBrowser — path relative to project.local_path.
    //   (b) RemoteFileBrowser — path relative to project.remote_path.
    // These should match when the user has set up correct mapping. We
    // also strip any leading slash that may have sneaked in.
    let remote_rel = relative_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    let remote_full = join_remote(&project.remote_path, &remote_rel);
    sftp::validate_remote_path(&remote_full)?;

    crate::ssh::activity::info(
        &state.app,
        "compare",
        format!("comparing {remote_full} ↔ {}", local_full.display()),
        Some(&session_id),
    );

    let sftp_session = sftp::open_sftp(&session).await?;
    let sftp_guard = sftp_session.lock().await;
    let remote_meta = sftp_guard.metadata(&remote_full).await;
    let (remote_bytes, remote_size, remote_mtime, remote_exists) = match remote_meta {
        Ok(attrs) if !attrs.is_dir() => {
            let size = attrs.size.unwrap_or(0);
            let mtime = attrs.mtime.map(|m| m as u64);
            let bytes = if size <= MAX_TEXT_BYTES {
                use russh_sftp::protocol::OpenFlags;
                use tokio::io::AsyncReadExt as _;
                let mut f = sftp_guard
                    .open_with_flags(&remote_full, OpenFlags::READ)
                    .await
                    .map_err(|e| AppError::Sftp(format!("open remote: {e}")))?;
                let mut buf = Vec::with_capacity(size as usize);
                f.read_to_end(&mut buf)
                    .await
                    .map_err(|e| AppError::Sftp(format!("read: {e}")))?;
                Some(buf)
            } else {
                None
            };
            (bytes, size, mtime, true)
        }
        Ok(_) => (None, 0u64, None, false), // it's a directory
        Err(e) => {
            // Surface the real SFTP error in the activity log so users
            // aren't left guessing why "remote missing" appeared.
            crate::ssh::activity::warn(
                &state.app,
                "compare",
                format!("remote stat failed for {remote_full}: {e}"),
                Some(&session_id),
            );
            (None, 0u64, None, false)
        }
    };
    drop(sftp_guard);

    // Detect binary via NUL byte in either side.
    let is_binary = local_bytes
        .as_deref()
        .map(contains_nul)
        .unwrap_or(false)
        || remote_bytes.as_deref().map(contains_nul).unwrap_or(false);

    // Decode text + build unified diff. Line endings are normalized to
    // LF before comparison so CRLF↔LF differences (common with files
    // edited on Windows vs. copied to a Linux server) don't register
    // as diffs — matches git's `core.autocrlf` expectation.
    let (local_text, remote_text, unified_diff, identical) = if is_binary {
        let same = match (&local_bytes, &remote_bytes) {
            (Some(a), Some(b)) => a == b,
            _ => local_size == remote_size && local_exists && remote_exists,
        };
        (None, None, String::new(), same)
    } else {
        let lt_raw = local_bytes
            .as_deref()
            .and_then(|b| std::str::from_utf8(b).ok())
            .map(|s| s.to_string());
        let rt_raw = remote_bytes
            .as_deref()
            .and_then(|b| std::str::from_utf8(b).ok())
            .map(|s| s.to_string());

        let lt_norm = lt_raw.as_deref().map(normalize_newlines);
        let rt_norm = rt_raw.as_deref().map(normalize_newlines);

        let same = match (&lt_norm, &rt_norm) {
            (Some(a), Some(b)) => a == b && local_exists && remote_exists,
            _ => false,
        };

        let diff_text = match (lt_norm.as_deref(), rt_norm.as_deref()) {
            (Some(l), Some(r)) if !same => {
                let diff = TextDiff::from_lines(l, r);
                let mut out = String::new();
                for op in diff.ops() {
                    for change in diff.iter_changes(op) {
                        let sign = match change.tag() {
                            ChangeTag::Delete => "-",
                            ChangeTag::Insert => "+",
                            ChangeTag::Equal => " ",
                        };
                        out.push_str(sign);
                        out.push_str(change.value());
                        if !change.value().ends_with('\n') {
                            out.push('\n');
                        }
                    }
                }
                out
            }
            (Some(l), None) => format!(
                "--- local ({} bytes)\n+++ remote (missing)\n{}",
                l.len(),
                prefix_each_line("-", l)
            ),
            (None, Some(r)) => format!(
                "--- local (missing)\n+++ remote ({} bytes)\n{}",
                r.len(),
                prefix_each_line("+", r)
            ),
            _ => String::new(),
        };
        // Expose the raw text in the side-by-side view so users can see
        // what's actually on disk — only the diff itself is normalized.
        (lt_raw, rt_raw, diff_text, same)
    };

    Ok(FileComparison {
        local_exists,
        remote_exists,
        local_size,
        remote_size,
        local_mtime,
        remote_mtime,
        identical,
        is_binary,
        local_text,
        remote_text,
        unified_diff,
    })
}

/// Internal descriptor used by the recursive folder walk.
#[derive(Clone)]
struct WalkEntry {
    is_dir: bool,
    size: u64,
    mtime: Option<u64>,
}

/// Per-entry result for `compare_folder`.
#[derive(Serialize, Clone)]
pub struct FolderCompareEntry {
    pub relative_path: String,
    pub is_dir: bool,
    /// "only_local" | "only_remote" | "identical" | "differs"
    pub status: &'static str,
    pub local_size: u64,
    pub remote_size: u64,
    pub local_mtime: Option<u64>,
    pub remote_mtime: Option<u64>,
    pub excluded: bool,
}

#[derive(Serialize, Clone)]
pub struct FolderCompareResult {
    pub entries: Vec<FolderCompareEntry>,
    pub only_local: usize,
    pub only_remote: usize,
    pub differs: usize,
    pub identical: usize,
}

/// Recursively compare a directory local ↔ remote.
///
/// For speed we only compare size (+ mtime) — not file contents. Users
/// who want byte-level diffs can open `compare_file` on a specific row
/// from the results dialog.
#[tauri::command]
pub async fn compare_folder(
    project_id: Uuid,
    relative_path: String,
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<FolderCompareResult> {
    let (project, _) = resolve_project_server(&state, project_id).await?;
    let session = state.sessions.get(&session_id)?;

    // Compile exclude globs
    let globs = build_globset(&project.excludes)?;

    // Canonicalize & validate local root
    let local_root = project.local_path.join(&relative_path);
    let canon_local_root = tokio::fs::canonicalize(&local_root).await?;
    let canon_base = tokio::fs::canonicalize(&project.local_path).await?;
    if !canon_local_root.starts_with(&canon_base) {
        return Err(AppError::InvalidPath(format!(
            "path escapes project root: {relative_path}"
        )));
    }

    // Normalize the remote root, trimming leading slash before joining.
    let rel_trimmed = relative_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    let remote_root = if rel_trimmed.is_empty() {
        project.remote_path.trim_end_matches('/').to_string()
    } else {
        join_remote(&project.remote_path, &rel_trimmed)
    };
    crate::ssh::sftp::validate_remote_path(&remote_root)?;

    crate::ssh::activity::info(
        &state.app,
        "compare",
        format!("folder compare {} ↔ {remote_root}", canon_local_root.display()),
        Some(&session_id),
    );

    // Walk local
    let mut local_map: std::collections::HashMap<String, WalkEntry> = Default::default();
    walk_local(&canon_local_root, &canon_local_root, &globs, &mut local_map).await?;

    // Walk remote
    let sftp_session = crate::ssh::sftp::open_sftp(&session).await?;
    let mut remote_map: std::collections::HashMap<String, WalkEntry> = Default::default();
    {
        let sftp = sftp_session.lock().await;
        walk_remote(&sftp, &remote_root, "", &mut remote_map).await?;
    }

    // Reconcile
    let mut entries: Vec<FolderCompareEntry> = Vec::new();
    let mut only_local = 0usize;
    let mut only_remote = 0usize;
    let mut differs = 0usize;
    let mut identical = 0usize;

    let all_paths: std::collections::BTreeSet<String> = local_map
        .keys()
        .chain(remote_map.keys())
        .cloned()
        .collect();

    for p in all_paths {
        let excluded = globs.is_match(&p);
        let l = local_map.get(&p);
        let r = remote_map.get(&p);
        let (status, is_dir, ls, rs, lm, rm) = match (l, r) {
            (Some(l), Some(r)) => {
                let is_dir = l.is_dir || r.is_dir;
                let same = if is_dir { true } else { l.size == r.size };
                let st = if same { "identical" } else { "differs" };
                if same { identical += 1 } else { differs += 1 }
                (st, is_dir, l.size, r.size, l.mtime, r.mtime)
            }
            (Some(l), None) => {
                only_local += 1;
                ("only_local", l.is_dir, l.size, 0, l.mtime, None)
            }
            (None, Some(r)) => {
                only_remote += 1;
                ("only_remote", r.is_dir, 0, r.size, None, r.mtime)
            }
            (None, None) => unreachable!(),
        };
        entries.push(FolderCompareEntry {
            relative_path: p,
            is_dir,
            status,
            local_size: ls,
            remote_size: rs,
            local_mtime: lm,
            remote_mtime: rm,
            excluded,
        });
    }

    crate::ssh::activity::success(
        &state.app,
        "compare",
        format!(
            "folder compare done: {} only-local, {} only-remote, {} differ, {} identical",
            only_local, only_remote, differs, identical
        ),
        Some(&session_id),
    );

    Ok(FolderCompareResult {
        entries,
        only_local,
        only_remote,
        differs,
        identical,
    })
}

/// Recursively walk a local directory, building `{relative_path -> WalkEntry}`.
/// Excluded patterns (matched against the relative path or filename) are skipped.
fn walk_local<'a>(
    root: &'a Path,
    current: &'a Path,
    globs: &'a globset::GlobSet,
    out: &'a mut std::collections::HashMap<String, WalkEntry>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        let mut rd = tokio::fs::read_dir(current).await?;
        while let Some(e) = rd.next_entry().await? {
            let path = e.path();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let name_match = path
                .file_name()
                .map(|n| globs.is_match(n))
                .unwrap_or(false);
            if globs.is_match(&rel) || name_match {
                continue;
            }
            let md = e.metadata().await?;
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            out.insert(
                rel.clone(),
                WalkEntry {
                    is_dir: md.is_dir(),
                    size: md.len(),
                    mtime,
                },
            );
            if md.is_dir() {
                walk_local(root, &path, globs, out).await?;
            }
        }
        Ok(())
    })
}

fn walk_remote<'a>(
    sftp: &'a russh_sftp::client::SftpSession,
    root: &'a str,
    rel: &'a str,
    out: &'a mut std::collections::HashMap<String, WalkEntry>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        let current = if rel.is_empty() {
            root.to_string()
        } else {
            format!("{}/{rel}", root.trim_end_matches('/'))
        };
        let entries = match sftp.read_dir(&current).await {
            Ok(e) => e,
            Err(_) => return Ok(()), // remote root may be missing — emit 0 entries
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let attrs: russh_sftp::protocol::FileAttributes = entry.metadata();
            let is_dir = attrs.is_dir();
            out.insert(
                child_rel.clone(),
                WalkEntry {
                    is_dir,
                    size: attrs.size.unwrap_or(0),
                    mtime: attrs.mtime.map(|m| m as u64),
                },
            );
            if is_dir {
                walk_remote(sftp, root, &child_rel, out).await?;
            }
        }
        Ok(())
    })
}

/// Collapse CRLF / lone CR to LF so line-ending differences don't show
/// up as diffs. Other whitespace is left alone.
fn normalize_newlines(s: &str) -> String {
    // Two-pass, no regex: first CRLF -> LF, then any stray CR -> LF.
    let lf1 = s.replace("\r\n", "\n");
    lf1.replace('\r', "\n")
}

fn contains_nul(bytes: &[u8]) -> bool {
    // Sample only the first 8 KiB — big enough to catch most binaries,
    // small enough to stay fast on large text files.
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn prefix_each_line(prefix: &str, s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        out.push_str(prefix);
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// List a level of the local file tree under `project.local_path`. The
/// frontend calls this as the user expands directories in the tree.
#[tauri::command]
pub async fn list_local_tree(
    project_id: Uuid,
    relative_path: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<LocalEntry>> {
    let (project, _) = resolve_project_server(&state, project_id).await?;

    let dir = project.local_path.join(&relative_path);
    let canon_dir = tokio::fs::canonicalize(&dir).await?;
    let canon_root = tokio::fs::canonicalize(&project.local_path).await?;
    if !canon_dir.starts_with(&canon_root) {
        return Err(AppError::InvalidPath(format!(
            "path escapes project root: {relative_path}"
        )));
    }

    // Compile the exclude globset once.
    let globs = build_globset(&project.excludes)?;

    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(&canon_dir).await?;
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().to_string();
        let rel = join_rel(&relative_path, &name);
        let md = e.metadata().await?;
        let mtime = md.modified().ok().and_then(|t| {
            t.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
        });
        let excluded = globs.is_match(&rel) || globs.is_match(&name);
        entries.push(LocalEntry {
            name,
            relative_path: rel,
            is_dir: md.is_dir(),
            size: md.len(),
            mtime,
            excluded,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

// --- helpers ---

async fn resolve_project_server(
    state: &AppState,
    project_id: Uuid,
) -> AppResult<(Project, Server)> {
    state
        .vault
        .read(|d| {
            let p = d.projects.iter().find(|p| p.id == project_id).cloned();
            let s = p.as_ref().and_then(|proj| {
                d.servers.iter().find(|s| s.id == proj.server_id).cloned()
            });
            (p, s)
        })
        .await
        .and_then(|(p, s)| {
            let p = p.ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))?;
            let s = s.ok_or_else(|| AppError::ServerNotFound(p.server_id.to_string()))?;
            Ok((p, s))
        })
}

async fn open_ephemeral(
    state: &AppState,
    server: &Server,
    project: Option<Project>,
) -> AppResult<Arc<SshSession>> {
    let client = client::connect(server).await?;
    let fp = client.fingerprint.clone();
    let session = Arc::new(SshSession {
        id: format!("ephemeral-{}", Uuid::new_v4()),
        server_id: server.id,
        project,
        handle: Arc::new(Mutex::new(client.handle)),
        fingerprint: fp,
        terminals: dashmap::DashMap::new(),
        opened_at: SystemTime::now(),
        app: state.app.clone(),
        capabilities: tokio::sync::RwLock::new(None),
    });
    state.sessions.insert(session.clone());
    Ok(session)
}

fn remote_basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p)
}

/// Patterns that are ALWAYS excluded from deploy / sync / compare, on top
/// of the project's own excludes. These are build artifacts + VCS metadata
/// that should never be uploaded to — nor deleted from — a server. This
/// protects existing projects (created before a pattern was in the
/// defaults) from destructive sync-delete on e.g. `__pycache__`.
fn baseline_excludes() -> &'static [&'static str] {
    &["__pycache__", "*.pyc", "*.pyo", ".git"]
}

/// Build the exclude globset from the project's patterns plus the
/// always-on baseline. Used everywhere excludes are honored so behavior
/// stays consistent.
fn build_globset(excludes: &[String]) -> AppResult<globset::GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pat in baseline_excludes() {
        if let Ok(g) = Glob::new(pat) {
            builder.add(g);
        }
    }
    for pat in excludes {
        if let Ok(g) = Glob::new(pat) {
            builder.add(g);
        }
    }
    builder.build().map_err(|e| AppError::Other(e.to_string()))
}

/// True if a relative path should be excluded. Matches the full path AND
/// each individual segment — globset's `*` never crosses `/`, so a bare
/// pattern like `__pycache__` or `*.pyc` would otherwise miss nested
/// entries such as `app/service/__pycache__/foo.pyc`.
fn path_excluded(globs: &globset::GlobSet, rel: &str) -> bool {
    globs.is_match(rel) || rel.split('/').any(|seg| globs.is_match(seg))
}

fn join_remote(base: &str, rel: &str) -> String {
    let b = base.trim_end_matches('/');
    let r = rel.trim_start_matches('/');
    format!("{b}/{r}")
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

/// Hint for the Rust compiler — PathBuf is used only in helpers above,
/// keeping the top-level import clean.
#[allow(dead_code)]
fn _pathbuf_marker(_p: &Path) -> PathBuf {
    PathBuf::new()
}

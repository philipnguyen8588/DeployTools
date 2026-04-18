//! Git integration commands.
//!
//! We use `git2` (libgit2) in its default-features-off mode so no OpenSSL
//! is pulled in — we never clone/fetch from here, only inspect the local
//! repo under `project.local_path`.

use std::collections::HashSet;

use git2::{Repository, Sort, StatusOptions};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize, Clone)]
pub struct GitFile {
    /// Path relative to the repo root (forward slashes).
    pub relative_path: String,
    /// `M` / `A` / `D` / `R` / `?`, or a two-letter XY pair to mirror
    /// `git status --short`.
    pub status: String,
    /// True if the file is currently present on disk (i.e. uploadable).
    pub exists_on_disk: bool,
}

#[derive(Serialize, Clone)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub time: i64, // unix seconds
    pub summary: String,
}

#[derive(Serialize, Clone)]
pub struct GitInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub repo_root: Option<String>,
}

/// Basic repo health check — used by the UI to decide whether to show
/// the Git tab at all.
#[tauri::command]
pub async fn git_info(
    project_id: Uuid,
    state: State<'_, AppState>,
) -> AppResult<GitInfo> {
    let project = state
        .vault
        .read(|d| d.projects.iter().find(|p| p.id == project_id).cloned())
        .await?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))?;

    let local_path = project.local_path.clone();
    tokio::task::spawn_blocking(move || -> AppResult<GitInfo> {
        let repo = match Repository::discover(&local_path) {
            Ok(r) => r,
            Err(_) => return Ok(GitInfo {
                is_repo: false,
                branch: None,
                head_short: None,
                repo_root: None,
            }),
        };
        let branch = repo.head().ok().and_then(|h| {
            h.shorthand().map(|s| s.to_string())
        });
        let head_short = repo.head().ok().and_then(|h| {
            h.target().map(|oid| format!("{:.7}", oid))
        });
        let root = repo.workdir().map(|p| p.to_string_lossy().to_string());
        Ok(GitInfo {
            is_repo: true,
            branch,
            head_short,
            repo_root: root,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("git info: {e}")))?
}

/// List files in the working directory + index that differ from HEAD.
/// Mirrors `git status --short` output but returns structured data.
#[tauri::command]
pub async fn git_status(
    project_id: Uuid,
    state: State<'_, AppState>,
) -> AppResult<Vec<GitFile>> {
    let project = state
        .vault
        .read(|d| d.projects.iter().find(|p| p.id == project_id).cloned())
        .await?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))?;

    let local_path = project.local_path.clone();
    tokio::task::spawn_blocking(move || -> AppResult<Vec<GitFile>> {
        let repo = Repository::discover(&local_path)
            .map_err(|e| AppError::Other(format!("not a git repo: {e}")))?;
        let workdir = repo.workdir().ok_or_else(|| {
            AppError::Other("bare repositories are not supported".into())
        })?;
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false);

        let statuses = repo
            .statuses(Some(&mut opts))
            .map_err(|e| AppError::Other(format!("git status: {e}")))?;

        let mut out = Vec::new();
        for entry in statuses.iter() {
            let path = match entry.path() {
                Some(p) => p.to_string(),
                None => continue,
            };
            let s = entry.status();
            // Build a short-code approximating `git status --short`.
            let code = status_short(s);
            let abs = workdir.join(&path);
            out.push(GitFile {
                relative_path: path.replace('\\', "/"),
                status: code,
                exists_on_disk: abs.exists(),
            });
        }
        out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(format!("git status task: {e}")))?
}

fn status_short(s: git2::Status) -> String {
    use git2::Status as S;
    let index = if s.contains(S::INDEX_NEW) {
        'A'
    } else if s.contains(S::INDEX_MODIFIED) {
        'M'
    } else if s.contains(S::INDEX_DELETED) {
        'D'
    } else if s.contains(S::INDEX_RENAMED) {
        'R'
    } else if s.contains(S::INDEX_TYPECHANGE) {
        'T'
    } else {
        ' '
    };
    let wt = if s.contains(S::WT_NEW) {
        '?'
    } else if s.contains(S::WT_MODIFIED) {
        'M'
    } else if s.contains(S::WT_DELETED) {
        'D'
    } else if s.contains(S::WT_RENAMED) {
        'R'
    } else if s.contains(S::WT_TYPECHANGE) {
        'T'
    } else {
        ' '
    };
    format!("{index}{wt}")
}

/// List recent commits on the current branch.
#[tauri::command]
pub async fn git_log(
    project_id: Uuid,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> AppResult<Vec<GitCommit>> {
    let project = state
        .vault
        .read(|d| d.projects.iter().find(|p| p.id == project_id).cloned())
        .await?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))?;

    let local_path = project.local_path.clone();
    let limit = limit.unwrap_or(100).min(1000) as usize;

    tokio::task::spawn_blocking(move || -> AppResult<Vec<GitCommit>> {
        let repo = Repository::discover(&local_path)
            .map_err(|e| AppError::Other(format!("not a git repo: {e}")))?;
        let mut walk = repo
            .revwalk()
            .map_err(|e| AppError::Other(format!("revwalk: {e}")))?;
        walk.set_sorting(Sort::TIME)
            .map_err(|e| AppError::Other(format!("sort: {e}")))?;
        walk.push_head()
            .map_err(|e| AppError::Other(format!("push HEAD: {e}")))?;

        let mut out = Vec::new();
        for oid in walk.take(limit) {
            let oid = match oid {
                Ok(o) => o,
                Err(_) => continue,
            };
            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let author = commit.author();
            out.push(GitCommit {
                hash: oid.to_string(),
                short_hash: format!("{:.7}", oid),
                author: author.name().unwrap_or("").to_string(),
                email: author.email().unwrap_or("").to_string(),
                time: commit.time().seconds(),
                summary: commit.summary().unwrap_or("").to_string(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(format!("git log task: {e}")))?
}

/// List files touched by a single commit (union of added/modified/renamed
/// vs. its first parent). Files that were deleted are skipped since
/// there's nothing to upload.
#[tauri::command]
pub async fn git_files_in_commit(
    project_id: Uuid,
    hash: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<GitFile>> {
    let project = state
        .vault
        .read(|d| d.projects.iter().find(|p| p.id == project_id).cloned())
        .await?
        .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))?;

    let local_path = project.local_path.clone();
    tokio::task::spawn_blocking(move || -> AppResult<Vec<GitFile>> {
        let repo = Repository::discover(&local_path)
            .map_err(|e| AppError::Other(format!("not a git repo: {e}")))?;
        let workdir = repo.workdir().ok_or_else(|| {
            AppError::Other("bare repositories not supported".into())
        })?;
        let oid = git2::Oid::from_str(&hash)
            .map_err(|e| AppError::Other(format!("bad hash: {e}")))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| AppError::Other(format!("find commit: {e}")))?;
        let commit_tree = commit
            .tree()
            .map_err(|e| AppError::Other(format!("commit tree: {e}")))?;
        let parent_tree = if commit.parent_count() > 0 {
            commit.parent(0).ok().and_then(|p| p.tree().ok())
        } else {
            None
        };

        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
            .map_err(|e| AppError::Other(format!("diff: {e}")))?;

        let mut seen: HashSet<String> = HashSet::new();
        let mut files = Vec::new();
        diff.foreach(
            &mut |delta, _| {
                let status = match delta.status() {
                    git2::Delta::Added => "A",
                    git2::Delta::Modified => "M",
                    git2::Delta::Renamed => "R",
                    git2::Delta::Copied => "C",
                    git2::Delta::Typechange => "T",
                    git2::Delta::Deleted => return true, // skip
                    _ => "?",
                };
                if let Some(p) = delta.new_file().path() {
                    let rel = p.to_string_lossy().replace('\\', "/");
                    if seen.insert(rel.clone()) {
                        let abs = workdir.join(&rel);
                        files.push(GitFile {
                            relative_path: rel,
                            status: status.to_string(),
                            exists_on_disk: abs.exists(),
                        });
                    }
                }
                true
            },
            None,
            None,
            None,
        )
        .map_err(|e| AppError::Other(format!("diff foreach: {e}")))?;
        files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(files)
    })
    .await
    .map_err(|e| AppError::Other(format!("git files task: {e}")))?
}

//! MCP tool registry + dispatch. Every tool reuses the existing Tauri
//! command functions (so vault gating, path validation, progress events
//! and the desktop Activity log all apply), obtaining `AppState` from the
//! `AppHandle` via `app.state::<AppState>()`.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::{HistorySource, McpActivityEntry, Project};
use crate::state::AppState;

/// Tool definitions advertised by `tools/list`.
pub fn list() -> Value {
    let project_only = schema(
        json!({ "project": { "type": "string", "description": "Project name (as shown in the app sidebar)" } }),
        &["project"],
    );
    json!([
        tool("status", "Report whether the app vault is unlocked and which projects currently have a live SSH session.", schema(json!({}), &[])),
        tool("list_projects", "List configured projects: name, server (display name only — host/IP is never exposed), local path and remote path.", schema(json!({}), &[])),
        tool("connect_project", "Open (or reuse) an SSH session for the named project.", project_only.clone()),
        tool("disconnect_project", "Close the SSH session(s) for the named project.", project_only.clone()),
        tool("git_changed_files", "List the working-tree changes (git status) for the project's local repo.", project_only.clone()),
        tool(
            "list_excludes",
            "List the exclude patterns for a project and how sync treats them. Excluded files are NEVER uploaded by sync and NEVER deleted by sync_and_delete, so they are fully protected (e.g. add '.env' or '*.env' to protect env files). Call this before sync/sync_and_delete to confirm sensitive files are covered.",
            project_only.clone(),
        ),
        tool(
            "upload_changed_files",
            "Upload the project's git working-tree changes to the server via SFTP. Optionally restrict to a subset of relative paths.",
            schema(
                json!({
                    "project": { "type": "string", "description": "Project name" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Optional: only upload these relative paths" }
                }),
                &["project"],
            ),
        ),
        tool(
            "sync",
            "Upload every new or changed file to the server (native SFTP sync, no deletion). Files matching the project's exclude patterns are NEVER uploaded, so excluded files (e.g. .env) are not overwritten on the server. Use list_excludes to see the patterns.",
            project_only.clone(),
        ),
        tool(
            "sync_and_delete",
            "Sync to the server AND delete remote files that no longer exist locally. Excluded files are never uploaded AND never deleted — they are fully protected. NON-excluded remote files missing locally are permanently deleted, and non-excluded local files overwrite the remote copy. Call list_excludes first to confirm sensitive files (e.g. .env) are excluded.",
            project_only.clone(),
        ),
        tool(
            "list_commits",
            "List recent git commits for the project.",
            schema(
                json!({
                    "project": { "type": "string", "description": "Project name" },
                    "limit": { "type": "integer", "description": "Max commits (default 50)" }
                }),
                &["project"],
            ),
        ),
        tool(
            "files_in_commit",
            "List the files touched by a specific commit (current working-tree versions).",
            schema(
                json!({
                    "project": { "type": "string", "description": "Project name" },
                    "commit": { "type": "string", "description": "Commit hash (full or short)" }
                }),
                &["project", "commit"],
            ),
        ),
        tool(
            "upload_commit_files",
            "Upload the (current) files touched by a commit to the server. Optionally restrict to a subset of relative paths.",
            schema(
                json!({
                    "project": { "type": "string", "description": "Project name" },
                    "commit": { "type": "string", "description": "Commit hash (full or short)" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "Optional: only these relative paths" }
                }),
                &["project", "commit"],
            ),
        ),
        tool(
            "command_policy",
            "Return the guard policy for run_command: mode, the list of disallowed program names, and the structural rules. Call this to learn which commands are blocked before using run_command.",
            schema(json!({}), &[]),
        ),
        tool(
            "run_command",
            "Run a shell command on the connected server (login shell) and return stdout, stderr and exit code. A safety guard BLOCKS dangerous commands (rm, kill, dd, mkfs, shutdown, chmod 777, privilege escalation, piping into a shell, writes to block devices, fork bombs, …); blocked calls return an error. Call command_policy for the exact blocklist.",
            schema(
                json!({
                    "project": { "type": "string", "description": "Project name" },
                    "command": { "type": "string", "description": "Shell command to run" },
                    "working_dir": { "type": "string", "description": "Optional remote working directory" }
                }),
                &["project", "command"],
            ),
        ),
    ])
}

/// Dispatch a `tools/call`. Returns the text payload (Ok) or an error
/// message (Err) — the protocol layer wraps both into MCP content.
pub async fn call(app: &AppHandle, name: &str, args: Value) -> Result<String, String> {
    // Flash a "MCP is working on <project>" signal in the UI (StatusBar).
    if let Some(project) = args.get("project").and_then(|v| v.as_str()) {
        let _ = app.emit("mcp://active", json!({ "project": project, "tool": name }));
    }
    let result = dispatch(app, name, args.clone()).await;
    log_activity(app, name, &args, &result).await;
    result.map_err(|e| e.to_string())
}

/// Tools that represent an action worth auditing (mutating / connecting /
/// running), as opposed to read-only queries.
fn is_action(tool: &str) -> bool {
    matches!(
        tool,
        "connect_project"
            | "disconnect_project"
            | "upload_changed_files"
            | "sync"
            | "sync_and_delete"
            | "upload_commit_files"
            | "run_command"
    )
}

/// Best-effort append to the vault's MCP audit log.
async fn log_activity(app: &AppHandle, tool: &str, args: &Value, result: &AppResult<String>) {
    if !is_action(tool) {
        return;
    }
    let project = args
        .get("project")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let detail = match result {
        Ok(_) => match tool {
            "run_command" => format!(
                "$ {}",
                args.get("command").and_then(|v| v.as_str()).unwrap_or("")
            ),
            _ => "ok".to_string(),
        },
        Err(e) => format!("error: {e}"),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = McpActivityEntry {
        id: Uuid::new_v4(),
        time_ms: now,
        tool: tool.to_string(),
        project,
        detail,
    };
    let _ = app
        .state::<AppState>()
        .vault
        .write(move |d| {
            d.mcp_activity.push(entry);
            let len = d.mcp_activity.len();
            if len > 1000 {
                d.mcp_activity.drain(0..len - 1000);
            }
        })
        .await;
}

async fn dispatch(app: &AppHandle, name: &str, args: Value) -> AppResult<String> {
    match name {
        "status" => status(app).await,
        "list_projects" => list_projects(app).await,
        "connect_project" => connect(app, &arg_str(&args, "project")?).await,
        "disconnect_project" => disconnect(app, &arg_str(&args, "project")?).await,
        "git_changed_files" => git_changed(app, &arg_str(&args, "project")?).await,
        "list_excludes" => list_excludes(app, &arg_str(&args, "project")?).await,
        "command_policy" => command_policy(app).await,
        "upload_changed_files" => {
            upload_changed(app, &arg_str(&args, "project")?, arg_list(&args, "files")).await
        }
        "sync" => sync(app, &arg_str(&args, "project")?, false).await,
        "sync_and_delete" => sync(app, &arg_str(&args, "project")?, true).await,
        "list_commits" => list_commits(app, &arg_str(&args, "project")?, arg_u32(&args, "limit")).await,
        "files_in_commit" => {
            files_in_commit(app, &arg_str(&args, "project")?, &arg_str(&args, "commit")?).await
        }
        "upload_commit_files" => {
            upload_commit_files(
                app,
                &arg_str(&args, "project")?,
                &arg_str(&args, "commit")?,
                arg_list(&args, "files"),
            )
            .await
        }
        "run_command" => {
            run_command(
                app,
                &arg_str(&args, "project")?,
                &arg_str(&args, "command")?,
                arg_str_opt(&args, "working_dir"),
            )
            .await
        }
        _ => Err(AppError::Other(format!("unknown tool: {name}"))),
    }
}

// ---------------- tool implementations ----------------

async fn status(app: &AppHandle) -> AppResult<String> {
    let vs = crate::commands::vault::vault_status(app.state()).await?;
    let sessions = app.state::<AppState>().sessions.list();
    let projects = if vs.unlocked {
        crate::commands::project::list_projects(app.state())
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let connected: Vec<Value> = sessions
        .iter()
        .map(|s| {
            let pname = s
                .project_id
                .and_then(|pid| projects.iter().find(|p| p.id == pid))
                .map(|p| p.name.clone());
            json!({ "session_id": s.id, "project": pname })
        })
        .collect();
    Ok(pretty(json!({
        "vault_exists": vs.exists,
        "vault_unlocked": vs.unlocked,
        "connected": connected,
    })))
}

async fn list_projects(app: &AppHandle) -> AppResult<String> {
    let projects = crate::commands::project::list_projects(app.state()).await?;
    let servers = crate::commands::server::list_servers(app.state())
        .await
        .unwrap_or_default();
    let out: Vec<Value> = projects
        .iter()
        .map(|p| {
            // Only expose the server's display name — never its host/IP.
            let server = servers
                .iter()
                .find(|s| s.id == p.server_id)
                .map(|s| s.name.clone());
            json!({
                "name": p.name,
                "server": server,
                "local_path": p.local_path,
                "remote_path": p.remote_path,
            })
        })
        .collect();
    Ok(pretty(json!(out)))
}

async fn connect(app: &AppHandle, project_name: &str) -> AppResult<String> {
    let (project, sid) = ensure_session(app, project_name).await?;
    Ok(pretty(json!({ "connected": true, "project": project.name, "session_id": sid })))
}

async fn disconnect(app: &AppHandle, project_name: &str) -> AppResult<String> {
    let project = find_project(app, project_name).await?;
    let sessions: Vec<String> = app
        .state::<AppState>()
        .sessions
        .list()
        .into_iter()
        .filter(|s| s.project_id == Some(project.id))
        .map(|s| s.id)
        .collect();
    let mut closed = 0;
    for id in sessions {
        crate::commands::session::close_session(id.clone(), app.state()).await?;
        let _ = app.emit("mcp://session-closed", json!({ "session_id": id }));
        closed += 1;
    }
    Ok(pretty(json!({ "disconnected": closed, "project": project.name })))
}

async fn git_changed(app: &AppHandle, project_name: &str) -> AppResult<String> {
    let project = find_project(app, project_name).await?;
    let files = crate::commands::git::git_status(project.id, app.state()).await?;
    Ok(pretty(serde_json::to_value(&files)?))
}

async fn command_policy(app: &AppHandle) -> AppResult<String> {
    let cfg = crate::mcp::read_cfg(app.state::<AppState>().inner()).await?;
    Ok(pretty(json!({
        "mode": cfg.cmd_mode,
        "modes": ["off", "deny", "disabled"],
        "denied_programs": cfg.cmd_denylist,
        "structural_rules": crate::mcp::policy::structural_rules(),
        "note": "run_command is screened by a denylist guard (not a full sandbox). Blocked calls return an error. 'off' allows all; 'disabled' blocks run_command entirely.",
    })))
}

async fn list_excludes(app: &AppHandle, project_name: &str) -> AppResult<String> {
    let project = find_project(app, project_name).await?;
    let baseline: Vec<String> = crate::commands::deploy::baseline_excludes()
        .iter()
        .map(|s| s.to_string())
        .collect();
    // Effective = baseline + project patterns, de-duplicated (order kept).
    let mut effective: Vec<String> = Vec::new();
    for p in baseline.iter().chain(project.excludes.iter()) {
        if !effective.contains(p) {
            effective.push(p.clone());
        }
    }
    Ok(pretty(json!({
        "project": project.name,
        "project_excludes": project.excludes,
        "baseline_excludes": baseline,
        "effective": effective,
        "behavior": {
            "sync": "Files matching any effective pattern are NEVER uploaded — the remote copy is left untouched.",
            "sync_and_delete": "Excluded files are never uploaded AND never deleted on the remote — fully protected. Non-excluded remote files missing locally are permanently deleted.",
            "matching": "A pattern matches if it equals the full relative path OR any single path segment. So '.env' protects a file/dir named .env at any depth; use '*.env' for names like foo.env."
        }
    })))
}

async fn upload_changed(
    app: &AppHandle,
    project_name: &str,
    subset: Option<Vec<String>>,
) -> AppResult<String> {
    let (project, sid) = ensure_session(app, project_name).await?;
    let files = crate::commands::git::git_status(project.id, app.state()).await?;
    upload_files(app, &project, &sid, files, subset).await
}

async fn sync(app: &AppHandle, project_name: &str, delete: bool) -> AppResult<String> {
    let (project, sid) = ensure_session(app, project_name).await?;
    let job = Uuid::new_v4().to_string();
    let stats =
        crate::commands::deploy::deploy_sync(project.id, Some(sid), delete, Some(job), app.state())
            .await?;
    Ok(pretty(json!({
        "uploaded": stats.uploaded,
        "deleted": stats.deleted,
        "unchanged": stats.unchanged,
    })))
}

async fn list_commits(app: &AppHandle, project_name: &str, limit: Option<u32>) -> AppResult<String> {
    let project = find_project(app, project_name).await?;
    let commits =
        crate::commands::git::git_log(project.id, Some(limit.unwrap_or(50)), app.state()).await?;
    Ok(pretty(serde_json::to_value(&commits)?))
}

async fn files_in_commit(app: &AppHandle, project_name: &str, commit: &str) -> AppResult<String> {
    let project = find_project(app, project_name).await?;
    let files =
        crate::commands::git::git_files_in_commit(project.id, commit.to_string(), app.state())
            .await?;
    Ok(pretty(serde_json::to_value(&files)?))
}

async fn upload_commit_files(
    app: &AppHandle,
    project_name: &str,
    commit: &str,
    subset: Option<Vec<String>>,
) -> AppResult<String> {
    let (project, sid) = ensure_session(app, project_name).await?;
    let files =
        crate::commands::git::git_files_in_commit(project.id, commit.to_string(), app.state())
            .await?;
    upload_files(app, &project, &sid, files, subset).await
}

async fn run_command(
    app: &AppHandle,
    project_name: &str,
    command: &str,
    working_dir: Option<String>,
) -> AppResult<String> {
    // Screen the command against the vault-configured guard BEFORE connecting.
    let (mode, denylist) = match crate::mcp::read_cfg(app.state::<AppState>().inner()).await {
        Ok(c) => (c.cmd_mode, c.cmd_denylist),
        Err(_) => ("deny".to_string(), crate::mcp::policy::default_denied_programs()),
    };
    if let Err(reason) = crate::mcp::policy::check(command, &mode, &denylist) {
        return Err(AppError::Other(format!(
            "Command blocked by guard: {reason}. Call the 'command_policy' tool to see what's disallowed."
        )));
    }

    let (project, sid) = ensure_session(app, project_name).await?;
    // Record in the terminal history, tagged as MCP so the History dialog
    // can tell agent commands apart from the user's own.
    let _ = crate::commands::history::add(
        app.state::<AppState>().inner(),
        project.server_id,
        command.to_string(),
        HistorySource::Mcp,
    )
    .await;
    let session = app.state::<AppState>().sessions.get(&sid)?;
    let argv = vec!["bash".to_string(), "-lc".to_string(), command.to_string()];
    let (stdout, stderr, exit) =
        crate::ssh::exec::run_capturing(session, working_dir.as_deref(), &argv, 1024 * 1024).await?;
    Ok(pretty(json!({
        "exit_code": exit,
        "stdout": stdout,
        "stderr": stderr,
    })))
}

// ---------------- helpers ----------------

/// Upload the on-disk files from a `git status` / commit file list.
async fn upload_files(
    app: &AppHandle,
    project: &Project,
    session_id: &str,
    files: Vec<crate::commands::git::GitFile>,
    subset: Option<Vec<String>>,
) -> AppResult<String> {
    let mut uploaded: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for f in files.into_iter().filter(|f| f.exists_on_disk) {
        if let Some(sub) = &subset {
            if !sub.iter().any(|s| s == &f.relative_path) {
                continue;
            }
        }
        match crate::commands::deploy::deploy_file(
            project.id,
            f.relative_path.clone(),
            Some(session_id.to_string()),
            app.state(),
        )
        .await
        {
            Ok(()) => uploaded.push(f.relative_path),
            Err(e) => errors.push(format!("{}: {e}", f.relative_path)),
        }
    }
    Ok(pretty(json!({
        "uploaded": uploaded,
        "count": uploaded.len(),
        "errors": errors,
    })))
}

async fn find_project(app: &AppHandle, name: &str) -> AppResult<Project> {
    let projects = crate::commands::project::list_projects(app.state()).await?;
    let lname = name.to_lowercase();
    if let Some(p) = projects.iter().find(|p| p.name.to_lowercase() == lname) {
        return Ok(p.clone());
    }
    let names: Vec<String> = projects.iter().map(|p| p.name.clone()).collect();
    Err(AppError::Other(format!(
        "project '{name}' not found. Available projects: {}",
        if names.is_empty() {
            "(none configured)".to_string()
        } else {
            names.join(", ")
        }
    )))
}

/// Resolve a project by name and ensure it has a live session (reuse an
/// existing one, otherwise open a new one).
async fn ensure_session(app: &AppHandle, name: &str) -> AppResult<(Project, String)> {
    let project = find_project(app, name).await?;
    if let Some(existing) = app
        .state::<AppState>()
        .sessions
        .list()
        .into_iter()
        .find(|s| s.project_id == Some(project.id))
    {
        return Ok((project, existing.id));
    }
    let summary =
        crate::commands::session::open_session(project.server_id, Some(project.id), app.state())
            .await?;

    // Tell the UI to open a tab for this MCP-created session so the agent's
    // terminals / Activity / progress render exactly like a manual connect.
    let server_name = crate::commands::server::list_servers(app.state())
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|s| s.id == project.server_id)
        .map(|s| s.name);
    let label = match server_name {
        Some(name) if !name.is_empty() => format!("{name} · {}", project.name),
        _ => project.name.clone(),
    };
    let _ = app.emit(
        "mcp://session-opened",
        json!({
            "session": serde_json::to_value(&summary).unwrap_or(Value::Null),
            "label": label,
            "remote_path": project.remote_path,
        }),
    );

    Ok((project, summary.id))
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn arg_str(args: &Value, key: &str) -> AppResult<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Other(format!("missing required argument: {key}")))
}

fn arg_str_opt(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn arg_u32(args: &Value, key: &str) -> Option<u32> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u32)
}

fn arg_list(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()
    })
}

fn pretty(v: Value) -> String {
    serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string())
}

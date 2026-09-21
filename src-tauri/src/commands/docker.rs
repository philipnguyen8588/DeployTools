//! Docker Compose integration.
//!
//! Every action runs in the compose project's directory (`cd <dir> &&
//! docker compose …`) and streams output as activity events tagged with
//! `source = "docker"` (or `"docker-logs"` for follow mode).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::compose::{self, ComposeService, ParsedCompose};
use crate::errors::{AppError, AppResult};
use crate::models::Project;
use crate::ssh::exec::{self, ExecOpts};
use crate::state::AppState;

// ---------- info ----------

#[derive(Serialize, Clone)]
pub struct DockerInfo {
    pub detected: bool,
    pub compose_path: Option<PathBuf>,
    pub services: Vec<ComposeService>,
}

/// Parse the project's compose file locally. Returns `detected = false`
/// if no candidate file exists at the configured location.
#[tauri::command]
pub async fn docker_compose_info(
    project_id: Uuid,
    state: State<'_, AppState>,
) -> AppResult<DockerInfo> {
    let project = load_project(&state, project_id).await?;
    let compose_path =
        compose::discover(&project.local_path, project.compose_file.as_deref());
    let Some(path) = compose_path else {
        return Ok(DockerInfo {
            detected: false,
            compose_path: None,
            services: Vec::new(),
        });
    };

    let parsed: ParsedCompose = compose::parse_file(&path)?;
    Ok(DockerInfo {
        detected: true,
        compose_path: Some(parsed.compose_path),
        services: parsed.services,
    })
}

// ---------- ps ----------

#[derive(Serialize, Clone)]
pub struct ServiceStatus {
    pub service: String,
    /// Compose project-qualified container name (when running).
    pub name: Option<String>,
    pub image: Option<String>,
    pub state: String,   // "running" | "exited" | "created" | "restarting" | ""
    pub status: String,  // human-readable, e.g. "Up 2 hours (healthy)"
    pub health: Option<String>,
    pub exit_code: Option<i32>,
}

#[derive(Deserialize)]
struct PsRow {
    #[serde(default, rename = "Service")]
    service: String,
    #[serde(default, rename = "Name")]
    name: String,
    #[serde(default, rename = "Image")]
    image: String,
    #[serde(default, rename = "State")]
    state: String,
    #[serde(default, rename = "Status")]
    status: String,
    #[serde(default, rename = "Health")]
    health: String,
    #[serde(default, rename = "ExitCode")]
    exit_code: Option<i32>,
}

#[tauri::command]
pub async fn docker_compose_ps(
    session_id: String,
    project_id: Uuid,
    state: State<'_, AppState>,
) -> AppResult<Vec<ServiceStatus>> {
    let session = state.sessions.get(&session_id)?;
    let project = load_project(&state, project_id).await?;
    ensure_compose_v2(&state, &session_id).await?;
    let dir = remote_compose_dir(&project);

    let argv = vec![
        "docker".into(),
        "compose".into(),
        "ps".into(),
        "--all".into(),
        "--format".into(),
        "json".into(),
    ];
    let (stdout, _stderr, _code) =
        exec::run_capturing(session.clone(), Some(&dir), &argv, 4 * 1024 * 1024).await?;
    Ok(parse_ps_output(&stdout))
}

/// Compose V2.0–2.20 emits a JSON array; V2.21+ emits NDJSON.
/// Parser tries both.
fn parse_ps_output(stdout: &str) -> Vec<ServiceStatus> {
    let s = stdout.trim();
    if s.is_empty() {
        return Vec::new();
    }
    // Attempt array form.
    if let Ok(rows) = serde_json::from_str::<Vec<PsRow>>(s) {
        return rows.into_iter().map(row_to_status).collect();
    }
    // Fallback: NDJSON.
    s.lines()
        .filter_map(|l| serde_json::from_str::<PsRow>(l).ok())
        .map(row_to_status)
        .collect()
}

fn row_to_status(r: PsRow) -> ServiceStatus {
    ServiceStatus {
        service: r.service,
        name: (!r.name.is_empty()).then_some(r.name),
        image: (!r.image.is_empty()).then_some(r.image),
        state: r.state,
        status: r.status,
        health: (!r.health.is_empty()).then_some(r.health),
        exit_code: r.exit_code,
    }
}

// ---------- action ----------

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum DockerAction {
    Up,
    Down,
    Restart,
    Build,
    Pull,
    /// `docker compose run --rm <service>` — for one-off services.
    RunRm,
}

#[tauri::command]
pub async fn docker_compose_action(
    session_id: String,
    project_id: Uuid,
    action: DockerAction,
    service: Option<String>,
    #[allow(non_snake_case)] extraArgs: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> AppResult<i32> {
    let session = state.sessions.get(&session_id)?;
    let project = load_project(&state, project_id).await?;
    ensure_compose_v2(&state, &session_id).await?;
    let dir = remote_compose_dir(&project);

    let mut argv: Vec<String> = vec!["docker".into(), "compose".into()];
    let action_label: String;
    match action {
        DockerAction::Up => {
            argv.extend(["up".into(), "-d".into()]);
            if let Some(s) = &service {
                argv.push(s.clone());
            }
            action_label = format!("up{}", service.as_deref().map(|s| format!(" {s}")).unwrap_or_default());
        }
        DockerAction::Down => {
            argv.push("down".into());
            action_label = "down".into();
        }
        DockerAction::Restart => {
            argv.push("restart".into());
            if let Some(s) = &service {
                argv.push(s.clone());
            }
            action_label = format!("restart{}", service.as_deref().map(|s| format!(" {s}")).unwrap_or_default());
        }
        DockerAction::Build => {
            argv.push("build".into());
            if let Some(s) = &service {
                argv.push(s.clone());
            }
            action_label = format!("build{}", service.as_deref().map(|s| format!(" {s}")).unwrap_or_default());
        }
        DockerAction::Pull => {
            argv.push("pull".into());
            if let Some(s) = &service {
                argv.push(s.clone());
            }
            action_label = format!("pull{}", service.as_deref().map(|s| format!(" {s}")).unwrap_or_default());
        }
        DockerAction::RunRm => {
            let svc = service
                .clone()
                .ok_or_else(|| AppError::Other("run --rm requires a service".into()))?;
            argv.extend([
                "run".into(),
                "--rm".into(),
                "--remove-orphans".into(),
                svc.clone(),
            ]);
            if let Some(extra) = &extraArgs {
                argv.extend(extra.iter().cloned());
            }
            action_label = format!("run --rm {svc}");
        }
    }

    let _guard = state.acquire_mutating(&session_id, format!("docker {action_label}"))?;

    let result = exec::run_streaming(
        session.clone(),
        Some(&dir),
        &argv,
        "docker",
        ExecOpts {
            tag: service.clone(),
            ..Default::default()
        },
        None,
    )
    .await?;
    Ok(result.exit)
}

// ---------- logs follow / stop ----------

/// Start streaming `docker compose logs -f <svc?>` in the background.
/// Returns immediately; output arrives as batched activity events with
/// `source = "docker-logs"` and `tag = service_name_or_"all"`.
#[tauri::command]
pub async fn docker_compose_logs_follow(
    session_id: String,
    project_id: Uuid,
    service: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let session = state.sessions.get(&session_id)?;
    let project = load_project(&state, project_id).await?;
    ensure_compose_v2(&state, &session_id).await?;
    let dir = remote_compose_dir(&project);

    let tag = service.clone().unwrap_or_else(|| "all".into());
    let key = (session_id.clone(), tag.clone());
    if state.follow_cancellers.contains_key(&key) {
        return Err(AppError::CommandInFlight(format!(
            "logs follow already running for {tag}"
        )));
    }
    let (tx, rx) = oneshot::channel::<()>();
    state.follow_cancellers.insert(key.clone(), tx);

    let mut argv: Vec<String> = vec![
        "docker".into(),
        "compose".into(),
        "logs".into(),
        "-f".into(),
        "--no-color".into(),
        "--no-log-prefix".into(),
        "--tail=200".into(),
    ];
    if let Some(s) = &service {
        argv.push(s.clone());
    }

    // Spawn the stream; it'll emit batched events and clean up on exit.
    let sess = session.clone();
    let follow_cancellers = state.follow_cancellers.clone();
    tokio::spawn(async move {
        let _ = exec::run_streaming(
            sess,
            Some(&dir),
            &argv,
            "docker-logs",
            ExecOpts {
                batch: true,
                tag: Some(tag.clone()),
                ..Default::default()
            },
            Some(rx),
        )
        .await;
        follow_cancellers.remove(&key);
    });

    Ok(())
}

#[tauri::command]
pub async fn docker_compose_logs_stop(
    session_id: String,
    service: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let tag = service.unwrap_or_else(|| "all".into());
    if let Some((_, sender)) = state.follow_cancellers.remove(&(session_id, tag)) {
        let _ = sender.send(());
    }
    Ok(())
}

// ---------- exec shell (spawns a new terminal tab) ----------

#[tauri::command]
pub async fn docker_compose_exec_shell(
    session_id: String,
    project_id: Uuid,
    service: String,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let session = state.sessions.get(&session_id)?;
    let project = load_project(&state, project_id).await?;
    let dir = remote_compose_dir(&project);
    ensure_compose_v2(&state, &session_id).await?;

    // Open a new terminal channel inside the session, seed with an
    // auto-shell command that prefers bash but falls back to sh.
    // Backend-initiated, so we mint the id here (the frontend attaches
    // its listener to the returned id).
    // no_auto_cd = true: this terminal is seeded with a `docker compose
    // exec` into a container; a late project auto-cd would run inside it.
    let terminal_id =
        crate::ssh::terminal::open(session.clone(), Uuid::new_v4().to_string(), 80, 24, true)
            .await?;

    // Build the seeded line as user-input to the shell.
    let seed = format!(
        "cd {} && docker compose exec {} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'\n",
        crate::ssh::quote::shell_single_quote(&dir),
        crate::ssh::quote::shell_single_quote(&service),
    );
    crate::ssh::terminal::write(&session, &terminal_id, seed.into_bytes())?;
    Ok(terminal_id)
}

// ---------- helpers ----------

async fn load_project(state: &AppState, id: Uuid) -> AppResult<Project> {
    state
        .vault
        .read(|d| d.projects.iter().find(|p| p.id == id).cloned())
        .await?
        .ok_or_else(|| AppError::ProjectNotFound(id.to_string()))
}

fn remote_compose_dir(project: &Project) -> String {
    // If the compose file override is a relative path with a parent,
    // cd into that parent on the remote; else stay in remote_path.
    if let Some(rel) = &project.compose_file {
        if !rel.as_os_str().is_empty() {
            if let Some(parent) = Path::new(rel).parent() {
                let parent_str = parent.to_string_lossy();
                if !parent_str.is_empty() {
                    let base = project.remote_path.trim_end_matches('/');
                    return format!("{}/{}", base, parent_str.replace('\\', "/"));
                }
            }
        }
    }
    project.remote_path.clone()
}

async fn ensure_compose_v2(state: &AppState, session_id: &str) -> AppResult<()> {
    let session = state.sessions.get(session_id)?;
    {
        let mut slot = session.capabilities.write().await;
        if slot.is_none() {
            *slot = Some(crate::ssh::capabilities::probe(session.clone()).await);
        }
    }
    let caps = session.capabilities.read().await.clone().unwrap_or_default();
    if !caps.compose_v2.unwrap_or(false) {
        return Err(AppError::FeatureUnavailable(
            "Docker Compose V2 not found. Install docker-compose-plugin.".into(),
        ));
    }
    Ok(())
}

/// Public helper exposed so the frontend can force a re-probe when
/// installing docker mid-session.
#[tauri::command]
pub async fn session_capabilities(
    session_id: String,
    state: State<'_, AppState>,
) -> AppResult<crate::ssh::capabilities::SessionCapabilities> {
    let session = state.sessions.get(&session_id)?;
    let caps = crate::ssh::capabilities::probe(session.clone()).await;
    *session.capabilities.write().await = Some(caps.clone());
    Ok(caps)
}

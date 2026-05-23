//! Project CRUD.

use tauri::State;
use uuid::Uuid;

use crate::errors::AppResult;
use crate::models::Project;
use crate::state::AppState;

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    state.vault.read(|d| d.projects.clone()).await
}

#[tauri::command]
pub async fn save_project(mut project: Project, state: State<'_, AppState>) -> AppResult<Project> {
    if project.id.is_nil() {
        project.id = Uuid::new_v4();
    }
    state
        .vault
        .write(|data| {
            if let Some(existing) = data.projects.iter_mut().find(|p| p.id == project.id) {
                *existing = project.clone();
            } else {
                data.projects.push(project.clone());
            }
        })
        .await?;
    Ok(project)
}

#[tauri::command]
pub async fn delete_project(id: Uuid, state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(|data| {
            data.projects.retain(|p| p.id != id);
        })
        .await
}

/// Reorder projects under a given server, assigning `order = 0..n` in
/// the supplied id sequence. Also re-parents each id to `server_id` so
/// the UI can move a project between servers via drag-drop.
#[tauri::command]
pub async fn reorder_projects(
    server_id: Uuid,
    ids: Vec<Uuid>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state
        .vault
        .write(|data| {
            for (i, id) in ids.iter().enumerate() {
                if let Some(p) = data.projects.iter_mut().find(|p| p.id == *id) {
                    p.server_id = server_id;
                    p.order = i as i32;
                }
            }
        })
        .await
}

//! Server-group CRUD + reorder.
//!
//! Groups are a pure UI organizational feature — they don't affect how
//! servers are connected to or stored. A server with `group_id = None`
//! is rendered in a synthetic "Ungrouped" bucket that always sits above
//! the user's real groups.

use tauri::State;
use uuid::Uuid;

use crate::errors::AppResult;
use crate::models::ServerGroup;
use crate::state::AppState;

/// List user-defined groups, sorted by ascending `order`. Does NOT
/// include the virtual "Ungrouped" bucket — the frontend synthesises
/// that for servers with `group_id = None`.
#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> AppResult<Vec<ServerGroup>> {
    state
        .vault
        .read(|d| {
            let mut g = d.groups.clone();
            g.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
            g
        })
        .await
}

/// Create or update a group. A nil incoming id means "create new"; the
/// server assigns a fresh UUID and appends to the end (max order + 1).
/// Updates preserve the existing `order` — use `reorder_groups` for that.
#[tauri::command]
pub async fn save_group(
    mut group: ServerGroup,
    state: State<'_, AppState>,
) -> AppResult<ServerGroup> {
    if group.id.is_nil() {
        group.id = Uuid::new_v4();
    }
    let trimmed = group.name.trim();
    if trimmed.is_empty() {
        group.name = "New group".into();
    } else {
        group.name = trimmed.to_string();
    }

    let saved = state
        .vault
        .write(|data| {
            if let Some(existing) = data.groups.iter_mut().find(|g| g.id == group.id) {
                existing.name = group.name.clone();
                existing.clone()
            } else {
                let max_order = data.groups.iter().map(|g| g.order).max().unwrap_or(-1);
                group.order = max_order + 1;
                data.groups.push(group.clone());
                group.clone()
            }
        })
        .await?;
    Ok(saved)
}

/// Delete a group. Servers in this group are not deleted — they move to
/// the virtual "Ungrouped" bucket (`group_id = None`). That way the user
/// never accidentally loses a server by trashing its label.
#[tauri::command]
pub async fn delete_group(id: Uuid, state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(|data| {
            data.groups.retain(|g| g.id != id);
            for s in data.servers.iter_mut() {
                if s.group_id == Some(id) {
                    s.group_id = None;
                }
            }
        })
        .await
}

/// Assign `order = 0..n` to the given group ids in the listed sequence.
/// Ids not present in the vault are silently ignored (safe against
/// stale frontend state).
#[tauri::command]
pub async fn reorder_groups(ids: Vec<Uuid>, state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(|data| {
            for (i, id) in ids.iter().enumerate() {
                if let Some(g) = data.groups.iter_mut().find(|g| g.id == *id) {
                    g.order = i as i32;
                }
            }
        })
        .await
}

//! Tauri command handlers for the Cloudflare panel.
//!
//! All calls require the vault to be unlocked AND a token to be set.
//! The token itself is only ever sent in the `Authorization: Bearer …`
//! header from the Rust side; it's never surfaced to the frontend.

use tauri::State;

use crate::cloudflare::{Cloudflare, DnsRecord, RecordInput, Zone};
use crate::errors::{AppError, AppResult};
use crate::models::Secret;
use crate::state::AppState;

async fn build_client(state: &AppState) -> AppResult<Cloudflare> {
    let token: Option<String> = state
        .vault
        .read(|d| d.cloudflare_token.as_ref().map(|s| s.expose().to_string()))
        .await?;
    let token = token.ok_or_else(|| {
        AppError::Other("Cloudflare token is not set".to_string())
    })?;
    Cloudflare::new(token)
}

#[tauri::command]
pub async fn cf_has_token(state: State<'_, AppState>) -> AppResult<bool> {
    state
        .vault
        .read(|d| d.cloudflare_token.as_ref().is_some_and(|s| !s.is_empty()))
        .await
}

#[tauri::command]
pub async fn cf_set_token(token: String, state: State<'_, AppState>) -> AppResult<String> {
    // First verify the token before we persist it — avoids saving garbage.
    let probe = Cloudflare::new(token.clone())?;
    let status = probe.verify_token().await?;
    state
        .vault
        .write(|d| {
            d.cloudflare_token = Some(Secret(token));
        })
        .await?;
    Ok(status)
}

#[tauri::command]
pub async fn cf_clear_token(state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(|d| {
            d.cloudflare_token = None;
        })
        .await
}

#[tauri::command]
pub async fn cf_verify(state: State<'_, AppState>) -> AppResult<String> {
    let cf = build_client(&state).await?;
    cf.verify_token().await
}

#[tauri::command]
pub async fn cf_list_zones(state: State<'_, AppState>) -> AppResult<Vec<Zone>> {
    let cf = build_client(&state).await?;
    cf.list_zones().await
}

#[tauri::command]
pub async fn cf_list_records(
    zone_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<DnsRecord>> {
    let cf = build_client(&state).await?;
    cf.list_records(&zone_id).await
}

#[tauri::command]
pub async fn cf_update_record(
    zone_id: String,
    record_id: String,
    payload: RecordInput,
    state: State<'_, AppState>,
) -> AppResult<DnsRecord> {
    let cf = build_client(&state).await?;
    cf.update_record(&zone_id, &record_id, &payload).await
}

#[tauri::command]
pub async fn cf_create_record(
    zone_id: String,
    payload: RecordInput,
    state: State<'_, AppState>,
) -> AppResult<DnsRecord> {
    let cf = build_client(&state).await?;
    cf.create_record(&zone_id, &payload).await
}

#[tauri::command]
pub async fn cf_delete_record(
    zone_id: String,
    record_id: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let cf = build_client(&state).await?;
    cf.delete_record(&zone_id, &record_id).await
}

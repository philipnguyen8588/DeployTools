//! Thin wrapper around the Cloudflare REST API v4.
//!
//! We only need zone listing + DNS record CRUD for the UI. The API
//! token is read from the unlocked vault on every call, so the user can
//! update it without restarting the app.

use reqwest::{Client, Method, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::{AppError, AppResult};

const API_BASE: &str = "https://api.cloudflare.com/client/v4";

/// Cached HTTP client reused across calls — reqwest::Client is cheap
/// to clone but not free to construct.
fn build_client() -> AppResult<Client> {
    Client::builder()
        .user_agent("AutoDeployment/0.1")
        .use_rustls_tls()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))
}

pub struct Cloudflare {
    token: String,
    client: Client,
}

impl Cloudflare {
    pub fn new(token: String) -> AppResult<Self> {
        Ok(Self {
            token,
            client: build_client()?,
        })
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{API_BASE}{path}"))
            .bearer_auth(&self.token)
    }

    /// `GET /user/tokens/verify` — sanity-check the token without
    /// exposing any account data.
    pub async fn verify_token(&self) -> AppResult<String> {
        let res = self
            .req(Method::GET, "/user/tokens/verify")
            .send()
            .await
            .map_err(|e| AppError::Other(format!("cf verify: {e}")))?;
        let body: ApiResponse<Value> = res
            .json()
            .await
            .map_err(|e| AppError::Other(format!("cf verify parse: {e}")))?;
        if !body.success {
            return Err(AppError::Other(format!(
                "cloudflare token invalid: {}",
                first_error(&body)
            )));
        }
        Ok(body
            .result
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| "active".to_string()))
    }

    /// `GET /zones` — all zones visible to this token.
    pub async fn list_zones(&self) -> AppResult<Vec<Zone>> {
        let mut out = Vec::new();
        let mut page = 1u32;
        loop {
            let res = self
                .req(Method::GET, &format!("/zones?per_page=50&page={page}"))
                .send()
                .await
                .map_err(|e| AppError::Other(format!("cf zones: {e}")))?;
            let text = res
                .text()
                .await
                .map_err(|e| AppError::Other(format!("cf zones body: {e}")))?;
            let body: ApiResponse<Vec<Zone>> =
                serde_json::from_str(&text).map_err(|e| {
                    let snippet: String = text.chars().take(800).collect();
                    AppError::Other(format!("cf zones parse: {e}\nbody: {snippet}"))
                })?;
            if !body.success {
                return Err(AppError::Other(first_error(&body)));
            }
            let zones = body.result.unwrap_or_default();
            let got = zones.len();
            out.extend(zones);
            let total_pages = body
                .result_info
                .and_then(|r| r.total_pages)
                .unwrap_or(1);
            if got == 0 || page >= total_pages {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn list_records(&self, zone_id: &str) -> AppResult<Vec<DnsRecord>> {
        let mut out = Vec::new();
        let mut page = 1u32;
        loop {
            let res = self
                .req(
                    Method::GET,
                    &format!("/zones/{zone_id}/dns_records?per_page=100&page={page}"),
                )
                .send()
                .await
                .map_err(|e| AppError::Other(format!("cf records: {e}")))?;
            // Read as text first so we can include a snippet on parse
            // errors — Cloudflare keeps adding fields to this response.
            let text = res
                .text()
                .await
                .map_err(|e| AppError::Other(format!("cf records body: {e}")))?;
            let body: ApiResponse<Vec<DnsRecord>> = serde_json::from_str(&text)
                .map_err(|e| {
                    let snippet: String = text.chars().take(800).collect();
                    AppError::Other(format!(
                        "cf records parse: {e}\nbody: {snippet}"
                    ))
                })?;
            if !body.success {
                return Err(AppError::Other(first_error(&body)));
            }
            let records = body.result.unwrap_or_default();
            let got = records.len();
            out.extend(records);
            let total_pages = body
                .result_info
                .and_then(|r| r.total_pages)
                .unwrap_or(1);
            if got == 0 || page >= total_pages {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn update_record(
        &self,
        zone_id: &str,
        record_id: &str,
        payload: &RecordInput,
    ) -> AppResult<DnsRecord> {
        let res = self
            .req(
                Method::PUT,
                &format!("/zones/{zone_id}/dns_records/{record_id}"),
            )
            .json(payload)
            .send()
            .await
            .map_err(|e| AppError::Other(format!("cf update: {e}")))?;
        let body: ApiResponse<DnsRecord> = res
            .json()
            .await
            .map_err(|e| AppError::Other(format!("cf update parse: {e}")))?;
        if !body.success {
            return Err(AppError::Other(first_error(&body)));
        }
        body.result
            .ok_or_else(|| AppError::Other("cf update: empty result".into()))
    }

    pub async fn create_record(
        &self,
        zone_id: &str,
        payload: &RecordInput,
    ) -> AppResult<DnsRecord> {
        let res = self
            .req(Method::POST, &format!("/zones/{zone_id}/dns_records"))
            .json(payload)
            .send()
            .await
            .map_err(|e| AppError::Other(format!("cf create: {e}")))?;
        let body: ApiResponse<DnsRecord> = res
            .json()
            .await
            .map_err(|e| AppError::Other(format!("cf create parse: {e}")))?;
        if !body.success {
            return Err(AppError::Other(first_error(&body)));
        }
        body.result
            .ok_or_else(|| AppError::Other("cf create: empty result".into()))
    }

    pub async fn delete_record(&self, zone_id: &str, record_id: &str) -> AppResult<()> {
        let res = self
            .req(
                Method::DELETE,
                &format!("/zones/{zone_id}/dns_records/{record_id}"),
            )
            .send()
            .await
            .map_err(|e| AppError::Other(format!("cf delete: {e}")))?;
        let body: ApiResponse<Value> = res
            .json()
            .await
            .map_err(|e| AppError::Other(format!("cf delete parse: {e}")))?;
        if !body.success {
            return Err(AppError::Other(first_error(&body)));
        }
        Ok(())
    }
}

// ---- Wire types ----

// NB: avoid `#[serde(default)]` on the `Option<T>` fields. serde's
// derive adds a `T: Default` bound when that attribute is present, and
// `DnsRecord` is not `Default`. Missing `Option<T>` fields already
// deserialize to `None` without the hint.
#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<ApiError>,
    result: Option<T>,
    result_info: Option<ResultInfo>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ResultInfo {
    total_pages: Option<u32>,
}

fn first_error<T>(r: &ApiResponse<T>) -> String {
    r.errors
        .first()
        .map(|e| format!("[{}] {}", e.code, e.message))
        .unwrap_or_else(|| "cloudflare: unknown error".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub r#type: String,
}

// `DnsRecord` is intentionally permissive: Cloudflare periodically adds
// new fields to this response (settings, meta, tags_modified_on, …) and
// some record types (SRV, URI) have different shapes. We tolerate all
// of that by declaring only the fields we actually surface in the UI
// and leaving everything else to be silently ignored by serde.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsRecord {
    pub id: String,
    #[serde(default)]
    pub zone_id: String,
    #[serde(default)]
    pub zone_name: String,
    pub name: String,
    pub r#type: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub ttl: u32,
    #[serde(default)]
    pub proxied: bool,
    // Cloudflare returns priority as a number for MX / URI, may be null
    // or absent for everything else, and for SRV it lives under `data`.
    // Use a wider integer type to avoid overflow surprises.
    #[serde(default, deserialize_with = "de_opt_u32")]
    pub priority: Option<u32>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// Accept null, missing, or any integer for `priority`.
fn de_opt_u32<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Number(n)) => n.as_u64().map(|x| x as u32),
        _ => None, // tolerate weird shapes
    })
}

/// Payload for create / update. Only the fields the user can actually
/// edit are exposed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordInput {
    pub r#type: String,
    pub name: String,
    pub content: String,
    #[serde(default = "default_ttl")]
    pub ttl: u32,
    #[serde(default)]
    pub proxied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

fn default_ttl() -> u32 {
    1 // Cloudflare's "Auto" sentinel
}

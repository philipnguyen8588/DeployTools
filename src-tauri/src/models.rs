//! Persistent data model. Everything in `VaultData` is encrypted at rest.
//!
//! Secrets (`password`, private key passphrase) are wrapped in [`Secret`]
//! so they are zeroized on drop and never accidentally serialized to logs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// A string that zeroizes its memory when dropped.
/// Serializes transparently; debug output is redacted.
#[derive(Clone, Default, Zeroize, ZeroizeOnDrop, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret(<redacted, {} bytes>)", self.0.len())
    }
}

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<String> for Secret {
    fn from(s: String) -> Self {
        Secret(s)
    }
}

/// SSH authentication method.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthMethod {
    Password {
        password: Secret,
    },
    PrivateKey {
        key_path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<Secret>,
    },
}

/// Wire protocol used to reach the server. `Ssh` gives you the full
/// feature set (terminal, Docker, services, compare). `Ftp` / `Ftps`
/// only support the file browser + single-file / folder upload and
/// download (no exec, no compare yet).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    #[default]
    Ssh,
    Ftp,
    /// FTP with explicit TLS (AUTH TLS).
    Ftps,
}

impl Protocol {
    pub fn is_ssh(&self) -> bool {
        matches!(self, Protocol::Ssh)
    }
    pub fn is_ftp(&self) -> bool {
        matches!(self, Protocol::Ftp | Protocol::Ftps)
    }
}

/// A remote server profile — SSH, FTP, or FTPS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    /// Backward-compatible: pre-existing vaults have no `protocol` field
    /// and default to SSH.
    #[serde(default)]
    pub protocol: Protocol,

    /// SHA-256 fingerprint of the server's host key, pinned after first
    /// successful connection. Mismatch on subsequent connections triggers
    /// a warning (MITM protection). Only applies to SSH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key_fingerprint: Option<String>,
}

fn default_port() -> u16 {
    22
}

/// A local ↔ remote mapping. Multiple projects can share a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub server_id: Uuid,
    pub local_path: PathBuf,
    pub remote_path: String,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default = "default_rsync_flags")]
    pub rsync_flags: String,
    /// Optional override for the Docker Compose file. Relative paths are
    /// resolved against `local_path` (and, for remote execution,
    /// `remote_path`). When absent, we auto-detect among
    /// `docker-compose.{yml,yaml}` and `compose.{yml,yaml}` at the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compose_file: Option<PathBuf>,
}

fn default_rsync_flags() -> String {
    "-avz --delete".to_string()
}

/// Top-level payload that gets encrypted and written to `vault.enc`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VaultData {
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Cloudflare API token. When absent, the Cloudflare panel is
    /// disabled in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloudflare_token: Option<Secret>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
}

// ---------- Snippets ----------

/// A user-defined shell command template that can be run on any SSH
/// session. Commands may reference `{{KEY}}` placeholders resolved at
/// run time either from built-in variables (HOST/USER/PORT/…) or from
/// user-supplied values declared in `variables`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub command: String,
    #[serde(default)]
    pub variables: Vec<SnippetVar>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetVar {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub kind: SnippetVarKind,
    /// Used when `kind = Choice`. Empty otherwise.
    #[serde(default)]
    pub choices: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SnippetVarKind {
    #[default]
    Text,
    Path,
    Secret,
    Choice,
}

/// Redacted summary of a server — safe to expose to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ServerSummary {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: &'static str,
    pub protocol: Protocol,
    pub has_fingerprint: bool,
}

impl From<&Server> for ServerSummary {
    fn from(s: &Server) -> Self {
        Self {
            id: s.id,
            name: s.name.clone(),
            host: s.host.clone(),
            port: s.port,
            user: s.user.clone(),
            auth_kind: match s.auth {
                AuthMethod::Password { .. } => "password",
                AuthMethod::PrivateKey { .. } => "key",
            },
            protocol: s.protocol,
            has_fingerprint: s.host_key_fingerprint.is_some(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_is_redacted() {
        let s = Secret("hunter2".to_string());
        let debug = format!("{s:?}");
        assert!(!debug.contains("hunter2"));
        assert!(debug.contains("redacted"));
    }

    #[test]
    fn vault_data_roundtrips_json() {
        let data = VaultData {
            servers: vec![Server {
                id: Uuid::new_v4(),
                name: "prod".into(),
                host: "1.2.3.4".into(),
                port: 22,
                user: "deploy".into(),
                auth: AuthMethod::Password {
                    password: Secret("p".into()),
                },
                host_key_fingerprint: None,
            }],
            projects: vec![],
        };
        let j = serde_json::to_string(&data).unwrap();
        let back: VaultData = serde_json::from_str(&j).unwrap();
        assert_eq!(back.servers.len(), 1);
    }
}

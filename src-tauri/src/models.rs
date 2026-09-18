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
        /// Either an absolute path to a private-key file (default) OR the
        /// raw PEM content itself when the string starts with
        /// "-----BEGIN". The UI lets the user paste either — the runtime
        /// dispatches based on the prefix.
        key_path: String,
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

/// Inline jump host (bastion) config. When set on a `Server`, the SSH
/// connection is tunneled: we connect to this host first, then open a
/// `direct-tcpip` channel to the real target through it (OpenSSH
/// ProxyJump). Self-contained credentials — not a reference to another
/// saved server. SSH only. Single hop (no nested jump host).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpHost {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    /// Pinned SHA-256 host-key fingerprint of the jump host itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key_fingerprint: Option<String>,
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

    /// Optional jump host (bastion) to tunnel this SSH connection through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<JumpHost>,

    /// Optional group membership. `None` means the server sits in the
    /// virtual "Ungrouped" bucket at the top of the sidebar — the
    /// migration-free default for vaults that predate groups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,

    /// Position within its group (ascending). Assigned via
    /// `commands::server::reorder_servers`. Defaults to 0 which means
    /// the server falls back to name-sort until the user drags it.
    #[serde(default)]
    pub order: i32,
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

    /// Position within its parent server (ascending). Old vaults default
    /// to 0 — projects then sort by name until the user drags them.
    #[serde(default)]
    pub order: i32,
}

fn default_rsync_flags() -> String {
    "-avz --delete".to_string()
}

/// Top-level payload that gets encrypted and written to `vault.enc`.
/// One line the user typed into a terminal, keyed by server. Stored in
/// the encrypted vault alongside everything else so it only exists in
/// plaintext while the vault is unlocked.
/// Who issued a command — the user typing in the terminal, or an AI agent
/// via the MCP `run_command` tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistorySource {
    #[default]
    User,
    Mcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalHistoryEntry {
    pub id: Uuid,
    pub server_id: Uuid,
    pub command: String,
    /// Milliseconds since Unix epoch.
    pub time_ms: u64,
    /// Who ran it. Old vaults default to `user`.
    #[serde(default)]
    pub source: HistorySource,
}

/// One MCP tool invocation, recorded for auditing ("what did the agent
/// do?"). Stored in the encrypted vault like everything else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpActivityEntry {
    pub id: Uuid,
    /// Milliseconds since Unix epoch.
    pub time_ms: u64,
    /// Tool name, e.g. `run_command`, `sync`, `upload_changed_files`.
    pub tool: String,
    /// Project the tool targeted, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Short human summary (the command, or ok/error status).
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VaultData {
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// Server groups — user-defined labels that cluster servers in the
    /// sidebar. Old vaults have none; the UI renders an implicit
    /// "Ungrouped" bucket for servers with `group_id = None`.
    #[serde(default)]
    pub groups: Vec<ServerGroup>,
    /// Cloudflare API token. When absent, the Cloudflare panel is
    /// disabled in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloudflare_token: Option<Secret>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    /// Commands the user typed into the integrated terminal, keyed by
    /// server. Capped per server at a sane upper bound; see
    /// `commands::history::HISTORY_CAP`.
    #[serde(default)]
    pub terminal_history: Vec<TerminalHistoryEntry>,

    // --- MCP (AI agent control) — kept in the vault so there's no
    // separate plaintext settings file for it. ---
    /// Whether the embedded MCP server is enabled. `None` = default (true).
    #[serde(default)]
    pub mcp_enabled: Option<bool>,
    /// TCP port bound on 127.0.0.1. `None` = default.
    #[serde(default)]
    pub mcp_port: Option<u16>,
    /// Bearer token required on every MCP request. Generated on first use.
    #[serde(default)]
    pub mcp_token: Option<String>,
    /// Command guard mode for `run_command`: `off` | `deny` | `disabled`.
    #[serde(default)]
    pub mcp_cmd_mode: Option<String>,
    /// Denied program basenames for the `deny` guard. `None` = built-ins.
    #[serde(default)]
    pub mcp_cmd_denylist: Option<Vec<String>>,
    /// Audit log of MCP tool invocations (newest appended last).
    #[serde(default)]
    pub mcp_activity: Vec<McpActivityEntry>,
}

/// A named bucket that groups a handful of related servers together in
/// the sidebar — e.g. "Production", "Staging", "Clients". Groups can be
/// reordered (via `order`) and renamed; servers with `group_id = None`
/// render in a synthetic "Ungrouped" bucket that sits above the real
/// groups and is never persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerGroup {
    pub id: Uuid,
    pub name: String,
    /// Ascending sort position. Ties break by name.
    #[serde(default)]
    pub order: i32,
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
    /// True when this server connects through a jump host (for a badge).
    pub has_jump: bool,
    /// Group membership — `None` for the virtual "Ungrouped" bucket.
    pub group_id: Option<Uuid>,
    pub order: i32,
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
            has_jump: s.jump_host.is_some(),
            group_id: s.group_id,
            order: s.order,
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
                protocol: Protocol::default(),
                host_key_fingerprint: None,
                group_id: None,
                order: 0,
            }],
            ..Default::default()
        };
        let j = serde_json::to_string(&data).unwrap();
        let back: VaultData = serde_json::from_str(&j).unwrap();
        assert_eq!(back.servers.len(), 1);
    }

    /// Pre-group vaults must deserialize cleanly — all new fields have
    /// `#[serde(default)]` so missing keys fall back to sensible values.
    #[test]
    fn legacy_vault_without_groups_deserializes() {
        let legacy = r#"{
            "servers": [{
                "id": "11111111-1111-1111-1111-111111111111",
                "name": "legacy",
                "host": "10.0.0.1",
                "port": 22,
                "user": "root",
                "auth": { "kind": "password", "password": "x" }
            }],
            "projects": [{
                "id": "22222222-2222-2222-2222-222222222222",
                "name": "app",
                "server_id": "11111111-1111-1111-1111-111111111111",
                "local_path": "/tmp",
                "remote_path": "/srv/app"
            }]
        }"#;
        let v: VaultData = serde_json::from_str(legacy).unwrap();
        assert_eq!(v.servers.len(), 1);
        assert_eq!(v.servers[0].group_id, None);
        assert_eq!(v.servers[0].order, 0);
        assert_eq!(v.projects[0].order, 0);
        assert!(v.groups.is_empty());
    }
}

//! Encrypted vault for persisting `VaultData`.
//!
//! Layout:
//!   vault.enc = [ magic | version | salt | nonce | ciphertext+tag ]
//!
//! The encryption key is derived with Argon2id from the user's master
//! password. The plaintext key is only ever held in the `Vault::key` field
//! (inside `RwLock`) and is zeroized when the vault is locked.

pub mod crypto;
pub mod store;

use crate::errors::{AppError, AppResult};
use crate::models::{Snippet, SnippetVar, SnippetVarKind, VaultData};
use std::path::PathBuf;
use tokio::sync::RwLock;
use uuid::Uuid;
use zeroize::Zeroizing;

/// Seeded snippets pre-loaded on first vault creation. These cover the
/// very common ops workflows (Docker Compose, git pull, systemctl,
/// log tails, disk check) so a new user has something usable out of
/// the box. Each snippet uses the built-in `{{REMOTE_PATH}}` or the
/// user-prompted `{{APP_NAME}}` / `{{SERVICE}}` / `{{CONTAINER}}`
/// variable to stay project-agnostic.
fn default_snippets() -> Vec<Snippet> {
    let app_var = || SnippetVar {
        key: "APP_NAME".into(),
        label: "Compose service".into(),
        default: None,
        kind: SnippetVarKind::Text,
        choices: Vec::new(),
    };
    let service_var = || SnippetVar {
        key: "SERVICE".into(),
        label: "systemd unit (e.g. nginx)".into(),
        default: None,
        kind: SnippetVarKind::Text,
        choices: Vec::new(),
    };
    let container_var = || SnippetVar {
        key: "CONTAINER".into(),
        label: "Container name".into(),
        default: None,
        kind: SnippetVarKind::Text,
        choices: Vec::new(),
    };
    vec![
        // ---- Docker Compose ----
        Snippet {
            id: Uuid::new_v4(),
            name: "compose: logs -f".into(),
            description: "Follow the last 100 lines of a Compose service.".into(),
            command: "docker compose logs -f {{APP_NAME}} -n 100".into(),
            variables: vec![app_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "compose: restart".into(),
            description: "Restart one Compose service (in-place).".into(),
            command: "docker compose restart {{APP_NAME}}".into(),
            variables: vec![app_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "compose: up -d".into(),
            description: "Start/update a Compose service in detached mode.".into(),
            command: "docker compose up {{APP_NAME}} -d".into(),
            variables: vec![app_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "compose: down".into(),
            description: "Stop + remove ALL services in this project.".into(),
            command: "docker compose down".into(),
            variables: Vec::new(),
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "compose: build + up -d".into(),
            description: "Rebuild image then recreate the service.".into(),
            command:
                "docker compose build {{APP_NAME}} && docker compose up {{APP_NAME}} -d"
                    .into(),
            variables: vec![app_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "compose: ps".into(),
            description: "List Compose services + state.".into(),
            command: "docker compose ps".into(),
            variables: Vec::new(),
        },
        // ---- Docker (raw) ----
        Snippet {
            id: Uuid::new_v4(),
            name: "docker: logs -f".into(),
            description: "Tail a container's log (by container name).".into(),
            command: "docker logs -f --tail 100 {{CONTAINER}}".into(),
            variables: vec![container_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "docker: system prune".into(),
            description: "Free space: remove stopped containers + dangling images/volumes.".into(),
            command: "docker system prune -f".into(),
            variables: Vec::new(),
        },
        // ---- Git ----
        Snippet {
            id: Uuid::new_v4(),
            name: "git: pull".into(),
            description: "Pull latest code in the project's remote dir.".into(),
            command: "git pull --ff-only".into(),
            variables: Vec::new(),
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "git: status".into(),
            description: "Show working tree status.".into(),
            command: "git status".into(),
            variables: Vec::new(),
        },
        // ---- systemd ----
        Snippet {
            id: Uuid::new_v4(),
            name: "systemd: restart".into(),
            description: "Restart a systemd unit.".into(),
            command: "sudo systemctl restart {{SERVICE}}".into(),
            variables: vec![service_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "systemd: status".into(),
            description: "Show unit status + last log lines.".into(),
            command: "sudo systemctl status {{SERVICE}} --no-pager -n 20".into(),
            variables: vec![service_var()],
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "journal: tail".into(),
            description: "Follow a unit's journal.".into(),
            command: "sudo journalctl -u {{SERVICE}} -f -n 100".into(),
            variables: vec![service_var()],
        },
        // ---- System ----
        Snippet {
            id: Uuid::new_v4(),
            name: "disk usage".into(),
            description: "Show mounted filesystem usage.".into(),
            command: "df -h".into(),
            variables: Vec::new(),
        },
        Snippet {
            id: Uuid::new_v4(),
            name: "top processes".into(),
            description: "Top 20 processes by memory.".into(),
            command: "ps aux --sort=-%mem | head -21".into(),
            variables: Vec::new(),
        },
    ]
}

/// Runtime vault state. Held inside `AppState` in an `Arc<Vault>`.
pub struct Vault {
    file_path: PathBuf,
    inner: RwLock<VaultInner>,
}

struct VaultInner {
    /// Decryption key (32 bytes). `None` means locked.
    key: Option<Zeroizing<[u8; 32]>>,
    /// Decrypted payload. `None` means locked or not yet loaded.
    data: Option<VaultData>,
    /// Salt used when the vault file was created. Required for re-encrypt.
    salt: Option<[u8; crypto::SALT_LEN]>,
}

impl Vault {
    pub fn new(file_path: PathBuf) -> Self {
        Self {
            file_path,
            inner: RwLock::new(VaultInner {
                key: None,
                data: None,
                salt: None,
            }),
        }
    }

    pub fn file_path(&self) -> &PathBuf {
        &self.file_path
    }

    /// Does a vault file exist on disk?
    pub async fn exists(&self) -> bool {
        tokio::fs::try_exists(&self.file_path).await.unwrap_or(false)
    }

    /// True if a key is currently held (unlocked).
    pub async fn is_unlocked(&self) -> bool {
        self.inner.read().await.key.is_some()
    }

    /// Create a brand new vault with the given master password and
    /// an empty `VaultData`. Overwrites any existing file.
    pub async fn initialize(&self, master_password: &str) -> AppResult<()> {
        let salt = crypto::random_salt();
        let key = crypto::derive_key(master_password, &salt)?;
        let mut data = VaultData::default();
        data.snippets = default_snippets();

        store::write_vault(&self.file_path, &salt, &key, &data).await?;

        let mut inner = self.inner.write().await;
        inner.key = Some(key);
        inner.salt = Some(salt);
        inner.data = Some(data);
        Ok(())
    }

    /// Unlock using the master password.
    ///
    /// Tries the current (fast) Argon2id params first. If decryption
    /// fails we assume it's an older vault written with the legacy
    /// params — retry there, and on success re-encrypt the file with
    /// the current-params key so future unlocks take the fast path.
    /// If both derivations fail, the password is wrong.
    pub async fn unlock(&self, master_password: &str) -> AppResult<()> {
        if !self.exists().await {
            return Err(AppError::VaultNotInitialized);
        }
        let (salt, nonce, ct) = store::read_vault_parts(&self.file_path).await?;

        let fast_key = crypto::derive_key(master_password, &salt)?;
        let (final_key, plaintext) =
            match crypto::decrypt(&fast_key, &nonce, &ct) {
                Ok(pt) => (fast_key, pt),
                Err(_) => {
                    // Fall back to the legacy params.
                    let legacy_key =
                        crypto::derive_key_legacy(master_password, &salt)?;
                    let pt = crypto::decrypt(&legacy_key, &nonce, &ct)
                        .map_err(|_| AppError::InvalidMasterPassword)?;
                    // Re-derive with current params and rewrite the
                    // vault so subsequent unlocks are fast.
                    let data: VaultData = serde_json::from_slice(&pt)?;
                    let new_salt = crypto::random_salt();
                    let new_key =
                        crypto::derive_key(master_password, &new_salt)?;
                    store::write_vault(
                        &self.file_path,
                        &new_salt,
                        &new_key,
                        &data,
                    )
                    .await?;
                    tracing::info!(
                        target: "vault",
                        "migrated legacy vault to current Argon2 params"
                    );
                    // Update in-memory salt to match what we just wrote.
                    let mut inner = self.inner.write().await;
                    inner.key = Some(new_key.clone());
                    inner.salt = Some(new_salt);
                    inner.data = Some(data);
                    return Ok(());
                }
            };

        let data: VaultData = serde_json::from_slice(&plaintext)?;

        let mut inner = self.inner.write().await;
        inner.key = Some(final_key);
        inner.salt = Some(salt);
        inner.data = Some(data);
        Ok(())
    }

    /// Drop the in-memory key and plaintext.
    pub async fn lock(&self) {
        let mut inner = self.inner.write().await;
        inner.key = None; // Zeroizing drop clears the bytes
        inner.data = None;
        // salt is not secret; keep it
    }

    /// Run a read-only closure with access to the decrypted data.
    pub async fn read<R>(&self, f: impl FnOnce(&VaultData) -> R) -> AppResult<R> {
        let inner = self.inner.read().await;
        let data = inner.data.as_ref().ok_or(AppError::VaultLocked)?;
        Ok(f(data))
    }

    /// Run a mutating closure, then persist the vault to disk.
    pub async fn write<R>(&self, f: impl FnOnce(&mut VaultData) -> R) -> AppResult<R> {
        let mut inner = self.inner.write().await;
        let key = inner.key.clone().ok_or(AppError::VaultLocked)?;
        let salt = inner.salt.ok_or(AppError::VaultLocked)?;
        let data = inner.data.as_mut().ok_or(AppError::VaultLocked)?;
        let result = f(data);
        store::write_vault(&self.file_path, &salt, &key, data).await?;
        Ok(result)
    }

    /// Change master password. Re-encrypts with a new salt+key.
    pub async fn change_password(&self, old: &str, new: &str) -> AppResult<()> {
        // Verify old password by attempting a full decrypt.
        self.unlock(old).await?;

        let new_salt = crypto::random_salt();
        let new_key = crypto::derive_key(new, &new_salt)?;
        let mut inner = self.inner.write().await;
        let data = inner.data.as_ref().ok_or(AppError::VaultLocked)?.clone();
        store::write_vault(&self.file_path, &new_salt, &new_key, &data).await?;
        inner.key = Some(new_key);
        inner.salt = Some(new_salt);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, Secret, Server};
    use tempfile::TempDir;
    use uuid::Uuid;

    #[tokio::test]
    async fn initialize_and_unlock_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("vault.enc");
        let vault = Vault::new(path.clone());

        vault.initialize("hunter2").await.unwrap();
        vault
            .write(|data| {
                data.servers.push(Server {
                    id: Uuid::new_v4(),
                    name: "prod".into(),
                    host: "example.com".into(),
                    port: 22,
                    user: "deploy".into(),
                    auth: AuthMethod::Password {
                        password: Secret("s3cret".into()),
                    },
                    protocol: Default::default(),
                    host_key_fingerprint: None,
                    jump_host: None,
                    group_id: None,
                    order: 0,
                });
            })
            .await
            .unwrap();
        vault.lock().await;
        assert!(!vault.is_unlocked().await);

        vault.unlock("hunter2").await.unwrap();
        let n = vault.read(|d| d.servers.len()).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn wrong_password_fails() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("vault.enc");
        let vault = Vault::new(path.clone());
        vault.initialize("correct").await.unwrap();
        vault.lock().await;

        let err = vault.unlock("wrong").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidMasterPassword));
    }

    #[tokio::test]
    async fn tampered_ciphertext_fails() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("vault.enc");
        let vault = Vault::new(path.clone());
        vault.initialize("pw").await.unwrap();
        vault.lock().await;

        // Flip 1 byte in the ciphertext region.
        let mut bytes = tokio::fs::read(&path).await.unwrap();
        let idx = bytes.len() - 5;
        bytes[idx] ^= 0xAA;
        tokio::fs::write(&path, &bytes).await.unwrap();

        assert!(vault.unlock("pw").await.is_err());
    }

    #[tokio::test]
    async fn change_password_works() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("vault.enc");
        let vault = Vault::new(path.clone());
        vault.initialize("old").await.unwrap();
        vault.change_password("old", "new").await.unwrap();
        vault.lock().await;

        assert!(vault.unlock("old").await.is_err());
        assert!(vault.unlock("new").await.is_ok());
    }
}

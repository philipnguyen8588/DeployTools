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
use crate::models::VaultData;
use std::path::PathBuf;
use tokio::sync::RwLock;
use zeroize::Zeroizing;

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
        let data = VaultData::default();

        store::write_vault(&self.file_path, &salt, &key, &data).await?;

        let mut inner = self.inner.write().await;
        inner.key = Some(key);
        inner.salt = Some(salt);
        inner.data = Some(data);
        Ok(())
    }

    /// Unlock using the master password. Returns error if the password is
    /// wrong (AES-GCM tag mismatch) or the file is corrupt.
    pub async fn unlock(&self, master_password: &str) -> AppResult<()> {
        if !self.exists().await {
            return Err(AppError::VaultNotInitialized);
        }
        let (salt, nonce, ct) = store::read_vault_parts(&self.file_path).await?;
        let key = crypto::derive_key(master_password, &salt)?;
        let plaintext = crypto::decrypt(&key, &nonce, &ct)
            .map_err(|_| AppError::InvalidMasterPassword)?;
        let data: VaultData = serde_json::from_slice(&plaintext)?;

        let mut inner = self.inner.write().await;
        inner.key = Some(key);
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
                    host_key_fingerprint: None,
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

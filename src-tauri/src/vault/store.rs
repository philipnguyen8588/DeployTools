//! On-disk layout of the vault file.
//!
//! ```text
//! +--------+---------+-------+--------+--------------------+
//! | magic  | version | salt  | nonce  | ciphertext + tag   |
//! | 8 B    | 1 B     | 16 B  | 12 B   | N B (incl. 16B tag)|
//! +--------+---------+-------+--------+--------------------+
//! ```
//!
//! `magic = b"DEPLTVLT"`. `version` is the format version (currently 1).

use super::crypto::{self, NONCE_LEN, SALT_LEN};
use crate::errors::{AppError, AppResult};
use crate::models::VaultData;
use std::path::Path;

const MAGIC: &[u8; 8] = b"DEPLTVLT";
const VERSION: u8 = 1;
const HEADER_LEN: usize = MAGIC.len() + 1 + SALT_LEN + NONCE_LEN;

pub async fn write_vault(
    path: &Path,
    salt: &[u8; SALT_LEN],
    key: &[u8; crypto::KEY_LEN],
    data: &VaultData,
) -> AppResult<()> {
    let plaintext = serde_json::to_vec(data)?;
    let (nonce, ciphertext) = crypto::encrypt_no_aad(key, &plaintext)?;

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);

    // Ensure parent directory exists.
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Atomic write: write to tmp then rename.
    let tmp = path.with_extension("enc.tmp");
    tokio::fs::write(&tmp, &out).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

pub async fn read_vault_parts(
    path: &Path,
) -> AppResult<([u8; SALT_LEN], [u8; NONCE_LEN], Vec<u8>)> {
    let bytes = tokio::fs::read(path).await?;
    if bytes.len() < HEADER_LEN {
        return Err(AppError::Other("vault file too short".into()));
    }
    if &bytes[..MAGIC.len()] != MAGIC {
        return Err(AppError::Other("vault magic mismatch".into()));
    }
    let version = bytes[MAGIC.len()];
    if version != VERSION {
        return Err(AppError::Other(format!(
            "unsupported vault version {version}"
        )));
    }

    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    let salt_start = MAGIC.len() + 1;
    let nonce_start = salt_start + SALT_LEN;
    let ct_start = nonce_start + NONCE_LEN;
    salt.copy_from_slice(&bytes[salt_start..nonce_start]);
    nonce.copy_from_slice(&bytes[nonce_start..ct_start]);
    let ct = bytes[ct_start..].to_vec();
    Ok((salt, nonce, ct))
}

//! Argon2id key derivation + AES-256-GCM authenticated encryption.
//!
//! Parameters:
//!   Argon2id current: m=19 MiB, t=2 iterations, p=1 lane, 32-byte output
//!     (OWASP 2024 recommended minimum — fast enough that unlock feels
//!      instant on modern hardware, strong enough to resist brute force.)
//!   Argon2id legacy:  m=64 MiB, t=3 iterations, p=4 lanes — used by
//!     vaults created before 1.1.x. `Vault::unlock` tries the current
//!     params first and transparently migrates legacy vaults on
//!     successful unlock.
//!   AES-256-GCM: 96-bit random nonce, 128-bit tag.
//!
//! All key material is wrapped in [`Zeroizing`] to guarantee erasure on drop.

use crate::errors::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use zeroize::Zeroizing;

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;

/// Current Argon2id params — OWASP 2024 recommended minimum. Tuned so
/// unlock finishes within a few hundred milliseconds on modest hardware
/// while still costing serious GPU effort to brute force (~19 MiB RAM
/// per guess, 2 iterations).
fn argon2_params() -> Params {
    Params::new(19 * 1024, 2, 1, Some(KEY_LEN)).expect("valid argon2 params")
}

/// Legacy params used before the 1.1.x rebalance. Kept purely so we can
/// unlock older vaults and re-encrypt them with the current params on
/// the fly. Do NOT use for new vaults.
fn argon2_params_legacy() -> Params {
    Params::new(64 * 1024, 3, 4, Some(KEY_LEN)).expect("valid argon2 params")
}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut out = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut out);
    out
}

pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut out = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut out);
    out
}

/// Derive a 32-byte key from password + salt using Argon2id. Uses the
/// current OWASP params — fast path for all vaults written by this
/// version.
pub fn derive_key(password: &str, salt: &[u8; SALT_LEN]) -> AppResult<Zeroizing<[u8; KEY_LEN]>> {
    derive_key_with(password, salt, argon2_params())
}

/// Legacy derivation for vaults written before the 1.1.x params change.
/// `Vault::unlock` falls back to this when the new params fail and
/// then re-encrypts the file with the fresh key.
pub fn derive_key_legacy(
    password: &str,
    salt: &[u8; SALT_LEN],
) -> AppResult<Zeroizing<[u8; KEY_LEN]>> {
    derive_key_with(password, salt, argon2_params_legacy())
}

fn derive_key_with(
    password: &str,
    salt: &[u8; SALT_LEN],
    params: Params,
) -> AppResult<Zeroizing<[u8; KEY_LEN]>> {
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, key.as_mut_slice())
        .map_err(|e| AppError::Crypto(format!("argon2: {e}")))?;
    Ok(key)
}

/// Encrypt `plaintext` with a fresh random nonce. Returns `(nonce, ciphertext+tag)`.
///
/// `aad` is the associated data (tied to the ciphertext via GCM auth).
pub fn encrypt(
    key: &[u8; KEY_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> AppResult<([u8; NONCE_LEN], Vec<u8>)> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = random_nonce();
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| AppError::Crypto(format!("aes-gcm encrypt: {e}")))?;
    Ok((nonce, ct))
}

/// Decrypt. Returns an error if the tag is invalid (tampering, wrong key).
/// Caller must supply the same `aad` used during encryption.
pub fn decrypt(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> AppResult<Vec<u8>> {
    decrypt_with_aad(key, nonce, ciphertext, &[])
}

pub fn decrypt_with_aad(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
    aad: &[u8],
) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let pt = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|e| AppError::Crypto(format!("aes-gcm decrypt: {e}")))?;
    Ok(pt)
}

/// Encrypt without AAD (convenience wrapper used by vault::store).
pub fn encrypt_no_aad(
    key: &[u8; KEY_LEN],
    plaintext: &[u8],
) -> AppResult<([u8; NONCE_LEN], Vec<u8>)> {
    encrypt(key, plaintext, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let salt = random_salt();
        let key = derive_key("password", &salt).unwrap();
        let msg = b"top secret config";
        let (nonce, ct) = encrypt_no_aad(&key, msg).unwrap();
        let pt = decrypt(&key, &nonce, &ct).unwrap();
        assert_eq!(pt, msg);
    }

    #[test]
    fn wrong_key_fails() {
        let s = random_salt();
        let k1 = derive_key("a", &s).unwrap();
        let k2 = derive_key("b", &s).unwrap();
        let (nonce, ct) = encrypt_no_aad(&k1, b"x").unwrap();
        assert!(decrypt(&k2, &nonce, &ct).is_err());
    }

    #[test]
    fn tamper_fails() {
        let s = random_salt();
        let k = derive_key("a", &s).unwrap();
        let (nonce, mut ct) = encrypt_no_aad(&k, b"hello").unwrap();
        ct[0] ^= 0xFF;
        assert!(decrypt(&k, &nonce, &ct).is_err());
    }

    #[test]
    fn nonces_unique() {
        let n1 = random_nonce();
        let n2 = random_nonce();
        assert_ne!(n1, n2);
    }
}

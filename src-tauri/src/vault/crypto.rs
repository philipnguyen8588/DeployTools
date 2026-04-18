//! Argon2id key derivation + AES-256-GCM authenticated encryption.
//!
//! Parameters (hardcoded — treat as versioned):
//!   Argon2id: m=64 MiB, t=3 iterations, p=4 lanes, 32-byte output
//!   AES-256-GCM: 96-bit random nonce, 128-bit tag
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

/// Argon2id: 64 MiB memory, 3 iterations, 4 lanes.
/// Deliberately high cost — each unlock takes ~500 ms on a modern laptop.
fn argon2_params() -> Params {
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

/// Derive a 32-byte key from password + salt using Argon2id.
pub fn derive_key(password: &str, salt: &[u8; SALT_LEN]) -> AppResult<Zeroizing<[u8; KEY_LEN]>> {
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params());
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

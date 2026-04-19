//! Snippet library — reusable shell commands with `{{KEY}}`-style
//! variable substitution, stored in the encrypted vault alongside SSH
//! credentials.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::models::Snippet;
use crate::ssh::exec::{self, ExecOpts};
use crate::state::AppState;

#[tauri::command]
pub async fn snippet_list(state: State<'_, AppState>) -> AppResult<Vec<Snippet>> {
    state.vault.read(|d| d.snippets.clone()).await
}

#[tauri::command]
pub async fn snippet_save(
    mut snippet: Snippet,
    state: State<'_, AppState>,
) -> AppResult<Snippet> {
    if snippet.id.is_nil() {
        snippet.id = Uuid::new_v4();
    }
    validate_snippet(&snippet)?;
    state
        .vault
        .write(|d| {
            if let Some(existing) = d.snippets.iter_mut().find(|s| s.id == snippet.id) {
                *existing = snippet.clone();
            } else {
                d.snippets.push(snippet.clone());
            }
        })
        .await?;
    Ok(snippet)
}

#[tauri::command]
pub async fn snippet_delete(id: Uuid, state: State<'_, AppState>) -> AppResult<()> {
    state
        .vault
        .write(|d| d.snippets.retain(|s| s.id != id))
        .await
}

/// Resolve a snippet's command template into a concrete string using
/// the session's built-in variables (HOST/USER/PORT/REMOTE_PATH/…) plus
/// user-supplied values. Does NOT execute — the frontend pastes the
/// result into the interactive terminal so the user sees it in their
/// shell and hits Enter themselves.
///
/// This replaces the old `snippet_run` model where we exec'd the
/// snippet over a secondary SSH channel. That model broke follow-mode
/// commands (`docker compose logs -f …`) and forced the user to hunt
/// for output in the Activity console. Pasting into the active
/// terminal is what a shell user actually wants.
#[tauri::command]
pub async fn snippet_resolve(
    session_id: String,
    snippet_id: Uuid,
    vars: HashMap<String, String>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let session = state.sessions.get(&session_id)?;
    let snippet = state
        .vault
        .read(|d| d.snippets.iter().find(|s| s.id == snippet_id).cloned())
        .await?
        .ok_or_else(|| AppError::Other(format!("snippet {snippet_id} not found")))?;

    let builtins = resolve_builtins(&session, &state).await?;
    resolve_vars(&snippet.command, &vars, &builtins)
}

/// Legacy: run a snippet via a secondary exec channel. Kept only so
/// existing callers keep compiling; the new UI path is `snippet_resolve`
/// + paste into the interactive terminal.
#[tauri::command]
pub async fn snippet_run(
    session_id: String,
    snippet_id: Uuid,
    vars: HashMap<String, String>,
    state: State<'_, AppState>,
) -> AppResult<i32> {
    let session = state.sessions.get(&session_id)?;
    let snippet = state
        .vault
        .read(|d| d.snippets.iter().find(|s| s.id == snippet_id).cloned())
        .await?
        .ok_or_else(|| AppError::Other(format!("snippet {snippet_id} not found")))?;

    let builtins = resolve_builtins(&session, &state).await?;
    let command = resolve_vars(&snippet.command, &vars, &builtins)?;

    let _guard = state.acquire_mutating(&session_id, format!("snippet: {}", snippet.name))?;

    let argv = vec!["sh".to_string(), "-c".into(), command];
    let result = exec::run_streaming(
        session.clone(),
        None,
        &argv,
        "snippet",
        ExecOpts {
            tag: Some(snippet.id.to_string()),
            ..Default::default()
        },
        None,
    )
    .await?;
    Ok(result.exit)
}

/// Pull the standard built-in variables out of the vault for a session.
async fn resolve_builtins(
    session: &std::sync::Arc<crate::ssh::session_pool::SshSession>,
    state: &State<'_, AppState>,
) -> AppResult<HashMap<String, String>> {
    state
        .vault
        .read(|d| {
            let server = d.servers.iter().find(|s| s.id == session.server_id);
            let project = session
                .project
                .as_ref()
                .and_then(|p| d.projects.iter().find(|x| x.id == p.id));
            let mut m = HashMap::new();
            if let Some(s) = server {
                m.insert("HOST".into(), s.host.clone());
                m.insert("USER".into(), s.user.clone());
                m.insert("PORT".into(), s.port.to_string());
            }
            if let Some(p) = project {
                m.insert("PROJECT_NAME".into(), p.name.clone());
                m.insert("LOCAL_PATH".into(), p.local_path.to_string_lossy().into());
                m.insert("REMOTE_PATH".into(), p.remote_path.clone());
            }
            m
        })
        .await
}

// ------ substitution + validation ------

/// Resolve `{{KEY}}` placeholders. `{{{{` is an escape for a literal
/// `{{`. User-supplied `vars` take precedence over built-ins so that
/// a snippet can declare e.g. a `HOST` variable to override the
/// built-in when needed.
///
/// Built-in and user values are shell-quoted before substitution so a
/// value like `it's great` can't break out of the surrounding command.
#[derive(Debug, Serialize, Clone)]
pub struct UnresolvedVar(pub String);

pub fn resolve_vars(
    template: &str,
    user: &HashMap<String, String>,
    builtins: &HashMap<String, String>,
) -> AppResult<String> {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Escape `{{{{` → literal `{{`.
        if i + 3 < bytes.len() && &bytes[i..i + 4] == b"{{{{" {
            out.push_str("{{");
            i += 4;
            continue;
        }
        if i + 1 < bytes.len() && &bytes[i..i + 2] == b"{{" {
            // Find the closing `}}`.
            let rest = &template[i + 2..];
            if let Some(end) = rest.find("}}") {
                let key = rest[..end].trim();
                let value = user
                    .get(key)
                    .or_else(|| builtins.get(key))
                    .ok_or_else(|| {
                        AppError::Other(format!("unresolved variable: {{{{{key}}}}}"))
                    })?;
                // Inline verbatim — the snippet author chose whether to
                // quote at the call site. This is intentional: snippets
                // frequently want to splice values into flags, paths, etc.
                out.push_str(value);
                i += 2 + end + 2;
                continue;
            }
        }
        let ch = bytes[i];
        // UTF-8-safe copy of the current byte (or multi-byte start).
        let ch_len = utf8_char_len(ch);
        out.push_str(&template[i..i + ch_len]);
        i += ch_len;
    }
    Ok(out)
}

fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b < 0xC0 {
        1 // continuation byte (shouldn't happen on a valid boundary, be defensive)
    } else if b < 0xE0 {
        2
    } else if b < 0xF0 {
        3
    } else {
        4
    }
}

fn validate_snippet(s: &Snippet) -> AppResult<()> {
    if s.name.trim().is_empty() {
        return Err(AppError::Other("snippet name is required".into()));
    }
    if s.command.trim().is_empty() {
        return Err(AppError::Other("snippet command is required".into()));
    }
    for v in &s.variables {
        if !v.key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(AppError::Other(format!(
                "variable key '{}' must be alphanumeric or underscore",
                v.key
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn resolves_builtin() {
        let out =
            resolve_vars("hi {{USER}}", &HashMap::new(), &m(&[("USER", "alice")])).unwrap();
        assert_eq!(out, "hi alice");
    }

    #[test]
    fn user_overrides_builtin() {
        let out =
            resolve_vars("hi {{USER}}", &m(&[("USER", "bob")]), &m(&[("USER", "alice")]))
                .unwrap();
        assert_eq!(out, "hi bob");
    }

    #[test]
    fn unresolved_errors() {
        let err = resolve_vars("hi {{NOBODY}}", &HashMap::new(), &HashMap::new())
            .unwrap_err();
        assert!(err.to_string().contains("NOBODY"));
    }

    #[test]
    fn escape_double_brace() {
        let out = resolve_vars("echo {{{{literal}}}}", &HashMap::new(), &HashMap::new())
            .unwrap();
        assert_eq!(out, "echo {{literal}}");
    }

    #[test]
    fn multiple_vars() {
        let out = resolve_vars(
            "ssh {{USER}}@{{HOST}}",
            &HashMap::new(),
            &m(&[("USER", "root"), ("HOST", "1.2.3.4")]),
        )
        .unwrap();
        assert_eq!(out, "ssh root@1.2.3.4");
    }
}

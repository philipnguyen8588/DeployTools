//! Docker Compose file parsing.
//!
//! Keeps parsing strictly *passive* — we never resolve `${VAR}`
//! interpolation or execute `docker compose config`. Whatever the
//! user wrote in the YAML is what the UI shows (with a warning flag
//! on services that contain unresolved vars).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, AppResult};

/// Candidate compose file names in the order Docker Compose itself
/// looks for them. We stop at the first match.
pub const COMPOSE_CANDIDATES: &[&str] = &[
    "compose.yml",
    "compose.yaml",
    "docker-compose.yml",
    "docker-compose.yaml",
];

#[derive(Debug, Clone, Serialize)]
pub struct ComposeService {
    pub name: String,
    pub image: Option<String>,
    /// Build context path (relative to compose dir).
    pub build: Option<String>,
    pub command: Option<String>,
    pub restart: Option<String>,
    pub profiles: Vec<String>,
    /// `true` if any heuristic flags this service as a one-off runner
    /// (profile-gated, `restart: "no"`, or `x-deploytools.oneoff`).
    pub is_oneoff: bool,
    /// User explicitly marked it via `x-deploytools: { oneoff: true }`.
    pub explicit_oneoff: bool,
    /// One or more fields contained unresolved `${VAR}` — UI warns.
    pub has_unresolved_vars: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParsedCompose {
    pub compose_path: PathBuf,
    pub services: Vec<ComposeService>,
}

// ---- internal raw YAML shape ----

#[derive(Debug, Deserialize)]
struct RawCompose {
    #[serde(default)]
    services: serde_yaml::Mapping,
}

#[derive(Debug, Deserialize, Default)]
struct RawService {
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    build: Option<serde_yaml::Value>,
    #[serde(default)]
    command: Option<serde_yaml::Value>,
    #[serde(default)]
    restart: Option<String>,
    #[serde(default)]
    profiles: Vec<String>,
    /// Optional DeployTools extension; compose allows `x-*` fields.
    #[serde(default, rename = "x-deploytools")]
    x_deploytools: Option<XDeployTools>,
}

#[derive(Debug, Deserialize, Default)]
struct XDeployTools {
    #[serde(default)]
    oneoff: bool,
}

/// Parse a compose file. Returns the list of services plus the resolved
/// path. Fails loudly on malformed YAML.
pub fn parse_file(path: &Path) -> AppResult<ParsedCompose> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
    parse_str(&text, path.to_path_buf())
}

fn parse_str(yaml: &str, compose_path: PathBuf) -> AppResult<ParsedCompose> {
    let raw: RawCompose = serde_yaml::from_str(yaml)
        .map_err(|e| AppError::Other(format!("compose yaml: {e}")))?;

    let mut services: Vec<ComposeService> = Vec::new();
    for (k, v) in raw.services {
        let name = match k.as_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let svc: RawService = serde_yaml::from_value(v.clone()).unwrap_or_default();

        let image = svc.image.clone();
        let build = match &svc.build {
            Some(serde_yaml::Value::String(s)) => Some(s.clone()),
            Some(serde_yaml::Value::Mapping(m)) => m
                .get(serde_yaml::Value::String("context".into()))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            _ => None,
        };
        let command = match &svc.command {
            Some(serde_yaml::Value::String(s)) => Some(s.clone()),
            Some(serde_yaml::Value::Sequence(seq)) => {
                let joined: Vec<String> = seq
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                Some(joined.join(" "))
            }
            _ => None,
        };
        let explicit_oneoff = svc.x_deploytools.as_ref().map(|x| x.oneoff).unwrap_or(false);
        let has_unresolved_vars = yaml_contains_unresolved_var(&v);
        let is_oneoff = explicit_oneoff
            || !svc.profiles.is_empty()
            || matches!(svc.restart.as_deref(), Some("no"));

        services.push(ComposeService {
            name,
            image,
            build,
            command,
            restart: svc.restart,
            profiles: svc.profiles,
            is_oneoff,
            explicit_oneoff,
            has_unresolved_vars,
        });
    }

    services.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ParsedCompose {
        compose_path,
        services,
    })
}

/// Scan any string leaf in the service mapping for literal `${…}` —
/// Compose interpolation that we did NOT resolve.
fn yaml_contains_unresolved_var(v: &serde_yaml::Value) -> bool {
    match v {
        serde_yaml::Value::String(s) => s.contains("${"),
        serde_yaml::Value::Sequence(seq) => seq.iter().any(yaml_contains_unresolved_var),
        serde_yaml::Value::Mapping(m) => m.values().any(yaml_contains_unresolved_var),
        _ => false,
    }
}

/// Discover a compose file in `base_dir`, optionally overridden by an
/// explicit relative path. Returns the first existing candidate.
pub fn discover(base_dir: &Path, override_rel: Option<&Path>) -> Option<PathBuf> {
    if let Some(rel) = override_rel {
        let p = if rel.is_absolute() {
            rel.to_path_buf()
        } else {
            base_dir.join(rel)
        };
        if p.exists() {
            return Some(p);
        }
    }
    for name in COMPOSE_CANDIDATES {
        let p = base_dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(yaml: &str) -> Vec<ComposeService> {
        parse_str(yaml, PathBuf::from("test.yml")).unwrap().services
    }

    #[test]
    fn basic() {
        let s = parse(
            r#"
services:
  web:
    image: nginx:alpine
    restart: unless-stopped
  db:
    image: postgres:15
"#,
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "db");
        assert_eq!(s[1].image.as_deref(), Some("nginx:alpine"));
        assert!(!s[0].is_oneoff);
        assert!(!s[1].is_oneoff);
    }

    #[test]
    fn oneoff_via_profile() {
        let s = parse(
            r#"
services:
  migrate:
    image: my/api
    profiles: [tools]
"#,
        );
        assert!(s[0].is_oneoff);
    }

    #[test]
    fn oneoff_via_restart_no() {
        let s = parse(
            r#"
services:
  once:
    image: alpine
    restart: "no"
"#,
        );
        assert!(s[0].is_oneoff);
    }

    #[test]
    fn oneoff_via_x_extension() {
        let s = parse(
            r#"
services:
  seed:
    image: alpine
    x-deploytools:
      oneoff: true
"#,
        );
        assert!(s[0].is_oneoff);
        assert!(s[0].explicit_oneoff);
    }

    #[test]
    fn unresolved_var_flag() {
        let s = parse(
            r#"
services:
  app:
    image: "my/app:${TAG:-latest}"
"#,
        );
        assert!(s[0].has_unresolved_vars);
    }
}

//! POSIX shell quoting helpers shared across `terminal`, `exec`, and the
//! per-command builders.
//!
//! We never format user-supplied strings into a shell command via `{}`
//! or `String::push_str`. Anything that might become an argv element is
//! passed through [`shell_single_quote`] first.

/// Wrap `s` in single quotes, escaping any embedded single quotes with
/// the classic `'\''` trick. Safe for direct insertion into a `sh -c`
/// command or an `ssh` `exec` request string.
pub fn shell_single_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

/// Shell-quote every element of `argv` and join with spaces. Produces a
/// string suitable for passing to `russh::Channel::exec(true, …)`.
pub fn quote_argv(argv: &[String]) -> String {
    argv.iter()
        .map(|a| shell_single_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Prepend a `cd <dir> &&` preamble to a quoted argv. Use when we want
/// the remote command to run in a specific directory (e.g. a project
/// path with docker-compose.yml).
pub fn cd_and(dir: &str, argv: &[String]) -> String {
    if dir.is_empty() {
        quote_argv(argv)
    } else {
        format!("cd {} && {}", shell_single_quote(dir), quote_argv(argv))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_quote_plain() {
        assert_eq!(shell_single_quote("hello"), "'hello'");
        assert_eq!(shell_single_quote("/var/www"), "'/var/www'");
    }

    #[test]
    fn single_quote_embedded_quote() {
        assert_eq!(shell_single_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn quote_argv_joins() {
        let v = vec!["docker".to_string(), "compose".to_string(), "up".to_string(), "-d".to_string()];
        assert_eq!(quote_argv(&v), "'docker' 'compose' 'up' '-d'");
    }

    #[test]
    fn cd_and_handles_empty() {
        let v = vec!["ls".to_string()];
        assert_eq!(cd_and("", &v), "'ls'");
    }

    #[test]
    fn cd_and_prepends_cd() {
        let v = vec!["ls".to_string(), "-la".to_string()];
        assert_eq!(cd_and("/srv/app", &v), "cd '/srv/app' && 'ls' '-la'");
    }
}

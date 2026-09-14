//! Command guard for the MCP `run_command` tool.
//!
//! An AI agent can ask the app to run arbitrary shell commands on the
//! connected server. This module screens those commands against a
//! configurable denylist BEFORE they run, with normalization that defeats
//! the common bypass tricks (path-qualified programs, `sudo`, chained
//! commands, command substitution, piping into a shell).
//!
//! A denylist is a strong deterrent, not a full sandbox — an interpreter
//! (`python -c "…"`) can still do damage. For airtight control use the
//! "disabled" mode, or restrict what the agent is allowed to touch.

/// Programs that are refused by default. Basenames, lower-case.
pub fn default_denied_programs() -> Vec<String> {
    [
        // destructive filesystem
        "rm", "rmdir", "unlink", "shred", "truncate", "fallocate",
        // disk / partitions
        "dd", "mkfs", "fdisk", "sfdisk", "parted", "wipefs", "mkswap", "blkdiscard",
        // process control
        "kill", "killall", "pkill",
        // power / init
        "reboot", "shutdown", "halt", "poweroff", "init", "telinit",
        // permissions / ownership
        "chmod", "chown", "chattr",
        // accounts
        "passwd", "useradd", "userdel", "groupdel", "deluser", "adduser",
        // firewall
        "iptables", "nft", "ufw",
        // privilege escalation (also caught as wrappers)
        "sudo", "su", "doas",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Wrappers that prefix a real command; we look past them to find the
/// actual program. `sudo`/`su`/`doas` are ALSO denied outright.
const WRAPPERS: &[&str] = &[
    "sudo", "su", "doas", "env", "nohup", "nice", "ionice", "time", "timeout", "xargs",
    "stdbuf", "setsid", "command", "builtin", "exec", "eval", "watch",
];

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"];

/// Screen a command. `mode` is `off` | `deny` | `disabled`.
pub fn check(command: &str, mode: &str, denied: &[String]) -> Result<(), String> {
    match mode {
        "off" => return Ok(()),
        "disabled" => {
            return Err("the terminal command tool is disabled by the app's MCP settings".into())
        }
        _ => {}
    }

    // Structural checks on the raw command — catch dangerous *shapes* even
    // when the program basename alone wouldn't (e.g. `/bin/rm`, redirects).
    if let Some(reason) = structural_block(command) {
        return Err(reason);
    }

    // Break into simple-command segments + any command-substitution bodies,
    // then screen each one's program.
    for seg in segments(command) {
        if let Some(reason) = screen_segment(&seg, denied) {
            return Err(reason);
        }
    }
    Ok(())
}

/// Human-readable summary of the structural rules (for `command_policy`).
pub fn structural_rules() -> Vec<&'static str> {
    vec![
        "privilege escalation (sudo / su / doas)",
        "piping into a shell (… | sh, | bash, …)",
        "writes to a block device (> /dev/sd*, of=/dev/*)",
        "disk formatting (mkfs, dd of=…)",
        "recursive/forced remove (rm -rf even when path-qualified)",
        "world-writable perms (chmod 777)",
        "fork bombs",
    ]
}

// ---------- internals ----------

/// Split into segments on shell control operators, and additionally pull
/// out the bodies of `$( … )` and back-tick substitutions so hidden
/// commands are screened too.
fn segments(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // Command substitution bodies.
    for body in substitutions(command) {
        out.push(body);
    }

    // Split the top level on ; && || | and newlines. We keep whether a
    // segment is preceded by a pipe by prefixing a marker.
    let mut cur = String::new();
    let bytes: Vec<char> = command.chars().collect();
    let mut i = 0;
    let mut piped = false;
    let push = |out: &mut Vec<String>, cur: &str, piped: bool| {
        let t = cur.trim();
        if !t.is_empty() {
            out.push(if piped { format!("|{t}") } else { t.to_string() });
        }
    };
    while i < bytes.len() {
        let c = bytes[i];
        let next = bytes.get(i + 1).copied();
        match c {
            '\n' | ';' => {
                push(&mut out, &cur, piped);
                cur.clear();
                piped = false;
                i += 1;
            }
            '&' if next == Some('&') => {
                push(&mut out, &cur, piped);
                cur.clear();
                piped = false;
                i += 2;
            }
            '|' if next == Some('|') => {
                push(&mut out, &cur, piped);
                cur.clear();
                piped = false;
                i += 2;
            }
            '|' => {
                push(&mut out, &cur, piped);
                cur.clear();
                piped = true; // the NEXT segment is downstream of a pipe
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }
    push(&mut out, &cur, piped);
    out
}

/// Extract the inner text of `$( … )` and back-tick substitutions.
fn substitutions(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && chars.get(i + 1) == Some(&'(') {
            let mut depth = 1;
            let mut j = i + 2;
            let start = j;
            while j < chars.len() && depth > 0 {
                match chars[j] {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    break;
                }
                j += 1;
            }
            out.push(chars[start..j].iter().collect());
            i = j + 1;
        } else if chars[i] == '`' {
            let start = i + 1;
            let mut j = start;
            while j < chars.len() && chars[j] != '`' {
                j += 1;
            }
            out.push(chars[start..j].iter().collect());
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Screen one segment. A leading `|` marks it as downstream of a pipe.
fn screen_segment(seg: &str, denied: &[String]) -> Option<String> {
    let (piped, body) = match seg.strip_prefix('|') {
        Some(rest) => (true, rest.trim()),
        None => (false, seg.trim()),
    };
    if body.is_empty() {
        return None;
    }

    let mut tokens = body.split_whitespace().peekable();

    // Skip leading `VAR=value` env assignments.
    while let Some(tok) = tokens.peek() {
        if is_env_assignment(tok) {
            tokens.next();
        } else {
            break;
        }
    }

    // Skip wrappers, but block privilege escalation.
    while let Some(tok) = tokens.peek().copied() {
        let base = basename(tok);
        if matches!(base.as_str(), "sudo" | "su" | "doas") {
            return Some(format!("blocked: privilege escalation via '{base}' is not allowed"));
        }
        if WRAPPERS.contains(&base.as_str()) {
            tokens.next();
            // skip options that belong to the wrapper (best-effort)
            while let Some(t) = tokens.peek() {
                if t.starts_with('-') {
                    tokens.next();
                } else {
                    break;
                }
            }
        } else {
            break;
        }
    }

    let prog = match tokens.next() {
        Some(t) => basename(t),
        None => return None,
    };

    // Piping into a shell hides arbitrary commands — refuse.
    if piped && SHELLS.contains(&prog.as_str()) {
        return Some("blocked: piping into a shell is not allowed".into());
    }

    if denied.iter().any(|d| d.eq_ignore_ascii_case(&prog)) {
        return Some(format!("blocked: '{prog}' is on the command denylist"));
    }
    None
}

fn is_env_assignment(tok: &str) -> bool {
    match tok.find('=') {
        Some(0) | None => false,
        Some(idx) => tok[..idx]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_'),
    }
}

/// Basename, with surrounding quotes stripped, lower-cased.
fn basename(tok: &str) -> String {
    let t = tok.trim_matches(|c| c == '"' || c == '\'');
    let last = t.rsplit(['/', '\\']).next().unwrap_or(t);
    last.to_ascii_lowercase()
}

/// Whole-command structural checks (substring/shape based).
fn structural_block(command: &str) -> Option<String> {
    let lc = command.to_ascii_lowercase();
    let compact: String = lc.chars().filter(|c| !c.is_whitespace()).collect();

    // Fork bomb, e.g. :(){ :|:& };:
    if compact.contains(":(){") || compact.contains(":|:&") {
        return Some("blocked: fork bomb pattern".into());
    }
    // Writing to a raw block device.
    if lc.contains("of=/dev/") || contains_redirect_to_dev(&lc) {
        return Some("blocked: write to a block device".into());
    }
    // dd writing somewhere is high-risk.
    if word_present(&lc, "dd") && lc.contains("of=") {
        return Some("blocked: raw 'dd' write".into());
    }
    // Filesystem format.
    if word_present(&lc, "mkfs") || lc.contains("mkfs.") {
        return Some("blocked: filesystem format (mkfs)".into());
    }
    // Recursive/forced rm even if path-qualified (e.g. /bin/rm -rf).
    if lc.contains("rm ") && has_rf_flag(&lc) {
        return Some("blocked: recursive/forced remove (rm -rf)".into());
    }
    // World-writable perms.
    if word_present(&lc, "chmod") && (lc.contains("777") || lc.contains("-r 777")) {
        return Some("blocked: chmod 777".into());
    }
    None
}

fn contains_redirect_to_dev(lc: &str) -> bool {
    // `> /dev/sda`, `>/dev/nvme0n1`, etc.
    if let Some(idx) = lc.find('>') {
        let rest = lc[idx + 1..].trim_start_matches('>').trim_start();
        return rest.starts_with("/dev/");
    }
    false
}

fn has_rf_flag(lc: &str) -> bool {
    // Detect an rm flag cluster containing both r and f, or --recursive/--force.
    for tok in lc.split_whitespace() {
        if tok.starts_with('-') && !tok.starts_with("--") {
            let flags = &tok[1..];
            if flags.contains('r') && flags.contains('f') {
                return true;
            }
        }
    }
    (lc.contains("--recursive") && lc.contains("--force"))
        || lc.contains(" -rf") || lc.contains(" -fr")
}

fn word_present(lc: &str, word: &str) -> bool {
    lc.split(|c: char| !c.is_ascii_alphanumeric() && c != '.')
        .any(|w| w == word)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deny() -> Vec<String> {
        default_denied_programs()
    }

    fn blocked(cmd: &str) -> bool {
        check(cmd, "deny", &deny()).is_err()
    }

    #[test]
    fn allows_safe_commands() {
        assert!(check("ls -la", "deny", &deny()).is_ok());
        assert!(check("cat /etc/hostname", "deny", &deny()).is_ok());
        assert!(check("git status && git log -n 5", "deny", &deny()).is_ok());
        assert!(check("docker ps", "deny", &deny()).is_ok());
        assert!(check("tail -n 100 app.log | grep ERROR", "deny", &deny()).is_ok());
    }

    #[test]
    fn blocks_destructive() {
        assert!(blocked("rm -rf /tmp/x"));
        assert!(blocked("/bin/rm x"));
        assert!(blocked("rm x"));
        assert!(blocked("sudo rm -rf /"));
        assert!(blocked("echo hi && rm x"));
        assert!(blocked("echo hi; kill -9 1234"));
        assert!(blocked("cat f | sh"));
        assert!(blocked("$(rm x)"));
        assert!(blocked("`rm x`"));
        assert!(blocked("dd if=/dev/zero of=/dev/sda"));
        assert!(blocked("mkfs.ext4 /dev/sdb1"));
        assert!(blocked("chmod -R 777 /"));
        assert!(blocked("RM=1 rm x"));
        assert!(blocked("env rm x"));
        assert!(blocked("nohup killall node"));
    }

    #[test]
    fn mode_off_allows_everything() {
        assert!(check("rm -rf /", "off", &deny()).is_ok());
    }

    #[test]
    fn mode_disabled_blocks_everything() {
        assert!(check("ls", "disabled", &deny()).is_err());
    }
}

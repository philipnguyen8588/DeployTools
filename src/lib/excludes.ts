/**
 * Client-side exclude-pattern matching for the remote file browser.
 *
 * The LOCAL browser gets an `excluded` flag computed by the backend
 * (`list_local_tree`), but the remote listing (`sftp_list`) is a plain
 * SFTP readdir with no project context — so the remote side mirrors the
 * backend's matching here: `commands/deploy.rs::baseline_excludes` +
 * `build_globset` (match the relative path OR any single segment).
 * Keep BASELINE_EXCLUDES in sync with the Rust list.
 */

/** Always-on excludes — must match `baseline_excludes()` in deploy.rs. */
export const BASELINE_EXCLUDES = ["__pycache__", "*.pyc", "*.pyo", ".git"];

/** Convert one glob pattern (`*`, `?` wildcards) into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Build a matcher over the baseline + project patterns. The returned
 * function takes an entry NAME and (optionally) its path relative to the
 * project remote base, and reports whether any pattern matches the name,
 * the relative path, or any path segment — same semantics as the backend's
 * `path_excluded`.
 */
export function makeExcludeMatcher(
  projectExcludes: string[] | undefined,
): (name: string, rel?: string | null) => boolean {
  const regs = [...BASELINE_EXCLUDES, ...(projectExcludes ?? [])].map(
    globToRegExp,
  );
  return (name, rel) => {
    if (regs.some((r) => r.test(name))) return true;
    if (rel) {
      if (regs.some((r) => r.test(rel))) return true;
      if (rel.split("/").some((seg) => regs.some((r) => r.test(seg))))
        return true;
    }
    return false;
  };
}

/**
 * MobaXterm-style session welcome banner.
 *
 * Returns a ready-to-`term.write()` ANSI string drawing a boxed summary
 * of the SSH session. It is written client-side the instant the terminal
 * opens — BEFORE the first byte of the server's PTY output arrives — so it
 * renders above the server's real MOTD / "Last login:" line.
 *
 * Pure function, no React / no side effects: everything it needs is passed
 * in (the caller sources it from the `useServers` store + xterm's `cols`).
 */

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

/** Visible-width helpers — the banner only uses ASCII + a couple of glyphs
 *  that render single-width, so string length is an accurate column count
 *  for our content. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Index just past the LAST full-screen-clear escape in `s`, or -1 if none.
 * Recognizes ED2 (`\x1b[2J`), ED3 (`\x1b[3J`) and RIS (`\x1bc`) — the
 * sequences emitted by `clear` / `printf '\033c'`.
 *
 * Used as a connect-time safety net: if anything clears the screen right
 * after login (e.g. a server that runs `clear` from its shell init), the
 * just-written banner would be wiped. The Terminal component watches the
 * first output for one of these sequences and re-inserts the banner
 * immediately after it, so it ends up on top of the cleaned screen.
 */
export function indexAfterLastClear(s: string): number {
  let best = -1;
  for (const seq of ["\x1b[2J", "\x1b[3J", "\x1bc"]) {
    const i = s.lastIndexOf(seq);
    if (i !== -1 && i + seq.length > best) best = i + seq.length;
  }
  return best;
}

export interface BannerOpts {
  user: string;
  host: string;
  port: number;
  authKind: "password" | "key";
  hasFingerprint: boolean;
  /** Live terminal width in columns (read after `fit.fit()`). */
  cols: number;
  theme: "dark" | "light";
}

export function buildBanner(opts: BannerOpts): string {
  const { user, host, port, authKind, hasFingerprint } = opts;

  // Inner width = space between the two vertical borders. Clamp so the box
  // never overflows a narrow window and never sprawls on a huge one.
  const inner = Math.max(20, Math.min(opts.cols - 2, 76));
  // One leading + trailing space of padding inside the borders.
  const contentWidth = inner - 2;

  // Colors. Cyan title, dim labels, green check marks. Kept subtle so the
  // box reads as chrome, not as content.
  const cCyan = `${ESC}[1;36m`; // bold cyan
  const cDim = opts.theme === "dark" ? `${ESC}[90m` : `${ESC}[2m`;
  const cGreen = `${ESC}[32m`;
  const cVal = opts.theme === "dark" ? `${ESC}[97m` : `${ESC}[30m`;

  const top = `┌${"─".repeat(inner)}┐`;
  const bottom = `└${"─".repeat(inner)}┘`;

  /** Build one bordered row from segments; `plain` is the visible text used
   *  for width math, `colored` is what actually gets written. */
  const row = (plain: string, colored: string): string => {
    const shown = truncate(plain, contentWidth);
    // If we truncated, we can't safely keep the colored version's tail, so
    // fall back to a plain (but still padded) render.
    const body =
      shown === plain ? colored : truncate(plain, contentWidth);
    const pad = " ".repeat(Math.max(0, contentWidth - shown.length));
    return `│ ${body}${pad} │`;
  };

  /** A blank interior line. */
  const blank = () => `│ ${" ".repeat(contentWidth)} │`;

  const check = `${cGreen}✓${RESET}`;

  const authLabel = authKind === "key" ? "public key" : "password";

  const lines: string[] = [];
  lines.push(top);
  lines.push(
    row(
      "DeployTools • SSH session",
      `${cCyan}DeployTools${RESET}${cDim} • SSH session${RESET}`,
    ),
  );
  lines.push(blank());

  const target = `${user}@${host}:${port}`;
  lines.push(
    row(
      `SSH session to ${target}`,
      `${cDim}SSH session to ${RESET}${cVal}${target}${RESET}`,
    ),
  );
  lines.push(
    row(`Auth: ${authLabel}`, `${cDim}Auth: ${RESET}${cVal}${authLabel}${RESET}`),
  );
  if (hasFingerprint) {
    lines.push(
      row("Host key: verified", `${cDim}Host key: ${RESET}${check} verified`),
    );
  }
  lines.push(blank());
  lines.push(row("Direct SSH  ✓", `${cDim}Direct SSH  ${RESET}${check}`));
  lines.push(row("SFTP browser  ✓", `${cDim}SFTP browser  ${RESET}${check}`));
  lines.push(bottom);

  // The row/border builders already emit fixed-width lines, so just
  // CR-terminate each. The trailing blank line separates the box from the
  // server's own MOTD / "Last login:".
  return lines.join("\r\n") + "\r\n\r\n";
}

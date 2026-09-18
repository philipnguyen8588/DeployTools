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

/** Optional live system-info block (from the `term_sysinfo` probe). Every
 *  field is optional — only the ones present are rendered. */
export interface BannerSysInfo {
  welcome?: string | null;
  date?: string | null;
  load?: string | null;
  processes?: string | null;
  users?: string | null;
  disk?: string | null;
  memory?: string | null;
  swap?: string | null;
  ipv4?: string | null;
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
  /** Server system-info to append inside the box (optional). */
  sysinfo?: BannerSysInfo | null;
}

/** One piece of a row: `t` is the visible text (used for width math), `c`
 *  is the optional SGR color applied around it. Keeping text + color
 *  together means the padding can never drift from what actually renders
 *  (the old plain/colored split silently miscounted the ✓ glyphs). */
interface Seg {
  t: string;
  c?: string;
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

  // Dashed box: ┄ (triple-dash horizontal) + ┆ (triple-dash vertical).
  const top = `┌${"┄".repeat(inner)}┐`;
  const bottom = `└${"┄".repeat(inner)}┘`;

  /** Build one bordered row from colored segments. Width is measured from
   *  the segment texts only (never the SGR codes), and the whole visible
   *  string is truncated with an ellipsis if it would exceed the box. */
  const row = (...segs: Seg[]): string => {
    let visible = segs.map((s) => s.t).join("");
    let colored = segs
      .map((s) => (s.c ? `${s.c}${s.t}${RESET}` : s.t))
      .join("");
    if (visible.length > contentWidth) {
      // Over-long: fall back to a plain, truncated render so alignment is
      // guaranteed even if a value (e.g. a long hostname) is huge.
      visible = truncate(visible, contentWidth);
      colored = visible;
    }
    const pad = " ".repeat(Math.max(0, contentWidth - visible.length));
    return `┆ ${colored}${pad} ┆`;
  };

  /** A blank interior line. */
  const blank = () => `┆ ${" ".repeat(contentWidth)} ┆`;

  const authLabel = authKind === "key" ? "public key" : "password";
  const target = `${user}@${host}:${port}`;

  const lines: string[] = [top];
  lines.push(
    row({ t: "DeployTools", c: cCyan }, { t: " • SSH session", c: cDim }),
  );
  lines.push(blank());
  lines.push(row({ t: "SSH session to ", c: cDim }, { t: target, c: cVal }));
  lines.push(row({ t: "Auth: ", c: cDim }, { t: authLabel, c: cVal }));
  if (hasFingerprint) {
    lines.push(
      row(
        { t: "Host key: ", c: cDim },
        { t: "✓", c: cGreen },
        { t: " verified" },
      ),
    );
  }
  lines.push(blank());
  lines.push(row({ t: "Direct SSH  ", c: cDim }, { t: "✓", c: cGreen }));
  lines.push(row({ t: "SFTP browser  ", c: cDim }, { t: "✓", c: cGreen }));

  // Live system information (Ubuntu-MOTD-style), when probed.
  const si = opts.sysinfo;
  if (si && (si.welcome || si.load || si.memory || si.disk || si.ipv4)) {
    lines.push(blank());
    if (si.welcome) lines.push(row({ t: si.welcome, c: cVal }));
    if (si.date)
      lines.push(row({ t: `System information as of ${si.date}`, c: cDim }));
    // Aligned label/value rows — pad the label so the values line up.
    const kv = (label: string, value?: string | null) => {
      if (!value) return;
      const lbl = `${label}:`.padEnd(18);
      lines.push(row({ t: lbl, c: cDim }, { t: value, c: cVal }));
    };
    kv("System load", si.load);
    kv("Processes", si.processes);
    kv("Usage of /", si.disk);
    kv("Users logged in", si.users);
    kv("Memory usage", si.memory);
    kv("IPv4 address", si.ipv4);
    kv("Swap usage", si.swap);
  }

  lines.push(bottom);

  // The row/border builders already emit fixed-width lines, so just
  // CR-terminate each. The trailing blank line separates the box from the
  // server's own MOTD / "Last login:".
  return lines.join("\r\n") + "\r\n\r\n";
}

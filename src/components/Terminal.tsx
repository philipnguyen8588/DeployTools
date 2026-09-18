import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTheme } from "next-themes";

import * as api from "@/lib/api";
import { useSessions } from "@/stores/sessions";
import { useServers } from "@/stores/servers";
import { usePrefs } from "@/stores/prefs";
import { buildBanner, indexAfterLastClear } from "@/lib/banner";
import { AnsiHighlighter } from "@/lib/ansi-highlight";

interface Props {
  sessionId: string;
  /** Server id — used to key the terminal command history. When not
   *  supplied, history capture is skipped (no harm). */
  serverId?: string;
  /** True when this Terminal's tab is the currently selected one.
   *  The component auto-focuses xterm on every false→true transition
   *  so the user can start typing without clicking first. */
  isActive?: boolean;
  /** Parent bumps this counter to ask the terminal to re-grab keyboard
   *  focus (e.g. after a modal closes). Any change in value — up or
   *  down, as long as it differs — re-runs the focus effect. */
  focusTrigger?: number;
  /**
   * Optional command to feed into the shell immediately after the PTY
   * is ready. The string is sent verbatim (no shell quoting) followed
   * by a newline. Used to seed "tail logs" / "exec shell" tabs.
   */
  seed?: string;
  /**
   * Notify the parent when the backend PTY is ready (pass the terminal
   * id) and when it is torn down (pass null). Parent uses this to drive
   * the shared toolbar's Snippets button — the button needs the pty id
   * to call `term_write`.
   */
  onTerminalReady?: (terminalId: string | null) => void;
  /**
   * Called every time the server pushes output into this terminal. The
   * parent uses it to paint an "unread" dot on non-active terminal
   * tabs. Rate-limited by the caller if needed.
   */
  onServerOutput?: () => void;
}

/**
 * Exact palettes extracted from the user's Terminal.app profiles
 * (macos-term/Clear Light.terminal, Clear Dark.terminal — NSColor values
 * decoded from the plists). These are muted, low-glare colors, NOT
 * Apple's stock ANSI set, so keep them in sync with the profile files
 * if those ever change.
 */

/** "Clear Dark" profile. (Profile bg is #191D27 @ 95% opacity — we
 *  render opaque.) The profile defines no cursor color; gray matches
 *  Terminal.app's default look. */
const THEME_DARK = {
  background: "#191D27",
  foreground: "#E0E0E0",
  cursor: "#8C8C8C",
  selectionBackground: "#273D4C",
  black: "#35424C",
  red: "#B45648",
  green: "#6CAA71",
  yellow: "#C4AC62",
  blue: "#6D96B4",
  magenta: "#BD7BCD",
  cyan: "#7CCBCD",
  white: "#DEE5EB",
  brightBlack: "#465C6D",
  brightRed: "#DF6C5A",
  brightGreen: "#79BE7E",
  brightYellow: "#E5C872",
  brightBlue: "#67B5ED",
  brightMagenta: "#D389E5",
  brightCyan: "#84DDE0",
  brightWhite: "#E5EFF5",
};

/** "Clear Light" profile. */
const THEME_LIGHT = {
  background: "#FFFFFF",
  foreground: "#2D3840",
  cursor: "#919191",
  selectionBackground: "#DFE8EE",
  black: "#2D3840",
  red: "#B45648",
  green: "#6CAA71",
  yellow: "#C4AC62",
  blue: "#5685A8",
  magenta: "#AD64BE",
  cyan: "#69C6C9",
  white: "#C1C8CC",
  brightBlack: "#506573",
  brightRed: "#DF6C5A",
  brightGreen: "#79BE7E",
  brightYellow: "#E5C872",
  brightBlue: "#49A2E1",
  brightMagenta: "#D389E5",
  brightCyan: "#77E1E5",
  brightWhite: "#D8E1E7",
};

export function Terminal({
  sessionId,
  serverId,
  isActive,
  focusTrigger,
  seed,
  onTerminalReady,
  onServerOutput,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const { resolvedTheme } = useTheme();

  // Live-subscribe the output-colorization toggle so the quick button in
  // the terminal toolbar takes effect immediately — the [sessionId] effect
  // below reads this ref inside the term:// listener rather than closing
  // over a stale value, and re-running the effect (which would remount the
  // PTY) is avoided.
  const highlightEnabled = usePrefs((s) => s.highlightEnabled);
  const highlightOnRef = useRef(highlightEnabled);
  useEffect(() => {
    highlightOnRef.current = highlightEnabled;
  }, [highlightEnabled]);

  // Keep the latest server-output callback in a ref so the listen
  // callback (set up once at mount) always calls the most recent
  // parent closure — important because the parent updates its
  // active-tab comparison every render and React won't re-fire our
  // [sessionId]-only effect.
  const onServerOutputRef = useRef(onServerOutput);
  useEffect(() => {
    onServerOutputRef.current = onServerOutput;
  }, [onServerOutput]);

  // Auto-focus xterm on every false→true transition of isActive, plus
  // resize once the container actually has a non-zero size so the
  // first keystrokes appear on a correctly sized grid. Wrapped in a
  // 0 ms rAF so focus lands after the layout has settled.
  useEffect(() => {
    if (!isActive) return;
    const t = window.setTimeout(() => {
      try {
        termRef.current?.focus();
      } catch {
        /* terminal not ready yet */
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [isActive, focusTrigger]);

  // Global: when this terminal is the active tab and the user presses
  // a plain key while nothing input-able has focus (e.g. after a modal
  // was closed via Esc), grab keyboard focus so they can type. We
  // avoid hijacking if the target is already in a form field.
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      // Never steal focus while an IME composition is in progress
      // (Vietnamese Telex, Chinese/Japanese/Korean, etc.). Re-focusing the
      // xterm textarea mid-composition aborts the composition, so the
      // composed character is lost and nothing reaches the shell. macOS
      // fires these keydowns with keyCode 229 / isComposing=true.
      if (e.isComposing || e.keyCode === 229) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      // Skip modifier-only and navigation shortcuts that shouldn't steal focus.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      termRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive]);

  // (Re)theme on theme change.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme =
        resolvedTheme === "dark" ? THEME_DARK : THEME_LIGHT;
    }
  }, [resolvedTheme]);

  useEffect(() => {
    if (!containerRef.current) return;
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;

    const term = new XTerm({
      // macOS Terminal.app look: SF Mono first (picked up automatically if
      // the user installs it — Apple's license forbids bundling), then
      // Menlo (mac), then Cascadia Mono (ships with Windows 11 and is the
      // closest system font to SF Mono), then Consolas.
      fontFamily:
        '"SF Mono", SFMono-Regular, Menlo, "Cascadia Mono", Consolas, ui-monospace, monospace',
      fontSize: 13,
      // Windows renders these faces thinner than macOS does — nudge the
      // weight up so text reads as solid, not gray (Cascadia Mono is a
      // variable font, so 450 is honored, not synthesized).
      fontWeight: 450,
      // SF Mono's roomy vertical rhythm — Terminal.app spacing.
      lineHeight: 1.2,
      // Terminal.app default: steady block cursor (blink is off).
      cursorStyle: "block",
      cursorBlink: false,
      // Terminal.app's "Use bright colors for bold text" is OFF: bold
      // text keeps its normal color and just gets the heavier weight.
      // (xterm's default true made the bold green prompt render in pale
      // bright-green — the washed-out look on light backgrounds.)
      drawBoldTextInBrightColors: false,
      // No minimumContrastRatio: the Clear Light/Dark palettes were
      // designed for their exact backgrounds — any forced ratio would
      // distort them away from the .terminal profiles.
      allowProposedApi: true,
      // 2k lines is ~200-400 KB per terminal (vs 500 KB-1 MB at 5k).
      // Users who need more can scroll back to their shell's own buffer
      // or tail the log directly.
      scrollback: 2000,
      // Disable xterm's built-in right-click selection so we can use
      // right-click for paste (Windows convention).
      rightClickSelectsWord: false,
      theme: resolvedTheme === "dark" ? THEME_DARK : THEME_LIGHT,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;

    // --- Copy on select, paste on right-click or Ctrl+Shift+V ---
    // Selecting text auto-copies to the clipboard (putty/xterm behavior).
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        void navigator.clipboard.writeText(sel).catch(() => {});
      }
    });
    // Right-click pastes clipboard contents as input bytes.
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard
        .readText()
        .then((txt) => {
          if (!txt) return;
          term.paste(txt);
        })
        .catch(() => {
          /* clipboard empty or not permitted */
        });
    };
    containerRef.current.addEventListener("contextmenu", onContext);

    // Ctrl+Shift+V → paste, Ctrl+Shift+C → copy selection. Standard
    // convention on GNOME Terminal / Konsole / VSCode integrated terminal.
    // We return false from the custom handler so xterm doesn't then treat
    // the key combo as literal input.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Let xterm's composition helper handle IME input untouched.
      if (e.isComposing || e.keyCode === 229) return true;
      if (!e.ctrlKey || !e.shiftKey) return true;
      const k = e.key.toLowerCase();
      if (k === "v") {
        e.preventDefault();
        void navigator.clipboard
          .readText()
          .then((txt) => {
            if (txt) term.paste(txt);
          })
          .catch(() => {});
        return false;
      }
      if (k === "c") {
        const sel = term.getSelection();
        if (sel) {
          e.preventDefault();
          void navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
      }
      return true;
    });

    // --- IME fix (Vietnamese Telex, CJK, …) ---
    // xterm reads composed text from its hidden helper textarea on a
    // deferred (setTimeout) tick and never clears the textarea. In
    // WKWebView (macOS) this wedges back-to-back compositions: typing two
    // letters with no separator (e.g. Telex "ab") loses the second one,
    // because xterm's deferred read/clear of the first composition races
    // with the start of the second.
    //
    // We take over the commit: on `compositionend` we synchronously clear
    // the helper textarea — which runs before xterm's deferred read, so
    // xterm extracts an empty string and does NOT also send the text (no
    // duplication) — and forward the committed text to the PTY ourselves.
    // xterm still handles compositionstart/update, so the inline preview
    // (underlined text while composing) keeps working. Capture phase so
    // we always clear before xterm's own listener runs.
    const helperTextarea = term.textarea;
    const handleCompositionEnd = (e: CompositionEvent) => {
      const text = e.data;
      if (helperTextarea) helperTextarea.value = "";
      if (text && terminalIdRef.current) {
        useSessions.getState().bumpActivity(sessionId);
        void api.termWrite(sessionId, terminalIdRef.current, text);
      }
    };
    helperTextarea?.addEventListener("compositionend", handleCompositionEnd, true);

    // Fit, then open the backend terminal with matching cols/rows.
    fit.fit();
    const { cols, rows } = term;

    // MobaXterm-style welcome banner — written BEFORE the async open() so it
    // renders above the server's own MOTD / "Last login:" line. Server info
    // is read imperatively from the servers store (same pattern as the
    // sessions store below) so it doesn't join the effect deps.
    // Safety net: if anything clears the screen right after connect (a
    // server that runs `clear` in its shell init, or the older backend
    // auto-cd that cleared), the banner we just drew would be wiped. Keep
    // the banner string around and re-insert it directly after any clear
    // sequence seen in the connect window.
    let bannerReinject: string | null = null;
    let bannerDeadline = 0;
    if (usePrefs.getState().bannerEnabled && serverId) {
      const sv = useServers
        .getState()
        .servers.find((s) => s.id === serverId);
      if (sv) {
        const banner = buildBanner({
          user: sv.user,
          host: sv.host,
          port: sv.port,
          authKind: sv.auth_kind === "key" ? "key" : "password",
          hasFingerprint: sv.has_fingerprint,
          cols: term.cols,
          theme: resolvedTheme === "dark" ? "dark" : "light",
        });
        term.write(banner);
        const hasProject = useSessions
          .getState()
          .tabs.find((t) => t.session.id === sessionId)?.session.project_id;
        if (hasProject) {
          bannerReinject = banner;
          // Watch only the connect window — a `clear` typed by the user
          // minutes later must NOT resurrect the banner.
          bannerDeadline = Date.now() + 15_000;
        }
      }
    }

    // One colorizer per terminal — carries escape/alt-screen state across
    // the server output chunks. Gated live via highlightOnRef.
    const highlighter = new AnsiHighlighter({
      ipv4: true,
      keywords: usePrefs.getState().highlightKeywords,
    });

    (async () => {
      try {
        const tid = await api.termOpen(sessionId, cols, rows);
        if (disposed) {
          await api.termClose(sessionId, tid).catch(() => {});
          return;
        }
        terminalIdRef.current = tid;
        onTerminalReady?.(tid);

        // Send the seeded command once the shell is ready. We wait a
        // short tick for the server to paint the first prompt so our
        // command doesn't land before the PS1 is drawn.
        if (seed) {
          const payload = seed.endsWith("\n") ? seed : `${seed}\n`;
          window.setTimeout(() => {
            if (!disposed && terminalIdRef.current) {
              void api.termWrite(sessionId, terminalIdRef.current, payload);
            }
          }, 250);
        }

        const bump = () => useSessions.getState().bumpActivity(sessionId);
        unlistenData = await listen<number[] | Uint8Array>(
          `term://${tid}`,
          (event) => {
            // Every chunk of server output counts as activity — keeps
            // long-running `tail -f` sessions from timing out.
            bump();
            onServerOutputRef.current?.();
            const data = event.payload as unknown;
            const u8 =
              data instanceof Uint8Array
                ? data
                : Array.isArray(data)
                  ? new Uint8Array(data)
                  : null;
            if (u8) {
              // Always run the transform so its escape / alt-screen state
              // stays accurate; the flag only gates whether it colorizes.
              highlighter.setEnabled(highlightOnRef.current);
              let out = highlighter.transform(u8);
              // Re-insert the banner right after the backend's auto-cd
              // `clear` so it survives on the cleaned screen. One-shot,
              // and only within the connect window.
              if (bannerReinject) {
                if (Date.now() > bannerDeadline) {
                  bannerReinject = null;
                } else {
                  const pos = indexAfterLastClear(out);
                  if (pos !== -1) {
                    out = out.slice(0, pos) + bannerReinject + out.slice(pos);
                    bannerReinject = null;
                  }
                }
              }
              term.write(out);
            } else if (typeof data === "string") {
              term.write(data);
            }
          },
        );
        unlistenExit = await listen<number>(`term-exit://${tid}`, () => {
          term.writeln("\r\n\x1b[90m[session closed]\x1b[0m");
          onTerminalReady?.(null);
        });

        // Terminal-history capture. We commit a line to `history_add` when
        // the user presses Enter. Two sources, in priority order:
        //   1. The RENDERED line read straight from the xterm buffer — this
        //      captures whatever is actually on screen, including commands
        //      recalled with ↑/↓ or completed with Tab (the shell echoes
        //      those, so they're in the buffer even though we never typed
        //      the characters ourselves).
        //   2. A keystroke buffer as a fallback for the case where the
        //      chars were typed + Entered in the same input chunk (the
        //      shell hasn't echoed them into the buffer yet).
        // For (1) we track `lineStartCol` = the cursor column right after
        // the prompt, so we can strip the prompt from the rendered line.
        let historyBuf = "";
        let lineStartCol: number | null = null;
        // "none" = normal, "esc" = saw ESC, "csi" = inside a CSI/SS3 seq.
        let escState: "none" | "esc" | "csi" = "none";

        // Reconstruct the full logical input line at the cursor, joining
        // any wrapped continuation rows.
        const readLogicalLine = (): string => {
          const buf = term.buffer.active;
          let start = buf.baseY + buf.cursorY;
          while (start > 0 && buf.getLine(start)?.isWrapped) start--;
          let out = "";
          for (let row = start; ; row++) {
            const l = buf.getLine(row);
            if (!l) break;
            out += l.translateToString(false);
            const next = buf.getLine(row + 1);
            if (next && next.isWrapped) continue;
            break;
          }
          return out.replace(/\s+$/, "");
        };

        const commitHistory = () => {
          // Prefer the on-screen line (catches ↑/↓ recall + Tab-complete).
          let line = "";
          if (lineStartCol != null) {
            const full = readLogicalLine();
            if (lineStartCol <= full.length) line = full.slice(lineStartCol);
          }
          if (!line.trim()) line = historyBuf; // fallback: what we typed
          line = line.trim();
          historyBuf = "";
          lineStartCol = null;
          if (!serverId) return;
          if (!line || /[\x00-\x08\x0b-\x1a\x1c-\x1f]/.test(line)) return;
          void api.historyAdd(serverId, line).catch(() => {});
        };

        term.onData((data) => {
          if (terminalIdRef.current) {
            bump();
            // First interaction on a fresh line: remember where input
            // begins (= prompt width) so we can strip the prompt later.
            if (lineStartCol == null) {
              lineStartCol = term.buffer.active.cursorX;
            }
            // Update the local history buffer before forwarding to the PTY.
            for (const ch of data) {
              // --- ANSI escape-sequence swallowing ---
              if (escState === "esc") {
                // ESC [ → CSI, ESC O → SS3 (both take a final byte); any
                // other char is a short 2-byte escape we just drop.
                escState = ch === "[" || ch === "O" ? "csi" : "none";
                continue;
              }
              if (escState === "csi") {
                // Skip parameter/intermediate bytes; a final byte in
                // 0x40–0x7E (@ … ~) ends the sequence.
                if (ch >= "\x40" && ch <= "\x7e") escState = "none";
                continue;
              }
              if (ch === "\x1b") {
                escState = "esc";
                continue;
              }
              // --- normal editing ---
              if (ch === "\r" || ch === "\n") {
                commitHistory();
              } else if (ch === "\x7f" || ch === "\b") {
                historyBuf = historyBuf.slice(0, -1);
              } else if (ch === "\x03") {
                // Ctrl+C aborts the current line — drop buffers.
                historyBuf = "";
                lineStartCol = null;
              } else if (ch >= " " || ch === "\t") {
                historyBuf += ch;
              }
            }
            void api.termWrite(sessionId, terminalIdRef.current, data);
          }
        });
        term.onResize(({ cols, rows }) => {
          if (terminalIdRef.current) {
            void api.termResize(sessionId, terminalIdRef.current, cols, rows);
          }
        });
      } catch (e) {
        term.writeln(`\r\n\x1b[31m[failed to open terminal: ${e}]\x1b[0m`);
      }
    })();

    // Refit on container resize, but skip when the container is hidden
    // (display:none via inactive tab). Fitting to a 0×0 rect rewrites
    // xterm's internal buffer dimensions to 0, which truncates the
    // scrollback — switching back to the tab would then render the
    // truncated (empty) buffer. Guarding on offsetParent === null and
    // width > 0 preserves the full history across tab switches.
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      if (containerRef.current.offsetParent === null) return;
      const r = containerRef.current.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      try {
        fit.fit();
      } catch {
        /* terminal may be disposing */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      helperTextarea?.removeEventListener(
        "compositionend",
        handleCompositionEnd,
        true,
      );
      containerRef.current?.removeEventListener("contextmenu", onContext);
      if (terminalIdRef.current) {
        void api.termClose(sessionId, terminalIdRef.current).catch(() => {});
      }
      onTerminalReady?.(null);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-md border bg-[--xterm-bg]"
      style={{
        // @ts-expect-error CSS var
        "--xterm-bg":
          resolvedTheme === "dark" ? THEME_DARK.background : THEME_LIGHT.background,
      }}
    />
  );
}

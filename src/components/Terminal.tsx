import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTheme } from "next-themes";

import * as api from "@/lib/api";
import { useSessions } from "@/stores/sessions";

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
 * Dark palette that matches the app's theme. Background mirrors the
 * `--background` var (`#282B30`, soft gray) so terminal tabs blend
 * visually with the surrounding panel.
 */
const THEME_DARK = {
  background: "#282B30",
  foreground: "#E6E9EF",
  cursor: "#4C8CEF",
  selectionBackground: "#2D4A6E",
  black: "#3A3D44",
  red: "#FF6B6B",
  green: "#7EE787",
  yellow: "#F2CC60",
  blue: "#79C0FF",
  magenta: "#D2A8FF",
  cyan: "#A5D6FF",
  white: "#E6E9EF",
  brightBlack: "#6E7681",
  brightRed: "#FFA198",
  brightGreen: "#56D364",
  brightYellow: "#E3B341",
  brightBlue: "#79C0FF",
  brightMagenta: "#D2A8FF",
  brightCyan: "#A5D6FF",
  brightWhite: "#F0F6FC",
};

/** GitHub light palette. */
const THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "#b6e3ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#4d2d00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
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
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
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
            if (data instanceof Uint8Array) {
              term.write(data);
            } else if (Array.isArray(data)) {
              term.write(new Uint8Array(data));
            } else if (typeof data === "string") {
              term.write(data);
            }
          },
        );
        unlistenExit = await listen<number>(`term-exit://${tid}`, () => {
          term.writeln("\r\n\x1b[90m[session closed]\x1b[0m");
          onTerminalReady?.(null);
        });

        // Local line buffer used to capture history: we accumulate every
        // char the user types and commit the line to `history_add` when
        // they press Enter. We swallow ANSI escape sequences (arrow keys,
        // Home/End, function keys, bracketed-paste markers, …) with a tiny
        // state machine so junk like "[A[A" (up-arrow) never lands in the
        // history. Readline line-editing (moving the cursor mid-line) still
        // isn't reconstructed — we just keep the entry legible.
        let historyBuf = "";
        // "none" = normal, "esc" = saw ESC, "csi" = inside a CSI/SS3 seq.
        let escState: "none" | "esc" | "csi" = "none";
        const commitHistory = () => {
          const line = historyBuf.trim();
          historyBuf = "";
          if (!serverId) return;
          if (!line || /[\x00-\x08\x0b-\x1a\x1c-\x1f]/.test(line)) return;
          void api.historyAdd(serverId, line).catch(() => {});
        };

        term.onData((data) => {
          if (terminalIdRef.current) {
            bump();
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
                // Ctrl+C aborts the current line — drop buffer.
                historyBuf = "";
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

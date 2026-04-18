import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTheme } from "next-themes";

import * as api from "@/lib/api";

interface Props {
  sessionId: string;
}

/** Dracula-ish palette for dark mode. */
const THEME_DARK = {
  background: "#0a0e14",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#7ee787",
  yellow: "#f2cc60",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#a5d6ff",
  white: "#e6edf3",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#a5d6ff",
  brightWhite: "#f0f6fc",
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

export function Terminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const { resolvedTheme } = useTheme();

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
      scrollback: 5000,
      theme: resolvedTheme === "dark" ? THEME_DARK : THEME_LIGHT,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;

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

        unlistenData = await listen<number[] | Uint8Array>(
          `term://${tid}`,
          (event) => {
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
        });

        term.onData((data) => {
          if (terminalIdRef.current) {
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

    // Refit on container resize.
    const ro = new ResizeObserver(() => {
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
      if (terminalIdRef.current) {
        void api.termClose(sessionId, terminalIdRef.current).catch(() => {});
      }
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

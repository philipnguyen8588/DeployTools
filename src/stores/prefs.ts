import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TerminalThemeEntry } from "@/lib/terminal-themes";

/**
 * Lightweight, frontend-only preferences persisted to localStorage.
 *
 * Unlike `AppSettings` (which lives in the vault dir and is read via the
 * Rust backend), these are pure UI toggles with no security implication,
 * so a localStorage-backed zustand store is the cheapest home — no IPC,
 * no restart. Currently scoped to terminal cosmetics (welcome banner +
 * output colorization).
 */
export const DEFAULT_HIGHLIGHT_KEYWORDS = [
  "error",
  "fail",
  "failed",
  "warning",
  "warn",
];

/**
 * How the terminal picks its colors.
 *  - "auto": follow the app light/dark theme (Clear Light / Clear Dark).
 *  - otherwise: the `name` of a TERMINAL_THEMES entry, used for both
 *    light and dark app modes.
 */
export type TerminalThemeChoice = string; // "auto" | <theme name>

interface PrefsState {
  /** Show the MobaXterm-style session banner when a terminal opens. */
  bannerEnabled: boolean;
  /** Colorize plain terminal output (IPv4 + keywords). */
  highlightEnabled: boolean;
  /** Keywords colored in output (case-insensitive, word-boundary). */
  highlightKeywords: string[];
  /** Selected terminal color theme, or "auto" to follow the app theme. */
  terminalTheme: TerminalThemeChoice;

  setBannerEnabled: (v: boolean) => void;
  setHighlightEnabled: (v: boolean) => void;
  toggleHighlight: () => void;
  setKeywords: (list: string[]) => void;
  setTerminalTheme: (name: TerminalThemeChoice) => void;
}

export type { TerminalThemeEntry };

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      bannerEnabled: true,
      highlightEnabled: true,
      highlightKeywords: DEFAULT_HIGHLIGHT_KEYWORDS,
      terminalTheme: "auto",

      setBannerEnabled: (v) => set({ bannerEnabled: v }),
      setHighlightEnabled: (v) => set({ highlightEnabled: v }),
      toggleHighlight: () =>
        set((s) => ({ highlightEnabled: !s.highlightEnabled })),
      setKeywords: (list) => set({ highlightKeywords: list }),
      setTerminalTheme: (name) => set({ terminalTheme: name }),
    }),
    { name: "deploytools-prefs" },
  ),
);

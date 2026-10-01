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
  /** Single source of truth for text size across the whole app (px). It
   *  drives the html root font-size — so every rem-based Tailwind class
   *  scales — and the integrated terminal's font, keeping them in sync. */
  uiFontSize: number;
  /** Terminal font family. null = bundled default (JetBrains Mono).
   *  Otherwise a family name derived from user-imported font files. */
  termFontFamily: string | null;
  /** Terminal body weight (bold text always renders at 700). */
  termFontWeight: number;
  /** Terminal font size in px. null = auto (80% of uiFontSize). */
  termFontSize: number | null;
  /** Terminal line height multiplier. */
  termLineHeight: number;

  setBannerEnabled: (v: boolean) => void;
  setHighlightEnabled: (v: boolean) => void;
  toggleHighlight: () => void;
  setKeywords: (list: string[]) => void;
  setTerminalTheme: (name: TerminalThemeChoice) => void;
  setUiFontSize: (px: number) => void;
  setTermFontFamily: (family: string | null) => void;
  setTermFontWeight: (w: number) => void;
  setTermFontSize: (px: number | null) => void;
  setTermLineHeight: (lh: number) => void;
}

/** Allowed app font-size range (px) and default. */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 15;

/** Terminal-specific font knobs. */
export const TERM_FONT_SIZE_MIN = 8;
export const TERM_FONT_SIZE_MAX = 24;
export const TERM_FONT_WEIGHT_DEFAULT = 300;
export const TERM_LINE_HEIGHT_MIN = 1.0;
export const TERM_LINE_HEIGHT_MAX = 1.8;
export const TERM_LINE_HEIGHT_DEFAULT = 1.2;

export type { TerminalThemeEntry };

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      bannerEnabled: true,
      highlightEnabled: true,
      highlightKeywords: DEFAULT_HIGHLIGHT_KEYWORDS,
      terminalTheme: "auto",
      uiFontSize: FONT_SIZE_DEFAULT,
      termFontFamily: null,
      termFontWeight: TERM_FONT_WEIGHT_DEFAULT,
      termFontSize: null,
      termLineHeight: TERM_LINE_HEIGHT_DEFAULT,

      setBannerEnabled: (v) => set({ bannerEnabled: v }),
      setHighlightEnabled: (v) => set({ highlightEnabled: v }),
      toggleHighlight: () =>
        set((s) => ({ highlightEnabled: !s.highlightEnabled })),
      setKeywords: (list) => set({ highlightKeywords: list }),
      setTerminalTheme: (name) => set({ terminalTheme: name }),
      setUiFontSize: (px) =>
        set({
          uiFontSize: Math.max(
            FONT_SIZE_MIN,
            Math.min(FONT_SIZE_MAX, Math.round(px)),
          ),
        }),
      setTermFontFamily: (family) => set({ termFontFamily: family }),
      setTermFontWeight: (w) => set({ termFontWeight: w }),
      setTermFontSize: (px) =>
        set({
          termFontSize:
            px == null
              ? null
              : Math.max(
                  TERM_FONT_SIZE_MIN,
                  Math.min(TERM_FONT_SIZE_MAX, Math.round(px)),
                ),
        }),
      setTermLineHeight: (lh) =>
        set({
          termLineHeight: Math.max(
            TERM_LINE_HEIGHT_MIN,
            Math.min(TERM_LINE_HEIGHT_MAX, Math.round(lh * 20) / 20),
          ),
        }),
    }),
    { name: "deploytools-prefs" },
  ),
);

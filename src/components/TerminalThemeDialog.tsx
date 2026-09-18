import { useMemo, useState } from "react";
import { Palette, Search, Check } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/stores/prefs";
import {
  TERMINAL_THEMES,
  type TerminalThemeEntry,
} from "@/lib/terminal-themes";

interface Props {
  onClose: () => void;
}

/** The color swatches shown in each preview row — a representative slice
 *  of the ANSI palette. */
const SWATCH_KEYS: (keyof TerminalThemeEntry)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

/**
 * Theme picker for the integrated terminal. Lists the bundled
 * Terminal.app themes (macos-terminal-themes) plus an "Auto" option that
 * follows the app light/dark mode. Selecting a theme applies it live to
 * every open terminal (Terminal subscribes to `terminalTheme`).
 */
export function TerminalThemeDialog({ onClose }: Props) {
  const terminalTheme = usePrefs((s) => s.terminalTheme);
  const setTerminalTheme = usePrefs((s) => s.setTerminalTheme);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return TERMINAL_THEMES;
    return TERMINAL_THEMES.filter((t) => t.name.toLowerCase().includes(q));
  }, [filter]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5 text-primary" />
            Terminal theme
          </DialogTitle>
          <DialogDescription>
            {TERMINAL_THEMES.length} themes from macOS Terminal.app. Applies
            to every open terminal immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Search themes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 pl-7 text-sm"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {/* Auto row */}
          <ThemeRow
            name="Auto"
            subtitle="Follow app light / dark mode"
            selected={terminalTheme === "auto"}
            onClick={() => setTerminalTheme("auto")}
          />
          {filtered.map((t) => (
            <ThemeRow
              key={t.name}
              name={t.name}
              theme={t}
              selected={terminalTheme === t.name}
              onClick={() => setTerminalTheme(t.name)}
            />
          ))}
          {filtered.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No theme matches “{filter}”.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ThemeRow({
  name,
  subtitle,
  theme,
  selected,
  onClick,
}: {
  name: string;
  subtitle?: string;
  theme?: TerminalThemeEntry;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-0 hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      <span className="flex w-5 shrink-0 justify-center">
        {selected && <Check className="h-4 w-4 text-primary" />}
      </span>

      {/* Preview: mini terminal chip on the theme's own bg */}
      {theme ? (
        <span
          className="flex items-center gap-1 rounded px-2 py-1 font-mono text-xs"
          style={{ background: theme.background, color: theme.foreground }}
        >
          <span style={{ color: theme.green }}>~</span>
          <span>$</span>
          {SWATCH_KEYS.map((k) => (
            <span
              key={k}
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: theme[k] as string }}
            />
          ))}
        </span>
      ) : (
        <span className="flex h-[26px] w-[124px] items-center justify-center rounded bg-gradient-to-r from-white to-black text-[10px] font-medium text-muted-foreground">
          AUTO
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        {subtitle && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
    </button>
  );
}

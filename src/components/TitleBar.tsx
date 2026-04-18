import { useEffect, useState } from "react";
import { Minus, Square, X, Copy, Rocket } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /**
   * Optional right-side slot for per-page controls (e.g. the Lock button
   * that's only shown after the vault is unlocked).
   */
  rightSlot?: React.ReactNode;
}

/**
 * Custom frameless title bar. Replaces the OS window chrome after
 * setting `decorations: false` in `tauri.conf.json`.
 *
 * The drag region is the whole bar except buttons — buttons opt out
 * with `data-tauri-drag-region="false"`. We avoid the `-webkit-app-region`
 * CSS property (which Tauri docs used to recommend) in favor of the
 * native Tauri drag-region attribute, which plays nicer with WebView2.
 */
export function TitleBar({ rightSlot }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    void win.isMaximized().then((v) => alive && setMaximized(v));
    const unlisten = win.onResized(() => {
      void win.isMaximized().then((v) => alive && setMaximized(v));
    });
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 select-none items-center gap-2 border-b bg-card pl-3"
    >
      <Rocket
        data-tauri-drag-region
        className="h-4 w-4 shrink-0 text-primary"
      />
      <span
        data-tauri-drag-region
        className="text-sm font-semibold tracking-tight"
      >
        Auto Deployment
      </span>

      {/* Spacer that remains draggable. */}
      <div data-tauri-drag-region className="flex-1" />

      <div className="flex items-center gap-1">
        <ThemeToggle />
        {rightSlot}
      </div>

      {/* Window controls — Windows-style: Min | Max | Close */}
      <div className="ml-1 flex h-full items-stretch">
        <WindowButton
          aria-label="Minimize"
          onClick={() => void win.minimize()}
        >
          <Minus className="h-3.5 w-3.5" />
        </WindowButton>
        <WindowButton
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? (
            <Copy className="h-3 w-3" />
          ) : (
            <Square className="h-3 w-3" />
          )}
        </WindowButton>
        <WindowButton
          aria-label="Close"
          danger
          onClick={() => void win.close()}
        >
          <X className="h-3.5 w-3.5" />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({
  children,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      className={cn(
        "flex h-full w-11 items-center justify-center text-muted-foreground transition-colors",
        danger
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Re-export so callers can wire the Lock-vault button in the App shell
 * without importing the primitive directly.
 */
export { Button as TitleBarButton };

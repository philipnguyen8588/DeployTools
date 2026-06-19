import { useEffect, useState } from "react";
import { Minus, Plus, Square, X, Copy, Rocket } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

/**
 * True when running on macOS. We keep our own (non-native) window
 * controls on every platform, but on macOS we render them as the
 * familiar traffic-light dots on the LEFT, while Windows/Linux keep the
 * icon buttons on the right. Detected from the WebView user agent — no
 * extra Tauri plugin required.
 */
const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

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
      className="flex h-10 shrink-0 select-none items-center gap-2 border-b bg-card pl-3 pr-1"
    >
      {/* macOS: traffic-light controls on the left. */}
      {IS_MAC && <MacControls maximized={maximized} win={win} />}

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

      {/* Windows/Linux: icon controls on the right — Min | Max | Close. */}
      {!IS_MAC && (
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
      )}
    </header>
  );
}

/**
 * macOS-style traffic-light window controls: three colored dots on the
 * left in the order close / minimize / zoom. The glyph inside each dot
 * is revealed on hover (group-hover), matching native macOS behavior.
 */
function MacControls({
  maximized,
  win,
}: {
  maximized: boolean;
  win: ReturnType<typeof getCurrentWindow>;
}) {
  return (
    <div
      data-tauri-drag-region="false"
      className="group flex items-center gap-2 pr-1.5"
    >
      <MacDot
        aria-label="Close"
        className="bg-[#ff5f57]"
        onClick={() => void win.close()}
      >
        <X className="h-2 w-2" strokeWidth={3} />
      </MacDot>
      <MacDot
        aria-label="Minimize"
        className="bg-[#febc2e]"
        onClick={() => void win.minimize()}
      >
        <Minus className="h-2 w-2" strokeWidth={3} />
      </MacDot>
      <MacDot
        aria-label={maximized ? "Restore" : "Zoom"}
        className="bg-[#28c840]"
        onClick={() => void win.toggleMaximize()}
      >
        <Plus className="h-2 w-2" strokeWidth={3} />
      </MacDot>
    </div>
  );
}

function MacDot({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      data-tauri-drag-region="false"
      className={cn(
        "flex h-3 w-3 items-center justify-center rounded-full text-black/55 ring-1 ring-inset ring-black/10",
        className,
      )}
    >
      {/* Glyph only visible on hover of the whole cluster. */}
      <span className="opacity-0 transition-opacity group-hover:opacity-100">
        {children}
      </span>
    </button>
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
